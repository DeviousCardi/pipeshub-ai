"""OPS-04 (ADR-OPS-01 D4.3): the egress proxy enforces the operator egress stops it reads from Node.

A held stop (every org, or one org) refuses a binding serving a run it covers with ``egress_stopped`` and revokes the
live ones; a binding that names no run attempt is never covered. Clearing a stop binds new sandboxes again. The poller
reads Node's worker-only route every ``EGRESS_STOPS_POLL_S`` and keeps its last list while Node cannot be read; it
is the built-in ``EgressStopsFeed``.
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING

import httpx
import pytest
from aiohttp.test_utils import TestClient, TestServer

from app.edition_services import harness_edition
from app.harness.sandbox.egress_config import EgressStopsFeed
from app.harness.sandbox.egress_stops import (
    EGRESS_STOPS_PATH,
    EGRESS_STOPS_POLL_S,
    EgressStopsPoller,
    NodeEgressStops,
    NodeEgressStopsFeed,
    poll_until_stopped,
)
from harness_core.sandbox.auth import StaticBearerAuth
from harness_core.sandbox.egress import EgressBinding, InMemoryEgressBindings
from harness_core.sandbox.egress.bindings import (
    EGRESS_REVOKED,
    EGRESS_STOPPED,
    EVERY_RUN,
    Revocation,
)
from harness_core.sandbox.egress.client import RemoteEgressBindings
from harness_core.sandbox.egress.server import create_control_app
from harness_core.sandbox.egress.state import (
    DurableEgressBindings,
    InMemoryEgressStateStore,
    StateSealer,
)
from harness_core.sandbox.errors import SandboxRefusal
from harness_core.sandbox.types import EgressDestination, EgressPolicy, TokenRoute
from harness_core.testing.clock import ManualClock
from tests.unit.harness_core.sandbox.egress.test_wp14_revocation import (
    RefusingBindings,
    proxy_over,
    wiring_over,
)
from tests.support.settle import settle

if TYPE_CHECKING:
    from collections.abc import Mapping

CREDENTIAL = "ops04-worker-credential"
STATE_URL = "http://harness-state:3002"


def policy(placeholder: str) -> EgressPolicy:
    return EgressPolicy(
        destinations=(EgressDestination("model-gateway", (8097,)),),
        token_routes=(TokenRoute(placeholder, "model-gateway", "gateway:model"),),
    )


def run(org: str, run_id: str) -> dict[str, str]:
    return {"orgId": org, "sessionId": f"ses-{run_id}", "runId": run_id, "attemptId": f"{run_id}-a1"}


def binding(sandbox_id: str, n: int, labels: Mapping[str, str]) -> EgressBinding:
    return EgressBinding(sandbox_id, f"10.214.0.{4 * n + 2}", f"10.214.0.{4 * n + 3}", policy(f"ph-{sandbox_id}-0123456789ab"), labels)


A1 = binding("sbx-a1", 0, run("org-a", "r1"))
A2 = binding("sbx-a2", 1, run("org-a", "r2"))
B1 = binding("sbx-b1", 2, run("org-b", "r3"))
LEGACY = binding("sbx-legacy", 3, {"legacyExecutor": "run", "orgId": "org-a"})


async def refused_reason(bindings: InMemoryEgressBindings, item: EgressBinding) -> str:
    with pytest.raises(SandboxRefusal) as refused:
        await bindings.register(item)
    return refused.value.reason


class Credential:
    async def worker_credential(self) -> str:
        return CREDENTIAL


class FakeNode:
    """Node's egress-stops route: answers ``body`` with ``status``, or fails the connection when ``down``."""

    def __init__(self) -> None:
        self.body: object = {"revision": 0, "stops": []}
        self.status = 200
        self.down = False
        self.seen: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(request)
        if self.down:
            raise httpx.ConnectError("refused", request=request)
        return httpx.Response(self.status, content=json.dumps(self.body).encode())

    def source(self) -> NodeEgressStops:
        client = httpx.AsyncClient(base_url=STATE_URL, transport=httpx.MockTransport(self.handler))
        return NodeEgressStops(base_url=STATE_URL, credentials=Credential(), http_client=client)


class RecordingLog:
    def __init__(self) -> None:
        self.events: list[tuple[str, str, dict[str, object]]] = []

    def info(self, event: str, **fields: object) -> None:
        self.events.append(("info", event, fields))

    def warning(self, event: str, **fields: object) -> None:
        self.events.append(("warning", event, fields))

    def named(self, event: str) -> list[dict[str, object]]:
        return [fields for _, name, fields in self.events if name == event]


