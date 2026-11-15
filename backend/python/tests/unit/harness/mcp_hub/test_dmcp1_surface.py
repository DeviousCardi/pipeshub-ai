"""D-MCP-1 as narrowed: with MCP_HUB unset the hub governs harness runs only.

SF-1 a classic agent chat behaves as on x4 (every listed tool registered with nothing approved, per-request
sessions, no hub state, no drift record); SF-2 a harness run of the same agent gets only approved tools; SF-3 an
operator's MCP_HUB decides for both; SF-4 the query service's start schedules the baseline once and never waits for it.
"""

from __future__ import annotations

import ast
import asyncio
import inspect
from typing import TYPE_CHECKING, Any

import pytest

from app.agents.mcp.discovery import build_namespaced_tool_name
from app.harness.mcp_hub.baseline import BaselineReport, start_baseline
from app.harness.mcp_hub.manifests import drift_path
from harness_core.testing.clock import ManualClock
from tests.support.mcp_tool_admission import mcp_approvals_required  # noqa: F401 - the fixture, used by name
from tests.unit.harness.credentials.support import DictConfig
from tests.unit.harness.mcp_hub.support import (
    INSTANCE_ID,
    URL,
    FakeServer,
    approve_current,
    context,
    hub_on,
    load,
    serve,
    teardown,
)

if TYPE_CHECKING:
    from app.harness.mcp_hub.hub import MCPHub

pytestmark = [pytest.mark.mcp_hub_default, pytest.mark.usefixtures("mcp_approvals_required")]

# x4's legacy names (the hub exports ``dotted.tool`` under its own escaped name).
ALL = {"mcp_fake_search", "mcp_fake_fetch", build_namespaced_tool_name("fake", "dotted.tool"), "mcp_fake_announce"}


@pytest.fixture
def server() -> FakeServer:
    return FakeServer()


@pytest.fixture
def hub(monkeypatch: pytest.MonkeyPatch, server: FakeServer) -> MCPHub:
    """MCP_HUB unset on an install with the harness switched on: production's default there."""
    _ = serve(monkeypatch, {URL: server})
    return hub_on(monkeypatch, ManualClock(), by_default=True)


def _names(registry: Any) -> set[str]:  # noqa: ANN401
    return {n for n in registry.names() if n.startswith("mcp_")}


async def test_sf1_a_classic_chat_with_mcp_hub_unset_behaves_as_on_x4(
    hub: MCPHub, server: FakeServer, config: DictConfig
) -> None:
    ctx = context(config)
    assert not ctx.harness_run
    registry = await load(ctx)
    assert _names(registry) == ALL, "nothing is approved, and every listed tool is registered as on x4"
    assert (await registry.resolve_by_name("mcp_fake_search").execute(q="x")).success
    assert hub.pool.sessions() == (), "no pooled session: the request's own, closed at teardown"
    assert ctx.mcp_tool_load_failures == []
    assert drift_path(INSTANCE_ID) not in config.values
    await teardown(ctx)
    assert server.calls == ["search"]


async def test_sf2_a_harness_run_of_the_same_agent_gets_only_approved_tools(
    hub: MCPHub, server: FakeServer, config: DictConfig
) -> None:
    del hub
    ctx = context(config)
    ctx.harness_run = True
    assert _names(await load(ctx)) == set()
    assert ctx.mcp_tool_load_failures[0]["reason"] == "mcp_tool_unapproved"
    await approve_current(config, server, names={"search"})
    again = context(config)
    again.harness_run = True
    assert _names(await load(again)) == {"mcp_fake_search"}
    await teardown(ctx, again)


@pytest.mark.parametrize(("flag", "classic_gated", "harness_gated"), [("true", True, True), ("false", False, False)])
async def test_sf3_an_operators_mcp_hub_decides_for_both(
    flag: str,
    classic_gated: bool,
    harness_gated: bool,
    hub: MCPHub,
    config: DictConfig,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del hub
    monkeypatch.setenv("MCP_HUB", flag)
    classic, harness = context(config), context(config)
    harness.harness_run = True
    assert (_names(await load(classic)) == set()) is classic_gated
    assert (_names(await load(harness)) == set()) is harness_gated
    await teardown(classic, harness)


@pytest.fixture
def config() -> DictConfig:
    return DictConfig()


class _State:
    pass


async def test_sf4_the_start_schedules_the_baseline_once_and_never_waits_for_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("MCP_HUB", raising=False)
    monkeypatch.setenv("AGENT_HARNESS_WORKER_ENABLED", "true")
    release = asyncio.Event()
    runs: list[int] = []

    async def slow(_config: object, *, at_ms: int) -> BaselineReport:
        runs.append(at_ms)
        await release.wait()
        return BaselineReport()

    state = _State()
    task = start_baseline(DictConfig(), state, at_ms=7, run=slow)
    assert task is not None and not task.done(), "the start returns while the baseline still runs"
    assert start_baseline(DictConfig(), state, at_ms=8, run=slow) is task, "one per process"
    await asyncio.sleep(0)
    release.set()
    await task
    assert runs == [7]


async def test_sf4_a_failing_baseline_is_logged_and_the_start_goes_on(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.delenv("MCP_HUB", raising=False)
    monkeypatch.setenv("AGENT_HARNESS_WORKER_ENABLED", "true")

    async def broken(_config: object, *, at_ms: int) -> BaselineReport:
        raise ConnectionError(f"store down at {at_ms}")

    task = start_baseline(DictConfig(), _State(), at_ms=1, run=broken)
    assert task is not None
    await task
    assert any("mcp_hub.baseline_failed" in r.getMessage() for r in caplog.records)


def test_sf4_where_harness_runs_do_not_use_the_hub_nothing_is_scheduled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MCP_HUB", "false")
    assert start_baseline(DictConfig(), _State(), at_ms=1) is None


def test_sf4_the_query_service_lifespan_schedules_it_without_awaiting() -> None:
    """The lifespan calls ``start_baseline`` and does not await it, so the start never waits for a server."""
    from app import query_main

    tree = ast.parse(inspect.getsource(query_main.lifespan))
    calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "start_baseline"
    ]
    assert len(calls) == 1
    awaited = {id(node.value) for node in ast.walk(tree) if isinstance(node, ast.Await)}
    assert id(calls[0]) not in awaited
