"""DOCK-R26-FU-1: under an edition that requires MCP approval, a lazy server's held tool is refused for its own reason.

The docker lane (DOCK-R26-1) saw an unapproved or changed tool refused at first use as ``not_offered``, worded "no
longer offers the tool": the hub's admission knew each held tool's reason (``review.disabled``), but the listing
dropped it whenever any tool of the server was admitted. The real assembler builds the run through the real MCP
loader with the hub on (the only fake is the hub's listing, ``discover_listing_for``) and the admin's approval in
configuration, as ``test_wp79_withdrawn_tools.py`` does, with the server listed at first use.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from unittest.mock import patch

import pytest

from app.agents.mcp.models import MCPToolInfo
from app.harness.assembly.assembler import PipesHubRuntimeAssembler
from app.harness.mcp_hub.manifests import (
    approval_document,
    descriptor_of,
    manifest_path,
)
from harness_core.kernel.core.messages import ToolCall
from harness_core.kernel.durable import ToolContext
from harness_core.testing import ModelScript, Reply, ScriptedModel, Turn
from harness_core.testing.durable import ScriptedModelPort
from tests.support.mcp_tool_admission import mcp_approvals_required  # noqa: F401 - the fixture, used by name

from . import world as w

if TYPE_CHECKING:
    from collections.abc import Iterator

    from harness_core.driver.run_driver import AssembledRuntime

PRS = MCPToolInfo(
    name="list_prs", namespaced_name="mcp_github_list_prs", description="List pull requests.",
    input_schema={"type": "object", "properties": {"repo": {"type": "string"}}},
)
SEARCH = MCPToolInfo(
    name="search", namespaced_name="mcp_github_search", description="Search code.",
    input_schema={"type": "object", "properties": {"q": {"type": "string"}}},
)
MCP_PRS, MCP_SEARCH = f"mcp@{w.MCP}/list_prs", f"mcp@{w.MCP}/search"
CTX = ToolContext("run-1", w.ORG, "t1.0", "att-1", "k")
pytestmark = pytest.mark.usefixtures("mcp_approvals_required")


@pytest.fixture(autouse=True)
def _hub() -> Iterator[None]:
    async def listing(config: Any, credentials: Any, **_: Any) -> tuple[list[MCPToolInfo], dict[str, Any]]:  # noqa: ANN401
        return [PRS.model_copy(), SEARCH.model_copy()], {t.name: descriptor_of(t) for t in (PRS, SEARCH)}

    with w.deployment(), \
         patch("app.harness.assembly.assembler.mcp_hub_enabled", return_value=True), \
         patch("app.agents.agent_loop.mcp_tool_loader.hub_enabled", return_value=True), \
         patch("app.agents.agent_loop.mcp_tool_loader.discover_listing_for", listing):
        yield


async def _build(approved: tuple[MCPToolInfo, ...]) -> AssembledRuntime:
    server = {
        "instanceId": w.MCP, "name": "GitHubMCP", "displayName": "GitHub", "typeId": "github",
        "tools": [{"name": "list_prs", "fullName": "mcp_github_list_prs"}, {"name": "search", "fullName": "mcp_github_search"}],
    }
    services = w.Services(w.agent_doc(mcpServers=[server]))
    tools = tuple(descriptor_of(t) for t in approved)
    services.config.put(manifest_path(w.MCP), approval_document(w.MCP, tools, by="p_admin", at_ms=1, previous=None))
    port = ScriptedModelPort(ScriptedModel(ModelScript(id="t", turns=[Turn(reply=Reply(text="ok"))])))
    assembler = PipesHubRuntimeAssembler(services, model_factory=w.model_factory(port))  # type: ignore[arg-type]
    return await assembler.build(w.claim(w.pinned_spec(tool_ids=[MCP_PRS, MCP_SEARCH], mcp=[w.MCP])))


async def test_hr1_an_unapproved_tool_is_refused_at_first_use_as_not_approved() -> None:
    runtime = await _build((PRS,))
    refused = await runtime.tools.execute(ToolCall(id="c1", name="mcp_github_search", arguments={"q": "x"}), CTX)
    assert refused.status == "error"
    text = str(refused.content)
    assert "isn't approved" in text and "no longer offers" not in text, text


async def test_hr2_a_tool_changed_since_its_approval_is_refused_as_changed() -> None:
    changed = SEARCH.model_copy(update={"input_schema": {"type": "object", "properties": {"cql": {"type": "string"}}}})
    runtime = await _build((PRS, changed))
    refused = await runtime.tools.execute(ToolCall(id="c1", name="mcp_github_search", arguments={"q": "x"}), CTX)
    assert refused.status == "error"
    text = str(refused.content)
    assert "since an admin approved it" in text and "no longer offers" not in text, text


async def test_hr3_the_approved_tool_of_the_same_server_still_runs() -> None:
    runtime = await _build((PRS,))
    ran = await runtime.tools.execute(ToolCall(id="c1", name="mcp_github_list_prs", arguments={"repo": "a/b"}), CTX)
    assert "isn't approved" not in str(ran.content) and "no longer offers" not in str(ran.content), ran.content