def poller(node: FakeNode, bindings: InMemoryEgressBindings) -> tuple[EgressStopsPoller, RecordingLog]:
    log = RecordingLog()
    return EgressStopsPoller(node.source(), bindings, log=log), log  # pyright: ignore[reportArgumentType]


async def test_ops_04_a_held_global_stop_refuses_a_run_binding_and_not_the_standard_chats() -> None:
    bindings = InMemoryEgressBindings()
    _ = await bindings.hold_stops(frozenset({EVERY_RUN}))
    for item in (A1, B1):
        assert await refused_reason(bindings, item) == EGRESS_STOPPED
    await bindings.register(LEGACY)
    assert await bindings.bound() == {"sbx-legacy"}


async def test_ops_04_an_org_stop_covers_only_that_org() -> None:
    bindings = InMemoryEgressBindings()
    _ = await bindings.hold_stops(frozenset({Revocation(org_id="org-a")}))
    assert await refused_reason(bindings, A1) == EGRESS_STOPPED
    await bindings.register(B1)
    assert await bindings.bound() == {"sbx-b1"}


async def test_ops_04_holding_a_list_revokes_every_live_binding_a_stop_covers() -> None:
    bindings = InMemoryEgressBindings()
    for item in (A1, A2, B1, LEGACY):
        await bindings.register(item)
    revoked = await bindings.hold_stops(frozenset({Revocation(org_id="org-a")}))
    assert revoked == ("sbx-a1", "sbx-a2")
    assert await bindings.bound() == {"sbx-b1", "sbx-legacy"}
    assert bindings.revoked() == {"sbx-a1", "sbx-a2"}


async def test_ops_04_clearing_a_stop_binds_new_sandboxes_and_revoked_ones_stay_revoked() -> None:
    bindings = InMemoryEgressBindings()
    await bindings.register(A1)
    _ = await bindings.hold_stops(frozenset({EVERY_RUN}))
    assert await bindings.hold_stops(frozenset()) == ()
    await bindings.register(A2)
    assert await bindings.bound() == {"sbx-a2"}
    assert await refused_reason(bindings, A1) == EGRESS_REVOKED


async def test_ops_04_a_durable_table_writes_the_revocation_so_a_restart_keeps_it() -> None:
    clock = ManualClock()
    store = InMemoryEgressStateStore(clock)
    first = DurableEgressBindings(store, StateSealer(b"ops04-key"), clock)
    _ = await first.load("egress-1")
    await first.register(A1)
    assert await first.hold_stops(frozenset({EVERY_RUN})) == ("sbx-a1",)
    restarted = DurableEgressBindings(store, StateSealer(b"ops04-key"), clock)
    _ = await restarted.load("egress-2")
    assert await refused_reason(restarted, A1) == EGRESS_REVOKED


async def test_ops_04_the_broker_resync_drops_a_stopped_sandbox_and_gives_the_rest_back() -> None:
    fake = RefusingBindings({"sbx-a1": EGRESS_STOPPED})
    wiring = wiring_over(fake)
    wiring._held.update({item.sandbox_id: item for item in (A1, A2, LEGACY)})
    assert await wiring.resync() is True
    assert fake.registered == ["sbx-a2", "sbx-legacy"]
    assert "sbx-a1" not in wiring._held


def test_ops_04_the_proxy_reads_the_stops_at_least_every_ten_seconds() -> None:
    assert EGRESS_STOPS_POLL_S <= 10
    assert EGRESS_STOPS_PATH == "/api/v1/agent-harness/internal/operator-controls/egress"


async def test_ops_04_the_poller_applies_nodes_answer_under_the_worker_credential() -> None:
    node, bindings = FakeNode(), InMemoryEgressBindings()
    await bindings.register(A1)
    await bindings.register(B1)
    node.body = {"revision": 3, "stops": [{"orgId": "org-a"}]}
    stops, log = poller(node, bindings)
    assert await stops.poll()
    assert bindings.stops() == {Revocation(org_id="org-a")}
    assert await bindings.bound() == {"sbx-b1"}
    request = node.seen[-1]
    assert (request.method, request.url.path) == ("GET", EGRESS_STOPS_PATH)
    assert request.headers["Authorization"] == f"Bearer {CREDENTIAL}"
    assert log.named("egress.stops_applied") == [{"revision": 3, "stops": 1, "globalStop": False, "revoked": 1}]
    # An unchanged answer applies again but says nothing.
    assert await stops.poll()
    assert len(log.named("egress.stops_applied")) == 1


