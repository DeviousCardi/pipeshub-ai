"""D-MCP-5: the MCP hub's approval gate is an edition's setting; OSS requires no approval.

The tests of the gate itself (manifest approval, drift, re-approval, the agent-save refusal) run with this stand-in
for an edition that requires it: ``pytestmark = pytest.mark.usefixtures("mcp_approvals_required")`` after importing
the fixture. Tests of the open default whose configuration double cannot answer a store read use
``mcp_approvals_open``: the seam's own default, whichever policy the build binds.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from app import edition_config

if TYPE_CHECKING:
    from collections.abc import Iterator


class ApprovalsRequired:
    """An edition's org setting "Require admin approval of MCP tools", on for every org."""

    async def requires_admin_approval(self, org_id: str, config_service: object) -> bool:
        return True


@pytest.fixture
def mcp_approvals_required(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(edition_config, "mcp_tool_admission", ApprovalsRequired(), raising=False)
    yield


@pytest.fixture
def mcp_approvals_open(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(edition_config, "mcp_tool_admission", None, raising=False)
    yield
