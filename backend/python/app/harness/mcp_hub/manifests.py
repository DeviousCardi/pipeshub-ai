"""Approved MCP tool manifests and the drift seen against them, stored through ``ConfigurationService``.

``/services/mcp/manifests/{instanceId}`` holds what an admin approved (each tool's
digest, description and schema, so a later change can be shown as a diff) and the
approval history; only the admin route writes it. ``/services/mcp/manifest-drift/{instanceId}``
holds the last drift a process saw; it is written only when the drift changes, so
every request that sees the same drift does not write, and it never races an approval.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Protocol, cast

from app.agents.constants.mcp_server_constants import MCP_ROOT
from harness_core.logs import HarnessLog
from harness_core.mcp_hub.annotations import declared_hints
from harness_core.mcp_hub.description_scan import finding_codes, scan_descriptor
from harness_core.mcp_hub.errors import ManifestUnavailable, ToolDescriptionFlagged
from harness_core.mcp_hub.manifest import (
    ApprovedManifest,
    DisabledTool,
    ManifestReview,
    ToolDescriptor,
    review_manifest,
)

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping, Sequence

    from app.agents.mcp.models import MCPToolInfo

_LOG = HarnessLog.named("app.harness.mcp_hub")
HISTORY_LIMIT = 50


class ManifestConfig(Protocol):
    """The part of ``ConfigurationService`` the manifests use."""

    async def get_config(
        self,
        key: str,
        default: Any = None,  # noqa: ANN401
        use_cache: bool = False,  # noqa: FBT001, FBT002
        *,
        raise_on_error: bool = False,
    ) -> Any: ...  # noqa: ANN401

    async def set_config(self, key: str, value: Any) -> bool: ...  # noqa: ANN401


def manifest_path(instance_id: str) -> str:
    return f"{MCP_ROOT}/manifests/{instance_id}"


def drift_path(instance_id: str) -> str:
    return f"{MCP_ROOT}/manifest-drift/{instance_id}"


def descriptor_of(info: MCPToolInfo) -> ToolDescriptor:
    """What reaches the model of a tool: its server-side name, its escaped description and its schema."""
    return ToolDescriptor(info.name, info.description, dict(info.input_schema), hints=declared_hints(info.annotations))


def approved_from(document: object) -> ApprovedManifest | None:
    if document is None:
        return None
    if not isinstance(document, dict):
        raise ManifestUnavailable("the approved manifest is not an object")
    doc = cast("dict[str, Any]", document)
    tools = doc.get("tools")
    if not isinstance(tools, dict):
        raise ManifestUnavailable("the approved manifest has no tools")
    digests: dict[str, str] = {}
    for name, entry in cast("dict[str, Any]", tools).items():
        digest = cast("dict[str, Any]", entry).get("digest") if isinstance(entry, dict) else None
        if not isinstance(digest, str):
            raise ManifestUnavailable(f"the approved manifest's tool {name!r} has no digest")
        digests[str(name)] = digest
    return ApprovedManifest(digests, approved_by=str(doc.get("approvedBy") or ""), approved_at=int(doc.get("approvedAt") or 0))


async def read_manifest(config_service: ManifestConfig, instance_id: str) -> dict[str, Any] | None:
    """The stored approval document; ``ManifestUnavailable`` when the store cannot answer (fail closed)."""
    try:
        document = await config_service.get_config(manifest_path(instance_id), default=None, use_cache=True, raise_on_error=True)
    except Exception as exc:
        raise ManifestUnavailable(f"the approved manifest could not be read: {type(exc).__name__}") from exc
    if document is not None and not isinstance(document, dict):
        raise ManifestUnavailable("the approved manifest is not an object")
    return cast("dict[str, Any] | None", document)


async def read_drift(config_service: ManifestConfig, instance_id: str) -> dict[str, Any] | None:
    # Absent and unreadable mean the same here: a drift record is advisory and is written again.
    document = await config_service.get_config(drift_path(instance_id), default=None, use_cache=False, raise_on_error=False)
    return cast("dict[str, Any]", document) if isinstance(document, dict) else None


def approval_document(
    instance_id: str,
    tools: Sequence[ToolDescriptor],
    *,
    by: str,
    at_ms: int,
    previous: Mapping[str, Any] | None,
    warnings: Mapping[str, list[str]] | None = None,
) -> dict[str, Any]:
    """``warnings``: the scanner's codes per approved tool, read from the server's own text; when not given, the
    approved descriptors are scanned (they hold no invisible characters, so ``invisible_text`` cannot show)."""
    before = set(cast("dict[str, Any]", (previous or {}).get("tools") or {}))
    after = {t.name for t in tools}
    if warnings is None:
        warnings = {t.name: codes for t in tools if (codes := finding_codes(scan_descriptor(t)))}
    warnings = {name: list(codes) for name, codes in warnings.items() if name in after and codes}
    history = list(cast("list[Any]", (previous or {}).get("history") or []))
    entry: dict[str, Any] = {"at": at_ms, "by": by, "approved": sorted(after), "revoked": sorted(before - after)}
    if warnings:
        # The admin approved these despite the description scanner's findings (MX-04).
        entry["acknowledged"] = sorted(warnings)
    history.append(entry)
    return {
        "instanceId": instance_id,
        "tools": {
            t.name: {
                "digest": t.digest(),
                "description": t.description,
                "inputSchema": dict(t.input_schema),
                **({"annotations": dict(t.hints)} if t.hints else {}),
                **({"warnings": warnings[t.name]} if t.name in warnings else {}),
            }
            for t in tools
        },
        "approvedBy": by,
        "approvedAt": at_ms,
        "history": history[-HISTORY_LIMIT:],
    }


def drift_document(instance_id: str, review: ManifestReview, *, at_ms: int) -> dict[str, Any]:
    return {
        "instanceId": instance_id,
        "digest": review.drift_digest(),
        "detectedAt": at_ms,
        "tools": [
            {"name": d.name, "reasonCode": d.reason_code, "digest": d.digest, "approvedDigest": d.approved_digest}
            for d in review.disabled
        ],
        "removed": list(review.removed),
    }


async def record_drift(
    config_service: ManifestConfig, *, tenant: str, instance_id: str, review: ManifestReview, at_ms: int
) -> bool:
    """Record a drift once (logged at warning when first recorded); whether it was written."""
    stored = await read_drift(config_service, instance_id)
    if stored is not None and stored.get("digest") == review.drift_digest():
        return False
    _ = await config_service.set_config(drift_path(instance_id), drift_document(instance_id, review, at_ms=at_ms))
    _LOG.warning(
        "mcp_hub.manifest_drift",
        orgId=tenant,
        mcpServer=instance_id,
        changed=[d.name for d in review.disabled if d.reason_code == "mcp_tool_changed"],
        unapproved=[d.name for d in review.disabled if d.reason_code == "mcp_tool_unapproved"],
        removed=list(review.removed),
    )
    return True


async def _baselined(
    config_service: ManifestConfig,
    instance: Mapping[str, Any],
    listed: Sequence[MCPToolInfo],
    raw: Mapping[str, ToolDescriptor] | None,
    at_ms: int,
) -> bool:
    from app.harness.mcp_hub.baseline import baseline_on_listing

    try:
        return await baseline_on_listing(config_service, instance, listed, raw or {}, at_ms=at_ms)
    except Exception as exc:
        # Nothing is approved on a failed baseline: the tools stay held, as an unapproved instance's are.
        _LOG.warning("mcp_hub.baseline_pending", mcpServer=str(instance.get("_id") or ""), errorType=type(exc).__name__)
        return False


async def admit_tools(
    config_service: ManifestConfig,
    infos: Iterable[MCPToolInfo],
    *,
    tenant: str,
    instance_id: str,
    at_ms: int,
    instance: Mapping[str, Any] | None = None,
    raw: Mapping[str, ToolDescriptor] | None = None,
) -> tuple[list[MCPToolInfo], ManifestReview]:
    """Only approved, unchanged tools; drift is recorded once. ``ManifestUnavailable`` when the approval is unreadable.
    With the ``instance`` record, an instance that predates the hub and was never approved is baselined from this
    listing first (``baseline_on_listing``; ``raw`` is each tool as its server wrote it, for the scanner). Where no
    admin approval is required (D-MCP-5, OSS), every listed tool the description scanner does not flag."""
    from app.harness.mcp_hub.tool_admission import requires_admin_approval

    listed = list(infos)
    if not await requires_admin_approval(tenant, config_service):
        return open_admission(listed, raw)
    try:
        document = await read_manifest(config_service, instance_id)
        if document is None and instance is not None and await _baselined(config_service, instance, listed, raw, at_ms):
            document = await read_manifest(config_service, instance_id)
        approved = approved_from(document)
    except ManifestUnavailable:
        _LOG.warning("mcp_hub.refused", orgId=tenant, mcpServer=instance_id, reasonCode=ManifestUnavailable.reason_code)
        raise
    review = review_manifest(approved, [descriptor_of(i) for i in listed])
    if review.drifted:
        try:
            _ = await record_drift(config_service, tenant=tenant, instance_id=instance_id, review=review, at_ms=at_ms)
        except Exception as exc:
            _LOG.warning("mcp_hub.drift_record_failed", orgId=tenant, mcpServer=instance_id, errorType=type(exc).__name__)
    admitted = {t.name for t in review.admitted}
    return [i for i in listed if i.name in admitted], review


def open_admission(
    listed: Sequence[MCPToolInfo], raw: Mapping[str, ToolDescriptor] | None = None
) -> tuple[list[MCPToolInfo], ManifestReview]:
    """D-MCP-5: the listed tools without an admin's approval, less those the description scanner flags (MX-04),
    read from the server's own text where there is one. Nothing stored is read, so no older manifest blocks a tool."""
    admitted: list[MCPToolInfo] = []
    held: list[DisabledTool] = []
    for info in listed:
        descriptor = descriptor_of(info)
        if finding_codes(scan_descriptor((raw or {}).get(info.name, descriptor))):
            held.append(DisabledTool(info.name, ToolDescriptionFlagged.reason_code, descriptor.digest()))
        else:
            admitted.append(info)
    review = ManifestReview(tuple(descriptor_of(i) for i in admitted), tuple(held), ())
    return admitted, review


