"""The one-time move of an install onto the MCP hub (D-MCP-1, D-MCP-4): what engines got before stays theirs.

The hub follows ``AGENT_HARNESS_WORKER_ENABLED`` when ``MCP_HUB`` is unset, so an install that ran without approvals
meets the approval gate on upgrade. Two passes keep its tools working, both idempotent:

- **Baseline.** An instance that existed before the hub first came on by default (``createdAt`` at or before the
  recorded cutoff), has no approval document and no hub drift record, gets its current listing approved, as
  ``pipeshub:hub-baseline``, except the tools the description scanner flags (MX-04): those stay unapproved and show
  their warnings for an admin. It runs at the query service's start for every such instance whose creator's
  credential can list it, and again on an instance's first listing by anyone (``baseline_on_listing``) for one the
  start could not reach. An instance created after the cutoff, or any instance where an operator set ``MCP_HUB``
  explicitly (approvals were already the rule there), is never baselined: an admin approves it.
- **Restrip.** Taking invisible characters out of what a model reads (``export_description``, ``export_schema``)
  changes a tool's digest. An approved tool whose stored description and schema, exported the new way, are the
  same text less those characters gets its approved digest moved to the new one, so the change locks nothing out.

Each instance's outcome is in its approval history (``by`` the baseline actor, ``baseline``/``held`` or
``restripped``) and logged at warning (``mcp_hub.baseline_approved``, ``mcp_hub.approval_restripped``).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, cast

from app.agents.constants.mcp_server_constants import MCP_ROOT
from app.core.org_context import for_org, org_of, spawn_detached, system
from app.harness.mcp_hub.manifests import (
    approval_document,
    descriptor_of,
    drift_path,
    manifest_path,
    read_manifest,
)
from app.harness.mcp_hub.settings import hub_enabled, hub_on_by_default
from harness_core.logs import HarnessLog
from harness_core.mcp_hub.description_scan import finding_codes, scan_descriptor
from harness_core.mcp_hub.manifest import ToolDescriptor
from harness_core.mcp_hub.names import export_description, export_schema

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable, Mapping, Sequence

    from app.agents.mcp.models import MCPToolInfo
    from app.harness.mcp_hub.manifests import ManifestConfig
    from harness_core.engines.types import JsonValue

_LOG = HarnessLog.named("app.harness.mcp_hub")
BASELINE_ACTOR = "pipeshub:hub-baseline"
BASELINE_JOB = "mcp-baseline"
DISCOVERY_TIMEOUT_SECONDS = 15.0
_CONCURRENCY = 4

Listing = tuple["Sequence[MCPToolInfo]", "Mapping[str, ToolDescriptor]"]


def cutoff_path() -> str:
    return f"{MCP_ROOT}/hub-baseline/cutoff"


def marker_path(instance_id: str) -> str:
    return f"{MCP_ROOT}/hub-baseline/instances/{instance_id}"


async def read_cutoff(config: ManifestConfig) -> int | None:
    value = await config.get_config(cutoff_path(), default=None, use_cache=False, raise_on_error=True)
    at: object = cast("dict[str, Any]", value).get("at") if isinstance(value, dict) else None
    return at if isinstance(at, int) else None


async def record_cutoff(config: Any, *, at_ms: int) -> int:  # noqa: ANN401 - ConfigurationService
    """The moment the hub first came on by default; created once (atomically), every later start reads it back."""
    _ = await config.create_config_if_absent(cutoff_path(), {"at": at_ms})
    return await read_cutoff(config) or at_ms


def predates(instance: Mapping[str, Any], cutoff: int) -> bool:
    created = instance.get("createdAt")
    return not isinstance(created, int | float) or created <= cutoff


async def _eligible(config: ManifestConfig, instance: Mapping[str, Any], cutoff: int | None) -> bool:
    instance_id = str(instance.get("_id") or "")
    if not instance_id or cutoff is None or not predates(instance, cutoff):
        return False
    if await config.get_config(marker_path(instance_id), default=None, use_cache=False, raise_on_error=True) is not None:
        return False
    # A drift record means the hub already governed this instance; only an admin approves it.
    if await config.get_config(drift_path(instance_id), default=None, use_cache=False, raise_on_error=True) is not None:
        return False
    return await read_manifest(config, instance_id) is None


@dataclass(frozen=True)
class Baselined:
    instance_id: str
    approved: tuple[str, ...]
    held: dict[str, list[str]] = field(default_factory=dict[str, list[str]])


async def baseline_instance(
    config: ManifestConfig,
    instance: Mapping[str, Any],
    infos: Sequence[MCPToolInfo],
    raw: Mapping[str, ToolDescriptor],
    *,
    at_ms: int,
) -> Baselined:
    """Approve ``infos`` as the instance's baseline, holding back every tool the scanner flags in its own text."""
    instance_id = str(instance["_id"])
    held: dict[str, list[str]] = {}
    clean: list[ToolDescriptor] = []
    for info in infos:
        descriptor = descriptor_of(info)
        codes = finding_codes(scan_descriptor(raw.get(info.name, descriptor)))
        if codes:
            held[info.name] = codes
        else:
            clean.append(descriptor)
    document = approval_document(instance_id, clean, by=BASELINE_ACTOR, at_ms=at_ms, previous=None, warnings={})
    entry = cast("dict[str, Any]", document["history"][-1])
    entry["baseline"] = True
    entry["held"] = sorted(held)
    _ = await config.set_config(manifest_path(instance_id), document)
    _ = await config.set_config(
        marker_path(instance_id), {"at": at_ms, "approved": len(clean), "held": sorted(held)}
    )
    _LOG.warning(
        "mcp_hub.baseline_approved",
        orgId=org_of(instance) or "",
        mcpServer=instance_id,
        approved=len(clean),
        held=sorted(held),
        codes=sorted({c for codes in held.values() for c in codes}),
    )
    return Baselined(instance_id, tuple(sorted(t.name for t in clean)), held)


