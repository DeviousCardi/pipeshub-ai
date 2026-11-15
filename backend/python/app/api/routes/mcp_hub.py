"""MCP hub admin routes (P2.8): approve an instance's tool manifest, and set a STDIO instance's runner fields.

- ``GET /instances/{id}/manifest``: what the server lists now (as the calling admin), each tool's status against
  the approved manifest, the approved descriptions and schemas (so a change reads as a diff), the last drift and
  the approval history. ``MCP_HUB`` off: 404.
- ``PUT /instances/{id}/manifest``: approve exactly the listed tools at the digests the admin saw; a digest that is
  no longer the live one is refused (409 ``mcp_manifest_stale``), never approved blind. A tool the description
  scanner flags (MX-04: ``warnings`` in the view) is approved only with ``acknowledgeWarnings``, else 409
  ``mcp_tool_description_flagged``. ``MCP_HUB`` off: 404.
- ``PUT /instances/{id}/runner``: ``egressHosts`` and ``runnerImage`` of a STDIO instance (P5.10 D-8), validated by
  the runner's own policy; the broker still enforces its image allowlist when the runner starts.
- ``PUT /instances/{id}/boundary``: ``insideOrganization``, the admin's word that the server runs inside the
  organization (SEC-B-02-FU-1): its tools' sink is ``self`` whatever their ``openWorldHint``. Any transport, hub on or
  off.

Mounted beside ``mcp_servers.router`` (same prefix, its admin gate and helpers).
"""

from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from app.agents.capability_sync import sync_capabilities
from app.agents.constants.mcp_server_constants import get_mcp_instance_path
from app.agents.mcp.boundary import INSIDE_ORGANIZATION_KEY
from app.agents.mcp.client import MCPConnectionError, typed_refusal
from app.agents.mcp.errors import MCPUrlBlockedError
from app.agents.mcp.models import MCPTransport
from app.api.middlewares.auth import require_scopes
from app.api.routes.mcp_servers import (
    check_user_is_admin,
    credentials_to_discovery_dict,
    get_config_service,
    get_user_context,
    instance_config_model_from_dict,
    require_mcp_enabled,
    require_org_instance,
    resolve_effective_user_auth,
)
from app.config.constants.http_status_code import HttpStatusCode
from app.config.constants.service import OAuthScopes
from app.core.org_context import current_org_id
from app.edition_config import forbid_inherited_mcp_mutation
from app.harness.mcp_hub.discovery import live_tools
from app.harness.mcp_hub.manifests import (
    approval_document,
    approved_from,
    descriptor_of,
    manifest_path,
    read_drift,
    read_manifest,
)
from app.harness.mcp_hub.settings import harness_surface, hub_enabled
from app.utils.time_conversion import get_epoch_timestamp_in_ms
from harness_core.logs import HarnessLog
from harness_core.mcp_hub.description_scan import finding_codes, scan_descriptor
from harness_core.mcp_hub.errors import (
    ManifestStale,
    ManifestUnavailable,
    ToolDescriptionFlagged,
)
from harness_core.mcp_hub.manifest import review_manifest
from harness_core.sandbox.mcp_runner.errors import MCPRunnerRefused, RunnerSpecInvalid
from harness_core.sandbox.mcp_runner.policy import (
    parse_egress_host,
    runner_egress_policy,
)
from harness_core.sandbox.mcp_runner.types import MCPRunnerSpec
from harness_core.supply_chain.diff import tool_changes

_LOG = HarnessLog.named("app.harness.mcp_hub")
DISCOVERY_TIMEOUT_SECONDS = 15.0
MAX_EGRESS_HOSTS = 32
# An image reference: [registry[:port]/]path[:tag][@sha256:digest], lower-case path components.
_IMAGE_REFERENCE = re.compile(
    r"(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?/)?"
    r"[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*"
    r"(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?"
)

router = APIRouter(
    prefix="/api/v1/mcp-servers",
    tags=["mcp-servers"],
    dependencies=[Depends(require_mcp_enabled)],
)