APPROVED, UNKNOWN = "approved", "unknown"


async def approval_of(config_service: ManifestConfig, instance_id: str, infos: Sequence[MCPToolInfo]) -> list[dict[str, Any]]:
    """Each listed tool's standing against what an admin approved, in the listing's order: ``approved``, or
    ``unapproved`` / ``changed`` with its reason code (what the manifest route calls it). ``unknown`` when the
    approval cannot be read: a listing still answers, and nothing is shown as approved on a guess."""
    try:
        approved = approved_from(await read_manifest(config_service, instance_id))
    except ManifestUnavailable:
        return [{"status": UNKNOWN, "reasonCode": ManifestUnavailable.reason_code} for _ in infos]
    review = review_manifest(approved, [descriptor_of(i) for i in infos])
    disabled = {d.name: d.reason_code for d in review.disabled}
    return [
        {"status": disabled[i.name].removeprefix("mcp_tool_"), "reasonCode": disabled[i.name]}
        if i.name in disabled
        else {"status": APPROVED, "reasonCode": None}
        for i in infos
    ]


async def unapproved_of(config_service: ManifestConfig, instance_id: str, names: Iterable[str]) -> list[str]:
    """The names an admin has not approved for the instance (its stored approval; the server is not asked).
    ``ManifestUnavailable`` when the approval cannot be read."""
    approved = approved_from(await read_manifest(config_service, instance_id))
    known = approved.tools if approved is not None else {}
    return sorted({name for name in names if name not in known})


__all__ = [
    "ManifestConfig",
    "admit_tools",
    "approval_of",
    "approved_from",
    "approval_document",
    "descriptor_of",
    "drift_document",
    "drift_path",
    "manifest_path",
    "open_admission",
    "read_drift",
    "read_manifest",
    "record_drift",
    "unapproved_of",
]