async def baseline_on_listing(
    config: ManifestConfig,
    instance: Mapping[str, Any],
    infos: Sequence[MCPToolInfo],
    raw: Mapping[str, ToolDescriptor],
    *,
    at_ms: int,
) -> bool:
    """On a listing of an instance with no approval: baseline it when it is one the start could not reach.
    Only reads the cutoff, never records one, so a new install's first listing approves nothing."""
    if not hub_on_by_default() or not infos:
        return False
    if not await _eligible(config, instance, await read_cutoff(config)):
        return False
    _ = await baseline_instance(config, instance, infos, raw, at_ms=at_ms)
    return True


def _exported(name: str, entry: Mapping[str, Any]) -> tuple[ToolDescriptor, ToolDescriptor] | None:
    """The stored approval of one tool as it was digested, and as the hub exports it now."""
    description = entry.get("description")
    schema = entry.get("inputSchema")
    annotations = entry.get("annotations")
    if not isinstance(schema, dict) or (description is not None and not isinstance(description, str)):
        return None
    hints = {k: v for k, v in cast("dict[str, Any]", annotations or {}).items() if isinstance(v, bool)}
    stored = ToolDescriptor(name, description, cast("dict[str, JsonValue]", schema), hints=hints)
    now = ToolDescriptor(
        name,
        export_description(description) if description is not None else None,
        cast("dict[str, JsonValue]", export_schema(cast("JsonValue", schema))),
        hints=hints,
    )
    return stored, now


def restripped(document: Mapping[str, Any], *, at_ms: int) -> tuple[dict[str, Any], list[str]]:
    """``document`` with each approved tool whose text held invisible characters moved to its new digest; the
    names moved. A tool whose stored text does not digest to its stored approval is left alone."""
    tools = dict(cast("dict[str, Any]", document.get("tools") or {}))
    moved: list[str] = []
    for name, entry in sorted(tools.items()):
        if not isinstance(entry, dict):
            continue
        approved = cast("dict[str, Any]", entry)
        pair = _exported(name, approved)
        if pair is None:
            continue
        stored, now = pair
        if stored.digest() != approved.get("digest") or now.digest() == stored.digest():
            continue
        tools[name] = {
            **approved,
            "digest": now.digest(),
            "description": now.description,
            "inputSchema": dict(now.input_schema),
        }
        moved.append(name)
    if not moved:
        return dict(document), []
    history = list(cast("list[Any]", document.get("history") or []))
    history.append({"at": at_ms, "by": BASELINE_ACTOR, "approved": [], "revoked": [], "restripped": moved})
    return {**document, "tools": tools, "history": history}, moved


async def restrip_instance(config: ManifestConfig, instance: Mapping[str, Any], *, at_ms: int) -> list[str]:
    instance_id = str(instance.get("_id") or "")
    document = await read_manifest(config, instance_id)
    if document is None:
        return []
    updated, moved = restripped(document, at_ms=at_ms)
    if moved:
        _ = await config.set_config(manifest_path(instance_id), updated)
        _LOG.warning(
            "mcp_hub.approval_restripped", orgId=org_of(instance) or "", mcpServer=instance_id, tools=moved
        )
    return moved


@dataclass
class BaselineReport:
    baselined: list[Baselined] = field(default_factory=list[Baselined])
    restripped: dict[str, list[str]] = field(default_factory=dict[str, list[str]])
    pending: list[str] = field(default_factory=list[str])


