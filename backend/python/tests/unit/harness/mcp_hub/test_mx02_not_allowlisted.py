"""MX-01/MX-02: only a server an admin approved reaches an engine, and only through the Tool Gateway.

A server nobody approved cannot be attached to an agent (a clear refusal naming its tools), is left out of the run's
tools, and a call that names its tool anyway, in any spelling, is refused at the gateway and never reaches the
server. The approved server next to it is listed and called through the same gateway.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest
from fastapi import HTTPException

from app.api.routes.agent import _refuse_unapproved_mcp_tools
from harness_core.effects import EffectRunner, RequestEffectLog
from harness_core.effects.policy import ALLOW_ALL, LayeredApprovalPolicy
from harness_core.gateway import GatewayClaims, RunToolEndpoint
from harness_core.gateway.memory import InMemoryCitationSink
from harness_core.gateway.types import RunAttemptBinding, grant_digest
from harness_core.invoker import InvocationScope
from harness_core.kernel.durable import classify_tool_effect
from harness_core.testing.clock import ManualClock
from harness_core.testing.ids import SeededIds
from harness_core.tools.durable_port import RegistryToolPort
from tests.support.mcp_tool_admission import mcp_approvals_required  # noqa: F401 - the fixture, used by name
from tests.unit.agents.adapter.conftest import make_context
from tests.unit.harness.credentials.support import DictConfig
from tests.unit.harness.gateway.support import GatewayServer, served
from tests.unit.harness.mcp_hub.support import (
    URL,
    FakeServer,
    approve_current,
    http_instance,
    hub_on,
    load,
    serve,
    teardown,
)

# D-MCP-5: these are the approval gate's own tests, run as an edition that requires it.
pytestmark = pytest.mark.usefixtures("mcp_approvals_required")

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from app.agents.agent_loop.context import AgentContext
    from harness_core.tools.registry import ToolRegistry

OTHER_URL = "http://93.184.216.36/mcp"
OTHER = http_instance(_id="mcp-other", name="Other", typeId="other", url=OTHER_URL)


@pytest.fixture
async def gateway() -> AsyncIterator[GatewayServer]:
    async with GatewayServer().running() as running:
        yield running


def _context(config: DictConfig) -> AgentContext:
    instances = (http_instance(), OTHER)
    return make_context(
        config_service=config,
        mcp_servers=[
            {"instanceId": i["_id"], "name": i["name"], "displayName": i["name"], "typeId": i["typeId"], "tools": None}
            for i in instances
        ],
        mcp_server_configs={
            i["_id"]: {"instance": i, "auth": {"credentials": {"apiToken": "tok"}}, "ownerId": "user-1"} for i in instances
        },
        run_id="run-1",
    )


def _endpoint(registry: ToolRegistry) -> tuple[RunToolEndpoint, GatewayClaims]:
    effects = {n: classify_tool_effect(n, registry.resolve_by_name(n).tags) for n in registry.names() if n.startswith("mcp_")}
    binding = RunAttemptBinding(
        tenant="org-1",
        scope="session-1",
        run_id="run-a",
        parent_run_id=None,
        attempt_id="run-a.a1",
        fence=1,
        tool_ids_digest=grant_digest(e.tool_id for e in effects.values()),
        routes_digest=grant_digest(()),
    )
    endpoint = RunToolEndpoint(
        binding=binding,
        catalog=RegistryToolPort(registry, effects),
        effects=EffectRunner(RequestEffectLog(), LayeredApprovalPolicy((ALLOW_ALL,), ("engine",))),
        scope=InvocationScope(binding.run_id, binding.tenant, binding.attempt_id),
        ids=SeededIds(),
        citations=InMemoryCitationSink(),
        hold_s=0.2,
    )
    return endpoint, GatewayClaims(binding, kid="mx02", expires_at=4_102_444_800)


async def test_mx02_a_server_nobody_approved_cannot_be_attached() -> None:
    config = DictConfig()
    server = FakeServer()
    await approve_current(config, server)
    attached: dict[str, dict[str, Any]] = {
        "mcp-fake": {"displayName": "Fake", "tools": [{"name": "search"}]},
        "mcp-other": {"displayName": "Other", "tools": [{"name": "search"}, {"name": "fetch"}]},
    }
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("MCP_HUB", "true")
        with pytest.raises(HTTPException) as refused:
            await _refuse_unapproved_mcp_tools({"config_service": config}, attached)
    detail = refused.value.detail
    assert refused.value.status_code == 400 and detail["reasonCode"] == "mcp_tool_unapproved"
    assert detail["tools"] == {"mcp-other": ["fetch", "search"]}
    assert "Other: fetch, search" in detail["message"] and "not approved by an admin" in detail["message"]


async def test_mx01_mx02_only_the_approved_server_reaches_the_engine_and_only_through_the_gateway(
    monkeypatch: pytest.MonkeyPatch, gateway: GatewayServer
) -> None:
    approved, other = FakeServer(), FakeServer()
    _ = serve(monkeypatch, {URL: approved, OTHER_URL: other})
    _ = hub_on(monkeypatch, ManualClock())
    config = DictConfig()
    await approve_current(config, approved)
    ctx = _context(config)
    registry = await load(ctx)
    assert {f["instanceId"]: f["reason"] for f in ctx.mcp_tool_load_failures} == {"mcp-other": "mcp_tool_unapproved"}
    endpoint, claims = _endpoint(registry)
    async with served(gateway, endpoint) as client:
        listed = {t.name for t in await client.list_tools(claims)}
        assert "mcp_fake_search" in listed and not any(n.startswith("mcp_other") for n in listed)
        for name in ("mcp_other_search", "mcp__other__search", "other.search", "search"):
            result = await client.call_tool(claims, name, {"q": "x"})
            assert (result.is_error, result.disposition, result.reason_code) == (True, "refused", "not_granted"), name
        called = await client.call_tool(claims, "mcp_fake_search", {"q": "x"})
    assert called.disposition == "executed" and called.text.startswith("found x")
    assert approved.calls == ["search"] and other.calls == []
    await teardown(ctx)
