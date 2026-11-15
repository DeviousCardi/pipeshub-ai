"""The operator egress stops the egress proxy holds, read from Node (ADR-OPS-01 D4.3).

``NodeEgressStopsFeed`` is the harness's built-in ``EgressStopsFeed``: it reads Node's worker-only list of egress
stops at once and then every ``EGRESS_STOPS_POLL_S``, holds it on the proxy's bindings, and keeps the last list while
Node cannot be read. The poll period is one term of the 60 s stop bound (``OPERATOR_STOP_BOUND_MS``) Node asserts.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from dataclasses import dataclass
from typing import TYPE_CHECKING, cast

from app.core.org_context import org_of
from app.harness.credential_roles import process_holder
from app.harness.journal_node.client import INTERNAL_PREFIX
from app.harness.journal_node.http import NodeServiceClient
from harness_core.logs import HarnessLog
from harness_core.sandbox.egress.bindings import Revocation

if TYPE_CHECKING:
    import httpx

    from app.config.configuration_service import ConfigurationService
    from app.harness.contracts.state import WorkerCredentialProvider
    from harness_core.sandbox.egress.bindings import InMemoryEgressBindings

EGRESS_STOPS_PATH = f"{INTERNAL_PREFIX}/operator-controls/egress"
EGRESS_STOPS_POLL_S = 10.0
_LOG = HarnessLog.named("app.egress_proxy.stops")


class EgressStopsUnavailable(Exception):
    """Node's egress stops could not be read; the proxy keeps the list it holds."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True, slots=True)
class EgressStops:
    revision: int
    stops: frozenset[Revocation]


class NodeEgressStops:
    """``GET {state url}/api/v1/agent-harness/internal/operator-controls/egress`` under the worker credential."""

    def __init__(
        self,
        *,
        base_url: str,
        credentials: WorkerCredentialProvider,
        http_client: httpx.AsyncClient | None = None,
        timeout_s: float = 5.0,
    ) -> None:
        self._credentials = credentials
        self._node = NodeServiceClient(
            base_url=base_url, timeout_s=timeout_s, http_client=http_client, service_name="node.egress_stops"
        )

    async def aclose(self) -> None:
        await self._node.aclose()

    async def load(self) -> EgressStops:
        try:
            bearer = await self._credentials.worker_credential()
        except Exception as exc:
            raise EgressStopsUnavailable("no_worker_credential") from exc
        response = await self._node.send(
            "GET",
            EGRESS_STOPS_PATH,
            bearer=bearer,
            unreachable=lambda _exc: EgressStopsUnavailable("node_unreachable"),
        )
        if response.status_code != 200:
            raise EgressStopsUnavailable(f"http_{response.status_code}")
        try:
            body: object = json.loads(response.content)
        except ValueError:
            raise EgressStopsUnavailable("malformed") from None
        return _egress_stops(body)


def _egress_stops(body: object) -> EgressStops:
    """Node's answer, or ``malformed``: a stop scoped by a field this proxy does not know is refused whole rather
    than read as a wider or a narrower stop."""
    if not isinstance(body, dict):
        raise EgressStopsUnavailable("malformed")
    fields = cast("dict[str, object]", body)
    revision, items = fields.get("revision"), fields.get("stops")
    if type(revision) is not int or not isinstance(items, list):
        raise EgressStopsUnavailable("malformed")
    stops: set[Revocation] = set()
    for item in cast("list[object]", items):
        if not isinstance(item, dict) or set(cast("dict[str, object]", item)) != {"orgId"}:
            raise EgressStopsUnavailable("malformed")
        # Its one field is a non-empty org id, or null for a stop of every org.
        if not all(v is None or isinstance(v, str) for v in cast("dict[str, object]", item).values()):
            raise EgressStopsUnavailable("malformed")
        org_id = org_of(cast("dict[str, object]", item))
        if org_id is not None and not org_id:
            raise EgressStopsUnavailable("malformed")
        stops.add(Revocation(org_id=org_id))
    return EgressStops(revision, frozenset(stops))


class EgressStopsPoller:
    """Reads Node's egress stops and holds them on the proxy's bindings; keeps the last list while Node is unreadable."""

    def __init__(self, source: NodeEgressStops, bindings: InMemoryEgressBindings, *, log: HarnessLog | None = None) -> None:
        self._source = source
        self._bindings = bindings
        self._log = log or _LOG
        self._revision: int | None = None
        self._unavailable = False

    async def poll(self) -> bool:
        """One read; whether Node answered."""
        try:
            answer = await self._source.load()
        except EgressStopsUnavailable as exc:
            if not self._unavailable:
                self._unavailable = True
                self._log.warning("egress.stops_unavailable", reason=exc.reason, held=len(self._bindings.stops()))
            return False
        recovered, self._unavailable = self._unavailable, False
        changed = answer.revision != self._revision or answer.stops != self._bindings.stops()
        revoked = await self._bindings.hold_stops(answer.stops)
        if changed or revoked or recovered:
            self._revision = answer.revision
            self._log.info(
                "egress.stops_applied",
                revision=answer.revision,
                stops=len(answer.stops),
                globalStop=any(stop.org_id is None for stop in answer.stops),
                revoked=len(revoked),
            )
        return True


async def poll_until_stopped(poller: EgressStopsPoller, stopped: asyncio.Event, *, every_s: float = EGRESS_STOPS_POLL_S) -> None:
    """Read at once, then every ``every_s``; a failed read keeps the held list."""
    while not stopped.is_set():
        try:
            _ = await poller.poll()
        except Exception as exc:
            # A failure applying the list (a state write) must not end the loop: the next tick applies it again.
            _LOG.warning("egress.stops_apply_failed", errorType=type(exc).__name__)
        with contextlib.suppress(TimeoutError):
            _ = await asyncio.wait_for(stopped.wait(), every_s)


class NodeEgressStopsFeed:
    """The harness's ``EgressStopsFeed``: Node's list, polled, held on the proxy's bindings until ``stopped``."""

    async def run(
        self, config_service: ConfigurationService, bindings: InMemoryEgressBindings, stopped: asyncio.Event
    ) -> None:
        # Imported here: ``app.harness.inline`` pulls in the run assembly, which the proxy loads only when it starts.
        from app.harness.inline import node_state_url

        source = NodeEgressStops(base_url=node_state_url(), credentials=process_holder(config_service))
        try:
            await poll_until_stopped(EgressStopsPoller(source, bindings), stopped)
        finally:
            await source.aclose()


__all__ = [
    "EGRESS_STOPS_PATH",
    "EGRESS_STOPS_POLL_S",
    "EgressStops",
    "EgressStopsPoller",
    "EgressStopsUnavailable",
    "NodeEgressStops",
    "NodeEgressStopsFeed",
    "poll_until_stopped",
]