async def run_baseline(
    config: ManifestConfig,
    instances: Sequence[Mapping[str, Any]],
    discover: Callable[[Mapping[str, Any]], Awaitable[Listing | None]],
    *,
    at_ms: int,
) -> BaselineReport:
    """Both passes over ``instances``; an instance that fails or cannot be listed is left for its first listing."""
    report = BaselineReport()
    cutoff = await record_cutoff(config, at_ms=at_ms) if hub_on_by_default() else None
    gate = asyncio.Semaphore(_CONCURRENCY)

    async def one(instance: Mapping[str, Any]) -> None:
        instance_id = str(instance.get("_id") or "")
        async with gate:
            try:
                # The pass enumerates every org's instances: each one's reads and writes act for its own org.
                with for_org(org_of(instance), job=BASELINE_JOB):
                    await each(instance, instance_id)
            except Exception as exc:
                report.pending.append(instance_id)
                _LOG.warning(
                    "mcp_hub.baseline_pending",
                    orgId=org_of(instance) or "",
                    mcpServer=instance_id,
                    errorType=type(exc).__name__,
                )

    async def each(instance: Mapping[str, Any], instance_id: str) -> None:
        if moved := await restrip_instance(config, instance, at_ms=at_ms):
            report.restripped[instance_id] = moved
        if not await _eligible(config, instance, cutoff):
            return
        listing = await discover(instance)
        if listing is None or not listing[0]:
            report.pending.append(instance_id)
            return
        report.baselined.append(await baseline_instance(config, instance, *listing, at_ms=at_ms))

    _ = await asyncio.gather(*(one(i) for i in instances))
    return report


async def discover_as_creator(config: Any, instance: Mapping[str, Any]) -> Listing | None:  # noqa: ANN401
    """The instance's tools as its creator's credential lists them; None when that credential is missing."""
    from app.agents.mcp.service import (
        credentials_to_discovery_dict,
        instance_config_from_dict,
        is_effective_auth_authenticated,
        resolve_effective_user_auth,
    )
    from app.harness.mcp_hub.discovery import discover_listing_for
    from app.harness.mcp_hub.settings import harness_surface

    creator = str(instance.get("createdBy") or "")
    if not creator:
        return None
    effective = await resolve_effective_user_auth(dict(instance), creator, config)
    if not is_effective_auth_authenticated(effective):
        return None
    with harness_surface():
        infos, raw = await discover_listing_for(
            instance_config_from_dict(dict(instance)),
            credentials_to_discovery_dict(str(instance.get("authMode") or ""), effective or {}),
            tenant=org_of(instance) or "",
            owner=creator,
            timeout_seconds=DISCOVERY_TIMEOUT_SECONDS,
            refresh=True,
        )
    return infos, raw


async def every_instance(config: Any) -> list[dict[str, Any]]:  # noqa: ANN401
    """Every org-wide and personal MCP instance of every org on the store."""
    from app.agents.constants.mcp_server_constants import get_mcp_instances_prefix
    from app.agents.mcp.service import (
        _load_prefix,  # pyright: ignore[reportPrivateUsage]
    )

    org = await _load_prefix(config, get_mcp_instances_prefix())
    personal = await _load_prefix(config, f"{MCP_ROOT}/user-instances/")
    return [*org, *personal]


async def baseline_at_start(config: Any, *, at_ms: int) -> BaselineReport:  # noqa: ANN401
    """The query service's start: both passes over every instance on the store."""
    with system(BASELINE_JOB):
        report = await run_baseline(
            config, await every_instance(config), lambda i: discover_as_creator(config, i), at_ms=at_ms
        )
    _LOG.info(
        "mcp_hub.baseline_done",
        baselined=len(report.baselined),
        restripped=len(report.restripped),
        pending=len(report.pending),
    )
    return report


def start_baseline(
    config: Any,  # noqa: ANN401 - ConfigurationService
    holder: Any,  # noqa: ANN401 - the app's state
    *,
    at_ms: int,
    run: Callable[..., Awaitable[BaselineReport]] = baseline_at_start,
) -> asyncio.Task[None] | None:
    """The query service's start: the baseline in the background, once per process (kept on ``holder``), so a slow
    or unreachable server never delays the start; a failure is logged, never raised. None where harness runs do not
    use the hub."""
    if not hub_enabled(harness=True):
        return None
    existing = cast("asyncio.Task[None] | None", getattr(holder, "mcp_baseline_task", None))
    if existing is not None:
        return existing

    async def guarded() -> None:
        try:
            _ = await run(config, at_ms=at_ms)
        except Exception as exc:
            _LOG.warning("mcp_hub.baseline_failed", errorType=type(exc).__name__)

    task = spawn_detached(guarded())
    holder.mcp_baseline_task = task
    return task


__all__ = [
    "BASELINE_ACTOR",
    "BaselineReport",
    "Baselined",
    "baseline_at_start",
    "baseline_instance",
    "baseline_on_listing",
    "cutoff_path",
    "discover_as_creator",
    "every_instance",
    "marker_path",
    "predates",
    "read_cutoff",
    "record_cutoff",
    "restrip_instance",
    "restripped",
    "run_baseline",
    "start_baseline",
]
