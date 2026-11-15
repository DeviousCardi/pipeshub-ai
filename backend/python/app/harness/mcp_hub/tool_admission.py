"""Whether a harness run may use an MCP server's tools only once an admin approved them (D-MCP-5).

OSS needs no such approval: a connected server's discovered tools are usable at once, and the description scanner
holds back only the tools it flags (MX-04). An edition extension may turn the gate on for an org through
``app.edition_config.mcp_tool_admission``; with it on, the hub's manifest approvals apply as D-MCP-1 has them.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from app.harness.mcp_hub.manifests import ManifestConfig


class McpToolAdmission(Protocol):
    async def requires_admin_approval(self, org_id: str, config_service: ManifestConfig) -> bool:
        """``config_service`` is the caller's own: where an edition keeps its setting, it reads it there, so the
        policy holds no configuration client of its own."""
        ...


class OpenMcpToolAdmission:
    """OSS: no admin pre-approval of MCP tools, for any org."""

    async def requires_admin_approval(self, org_id: str, config_service: ManifestConfig) -> bool:
        return False


OPEN_MCP_TOOL_ADMISSION = OpenMcpToolAdmission()


def mcp_tool_admission() -> McpToolAdmission:
    """The edition's policy, read at call time so an edition extension that sets it is honoured."""
    from app import edition_config

    policy = getattr(edition_config, "mcp_tool_admission", None)
    return policy if policy is not None else OPEN_MCP_TOOL_ADMISSION


async def requires_admin_approval(org_id: str, config_service: ManifestConfig) -> bool:
    return await mcp_tool_admission().requires_admin_approval(org_id, config_service)


__all__ = [
    "OPEN_MCP_TOOL_ADMISSION",
    "McpToolAdmission",
    "OpenMcpToolAdmission",
    "mcp_tool_admission",
    "requires_admin_approval",
]