class ApprovedTool(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    name: str = Field(min_length=1, max_length=128)
    digest: str = Field(min_length=1, max_length=128)
    acknowledge_warnings: bool = Field(default=False, alias="acknowledgeWarnings")


class ManifestApproval(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tools: list[ApprovedTool] = Field(max_length=1000)


class RunnerSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    egress_hosts: list[str] = Field(default_factory=list, alias="egressHosts", max_length=MAX_EGRESS_HOSTS)
    runner_image: str | None = Field(default=None, alias="runnerImage", max_length=255)


class BoundarySettings(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    # Strict: "false" or 0 must never read as a choice about where a person's private content may go.
    inside_organization: bool = Field(alias="insideOrganization", strict=True)


def _refuse(status: HttpStatusCode, reason_code: str, message: str, **extra: Any) -> HTTPException:  # noqa: ANN401
    return HTTPException(status_code=status.value, detail={"reasonCode": reason_code, "message": message, **extra})


async def _admin_instance(request: Request, instance_id: str, *, action: str) -> tuple[Any, dict[str, Any], dict[str, Any]]:
    config_service = get_config_service(request)
    user = get_user_context(request)
    if not await check_user_is_admin(user["user_id"], request, config_service):
        raise HTTPException(status_code=HttpStatusCode.FORBIDDEN.value, detail=f"Only administrators can {action}.")
    instance = await require_org_instance(instance_id, config_service, user)
    return config_service, user, instance


def _require_hub() -> None:
    if not hub_enabled(harness=True):
        raise HTTPException(status_code=HttpStatusCode.NOT_FOUND.value, detail="The MCP hub is off (MCP_HUB).")


async def _live(
    config_service: Any,  # noqa: ANN401
    user: dict[str, Any],
    instance: dict[str, Any],
) -> tuple[list[Any], dict[str, str], dict[str, Any]]:
    effective = await resolve_effective_user_auth(instance, user["user_id"], config_service)
    if effective is None:
        raise HTTPException(status_code=HttpStatusCode.CONFLICT.value, detail="Not authenticated for this MCP server instance.")
    try:
        # The manifest is what harness runs are held to: list it under the harness's rules (URL guard included).
        with harness_surface():
            return await live_tools(
                instance_config_model_from_dict(instance),
                credentials_to_discovery_dict(instance.get("authMode", ""), effective),
                tenant=current_org_id(),
                owner=user["user_id"],
                timeout_seconds=DISCOVERY_TIMEOUT_SECONDS,
            )
    except Exception as exc:
        refused = typed_refusal(exc)
        if refused is not None:
            raise _refuse(HttpStatusCode.BAD_GATEWAY, refused.reason_code, str(refused)) from exc
        if isinstance(exc, MCPUrlBlockedError):
            # Main's URL guard refused the address: this route's documented code, so the manifest tab can say why.
            raise _refuse(HttpStatusCode.BAD_GATEWAY, "mcp_url_refused", str(exc)) from exc
        if isinstance(exc, MCPConnectionError):
            raise _refuse(HttpStatusCode.BAD_GATEWAY, "discovery_failed", str(exc)) from exc
        raise


async def _approved_document(config_service: Any, instance_id: str) -> dict[str, Any] | None:  # noqa: ANN401
    try:
        document = await read_manifest(config_service, instance_id)
        _ = approved_from(document)
    except ManifestUnavailable as exc:
        raise _refuse(HttpStatusCode.SERVICE_UNAVAILABLE, exc.reason_code, str(exc)) from exc
    return document


def _manifest_view(
    infos: list[Any],
    refused: dict[str, str],
    raw: dict[str, Any],
    document: dict[str, Any] | None,
    drift: dict[str, Any] | None,
) -> dict[str, Any]:
    descriptors = [descriptor_of(i) for i in infos]
    manifest = approved_from(document)
    review = review_manifest(manifest, descriptors)
    disabled = {d.name: d.reason_code for d in review.disabled}
    stored: dict[str, Any] = (document or {}).get("tools") or {}
    tools: list[dict[str, Any]] = []
    for info, descriptor in zip(infos, descriptors, strict=True):
        before = stored.get(info.name)
        tools.append(
            {
                "name": info.name,
                "exportedName": info.namespaced_name,
                "digest": descriptor.digest(),
                "status": "approved" if info.name not in disabled else disabled[info.name].removeprefix("mcp_tool_"),
                "reasonCode": disabled.get(info.name),
                "description": info.description,
                "inputSchema": info.input_schema,
                # The MCP behaviour hints decide the tool's effect and sink (FG2): the admin approves them too.
                "annotations": info.annotations,
                # MX-04: what the description scanner found; the admin acknowledges it to approve the tool.
                "warnings": [f.as_json() for f in scan_descriptor(raw.get(info.name, descriptor))],
                "approved": before,
                # AD-04, C11.05: what changed against the approved tool, one entry per thing the admin decides on.
                "changes": tool_changes(
                    before,
                    {
                        "description": descriptor.description,
                        "inputSchema": dict(descriptor.input_schema),
                        **({"annotations": dict(descriptor.hints)} if descriptor.hints else {}),
                    },
                )
                if before is not None and info.name in disabled
                else [],
            }
        )
    tools.extend(
        {"name": name, "status": "refused", "reasonCode": code, "approved": stored.get(name)}
        for name, code in sorted(refused.items())
    )
    approved = (
        {"approvedBy": manifest.approved_by, "approvedAt": manifest.approved_at, "digest": manifest.digest()}
        if manifest is not None
        else None
    )
    return {
        "tools": tools,
        "removed": list(review.removed),
        "approved": approved,
        "drift": drift,
        "history": (document or {}).get("history") or [],
    }


@router.get("/instances/{instance_id}/manifest", dependencies=[Depends(require_scopes(OAuthScopes.MCP_READ))])
async def get_manifest(request: Request, instance_id: str) -> dict[str, Any]:
    _require_hub()
    config_service, user, instance = await _admin_instance(request, instance_id, action="view an MCP tool manifest")
    infos, refused, raw = await _live(config_service, user, instance)
    document = await _approved_document(config_service, instance_id)
    return _manifest_view(infos, refused, raw, document, await read_drift(config_service, instance_id))


@router.put("/instances/{instance_id}/manifest", dependencies=[Depends(require_scopes(OAuthScopes.MCP_WRITE))])
async def approve_manifest(request: Request, instance_id: str, payload: ManifestApproval) -> dict[str, Any]:
    _require_hub()
    config_service, user, instance = await _admin_instance(request, instance_id, action="approve an MCP tool manifest")
    forbid_inherited_mcp_mutation(instance)
    infos, refused, raw = await _live(config_service, user, instance)
    current = {i.name: descriptor_of(i) for i in infos}
    chosen = {t.name: t.digest for t in payload.tools}
    for name, digest in sorted(chosen.items()):
        live = current.get(name)
        if live is None or live.digest() != digest:
            _LOG.warning("mcp_hub.refused", orgId=current_org_id(), mcpServer=instance_id, reasonCode=ManifestStale.reason_code)
            raise _refuse(
                HttpStatusCode.CONFLICT,
                ManifestStale.reason_code,
                "the server no longer lists this tool as approved; reload the manifest and review it again",
                tool=name,
            )
    acknowledged = {t.name for t in payload.tools if t.acknowledge_warnings}
    flagged = {name: finding_codes(scan_descriptor(raw.get(name, current[name]))) for name in sorted(chosen)}
    unacknowledged = sorted(name for name, codes in flagged.items() if codes and name not in acknowledged)
    if unacknowledged:
        _LOG.warning(
            "mcp_hub.refused", orgId=current_org_id(), mcpServer=instance_id, reasonCode=ToolDescriptionFlagged.reason_code
        )
        raise _refuse(
            HttpStatusCode.CONFLICT,
            ToolDescriptionFlagged.reason_code,
            "these tools' descriptions read like instructions to the model; review the warnings and approve them "
            "again with acknowledgeWarnings",
            tools=unacknowledged,
        )
    previous = await _approved_document(config_service, instance_id)
    document = approval_document(
        instance_id,
        [current[name] for name in sorted(chosen)],
        by=user["user_id"],
        at_ms=get_epoch_timestamp_in_ms(),
        previous=previous,
        warnings={name: codes for name, codes in flagged.items() if codes},
    )
    if not await config_service.set_config(manifest_path(instance_id), document):
        raise HTTPException(status_code=HttpStatusCode.INTERNAL_SERVER_ERROR.value, detail="Failed to store the approval.")
    entry = document["history"][-1]
    _LOG.info(
        "mcp_hub.manifest_approved",
        orgId=current_org_id(),
        mcpServer=instance_id,
        approved=len(entry["approved"]),
        revoked=len(entry["revoked"]),
    )
    if entry.get("acknowledged"):
        _LOG.warning(
            "mcp_hub.flagged_tools_approved",
            orgId=current_org_id(),
            mcpServer=instance_id,
            tools=entry["acknowledged"],
            codes=sorted({c for name in entry["acknowledged"] for c in flagged[name]}),
        )
    await sync_capabilities(config_service, current_org_id())
    return _manifest_view(infos, refused, raw, document, await read_drift(config_service, instance_id))


def _check_runner_settings(instance_id: str, payload: RunnerSettings) -> None:
    hosts = tuple(parse_egress_host(h) for h in payload.egress_hosts)
    image = payload.runner_image
    if image is not None and not _IMAGE_REFERENCE.fullmatch(image):
        raise RunnerSpecInvalid(f"runner image {image[:80]!r} is not an image reference")
    spec = MCPRunnerSpec(server_id=instance_id, image=image or "placeholder", command="placeholder", egress=hosts)
    _ = runner_egress_policy(spec)


@router.put("/instances/{instance_id}/runner", dependencies=[Depends(require_scopes(OAuthScopes.MCP_WRITE))])
async def set_runner_settings(request: Request, instance_id: str, payload: RunnerSettings) -> dict[str, Any]:
    config_service, user, instance = await _admin_instance(request, instance_id, action="configure an MCP runner")
    forbid_inherited_mcp_mutation(instance)
    if instance.get("transport") != MCPTransport.STDIO.value:
        raise _refuse(HttpStatusCode.BAD_REQUEST, "runner_spec_invalid", "only a STDIO instance runs in an MCP runner")
    try:
        _check_runner_settings(instance_id, payload)
    except MCPRunnerRefused as exc:
        raise _refuse(HttpStatusCode.BAD_REQUEST, exc.reason_code, str(exc)) from exc
    record = dict(instance)
    record["egressHosts"] = [h.strip() for h in payload.egress_hosts]
    record["runnerImage"] = payload.runner_image
    record["updatedAt"] = get_epoch_timestamp_in_ms()
    if not await config_service.set_config(get_mcp_instance_path(instance_id), record):
        raise HTTPException(status_code=HttpStatusCode.INTERNAL_SERVER_ERROR.value, detail="Failed to update the instance.")
    _LOG.info(
        "mcp_hub.runner_configured",
        orgId=current_org_id(),
        mcpServer=instance_id,
        egressHosts=len(record["egressHosts"]),
        runnerImage=bool(payload.runner_image),
    )
    return {"egressHosts": record["egressHosts"], "runnerImage": record["runnerImage"], "updatedAt": record["updatedAt"]}


@router.put("/instances/{instance_id}/boundary", dependencies=[Depends(require_scopes(OAuthScopes.MCP_WRITE))])
async def set_boundary(request: Request, instance_id: str, payload: BoundarySettings) -> dict[str, Any]:
    """SEC-B-02-FU-1 (ADR-OWD-09 D-MCP-OPENWORLD 4): the admin says the server runs inside the organization, so what
    its tools are sent stays inside it (sink ``self``, ``MCPToolAdapter.tags``) whatever its hints say; off, a tool is
    ``self`` only on its own ``openWorldHint: false``. Not gated on the hub: the flow guard reads it on every path."""
    config_service, user, instance = await _admin_instance(
        request, instance_id, action="say where an MCP server runs"
    )
    forbid_inherited_mcp_mutation(instance)
    record = dict(instance)
    record[INSIDE_ORGANIZATION_KEY] = payload.inside_organization
    record["insideOrganizationSetBy"] = user["user_id"]
    record["updatedAt"] = record["insideOrganizationSetAt"] = get_epoch_timestamp_in_ms()
    if not await config_service.set_config(get_mcp_instance_path(instance_id), record):
        raise HTTPException(status_code=HttpStatusCode.INTERNAL_SERVER_ERROR.value, detail="Failed to update the instance.")
    _LOG.warning(
        "mcp_hub.boundary_set",
        orgId=current_org_id(),
        mcpServer=instance_id,
        insideOrganization=payload.inside_organization,
        by=user["user_id"],
    )
    return {
        "insideOrganization": record[INSIDE_ORGANIZATION_KEY],
        "insideOrganizationSetBy": record["insideOrganizationSetBy"],
        "updatedAt": record["updatedAt"],
    }


__all__ = ["router"]