async def test_ops_04_the_poller_keeps_its_last_list_when_node_fails_and_warns_once_per_outage() -> None:
    node, bindings = FakeNode(), InMemoryEgressBindings()
    node.body = {"revision": 1, "stops": [{"orgId": None}]}
    stops, log = poller(node, bindings)
    assert await stops.poll()
    node.down = True
    assert not await stops.poll()
    node.down, node.status = False, 503
    assert not await stops.poll()
    node.status, node.body = 200, {"revision": 2, "stops": [{"orgId": None, "sessionId": "ses-1"}]}
    assert not await stops.poll()
    assert bindings.stops() == {EVERY_RUN}
    assert await refused_reason(bindings, A1) == EGRESS_STOPPED
    assert log.named("egress.stops_unavailable") == [{"reason": "node_unreachable", "held": 1}]
    # Node is back with the stop cleared: the next tick lets new run sandboxes bind.
    node.body = {"revision": 4, "stops": []}
    assert await stops.poll()
    await bindings.register(A1)
    assert log.named("egress.stops_applied")[-1] == {"revision": 4, "stops": 0, "globalStop": False, "revoked": 0}


@pytest.mark.parametrize(
    "body",
    [
        [],
        {"revision": "1", "stops": []},
        {"revision": True, "stops": []},
        {"revision": 1},
        {"revision": 1, "stops": [{"orgId": ""}]},
        {"revision": 1, "stops": [{}]},
        {"revision": 1, "stops": ["org-a"]},
    ],
)
async def test_ops_04_a_malformed_answer_is_never_guessed(body: object) -> None:
    node, bindings = FakeNode(), InMemoryEgressBindings()
    node.body = {"revision": 1, "stops": [{"orgId": "org-a"}]}
    stops, log = poller(node, bindings)
    assert await stops.poll()
    node.body = body
    assert not await stops.poll()
    assert bindings.stops() == {Revocation(org_id="org-a")}
    assert log.named("egress.stops_unavailable") == [{"reason": "malformed", "held": 1}]


async def test_ops_04_the_kill_switch_still_holds_whatever_node_answers() -> None:
    node, bindings = FakeNode(), InMemoryEgressBindings(kill_switch=True)
    stops, _ = poller(node, bindings)
    assert await stops.poll()
    with pytest.raises(SandboxRefusal) as refused:
        await bindings.register(A1)
    assert refused.value.reason == "kill_switch"


async def test_ops_04_the_health_route_reports_how_many_stops_the_proxy_holds() -> None:
    bindings = InMemoryEgressBindings()
    _ = await bindings.hold_stops(frozenset({EVERY_RUN, Revocation(org_id="org-a")}))
    proxy = proxy_over(bindings, ManualClock(), "http://127.0.0.1:9")
    async with TestClient(TestServer(create_control_app(proxy, StaticBearerAuth(CREDENTIAL), instance="egress-ops04"))) as http:
        control = RemoteEgressBindings(str(http.make_url("")), StaticBearerAuth(CREDENTIAL))
        try:
            health = await control.health()
        finally:
            await control.aclose()
    assert (health.ok, health.egress_stops, health.kill_switch) == (True, 2, False)


def test_ops_04_the_built_in_feed_polls_node() -> None:
    feed = harness_edition().port(EgressStopsFeed, NodeEgressStopsFeed())
    assert isinstance(feed, NodeEgressStopsFeed)
    assert isinstance(feed, EgressStopsFeed)


async def test_ops_04_an_org_admins_egress_stop_reaches_the_proxy_and_cuts_its_sandboxes_off() -> None:
    """What Node serves for one org admin's egress stop (``egressStopsView``: one stop naming the org) revokes that
    org's live run sandboxes at the proxy and refuses new ones, leaving other orgs' alone; clearing it binds again."""
    node, bindings = FakeNode(), InMemoryEgressBindings()
    await bindings.register(A1)
    await bindings.register(B1)
    node.body = {"revision": 42_000, "stops": [{"orgId": "org-a"}]}
    stops, _ = poller(node, bindings)
    stopped = asyncio.Event()
    task = asyncio.create_task(poll_until_stopped(stops, stopped, every_s=0.01))
    for _ in range(200):
        if bindings.stops():
            break
        await asyncio.sleep(0.01)
    assert await bindings.bound() == {"sbx-b1"}
    assert await refused_reason(bindings, A2) == EGRESS_STOPPED
    node.body = {"revision": 43_000, "stops": []}
    for _ in range(200):
        if not bindings.stops():
            break
        await asyncio.sleep(0.01)
    stopped.set()
    await settle(task)
    await bindings.register(A2)
    assert "sbx-a2" in await bindings.bound()
