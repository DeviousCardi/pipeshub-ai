"""QA-3 MCP-26: an admin approves a changed schema of an MCP tool while a run pinned on the old one is in flight.

``RunDriver`` with the production assembler over the in-memory journal (``world``). The MCP server lists its tools
live (``world.MCP_TOOLS``) and the hub's approval is in configuration, where the admin route writes it; the model's
turn is where "meanwhile" happens (``Turn.from_request``).
"""

from __future__ import annotations

from typing import TYPE_CHECKING
from unittest.mock import patch

import pytest

from app.harness.assembly.assembler import PipesHubRuntimeAssembler
from app.harness.mcp_hub.manifests import (
    approval_document,
    descriptor_of,
    manifest_path,
)
from harness_core.contracts import dump_contract, validate_contract
from harness_core.contracts.generated.run_spec import RunSpec
from harness_core.driver import CapabilityLost, RunDriver
from harness_core.failpoints import Raise, registry
from harness_core.kernel.durable.capability import CAPABILITY_RECHECK_S
from harness_core.mcp_hub.manifest import ApprovedManifest
from harness_core.testing import (
    ManualClock,
    ModelScript,
    Reply,
    ScriptedModel,
    ToolCallSpec,
    Turn,
)
from harness_core.testing.durable import ScriptedModelPort
from tests.support.mcp_tool_admission import mcp_approvals_required  # noqa: F401 - the fixture, used by name

from . import world as w

# D-MCP-5: these are the approval gate's own tests, run as an edition that requires it.
pytestmark = pytest.mark.usefixtures("mcp_approvals_required")

if TYPE_CHECKING:
    from collections.abc import Iterator

    from app.agents.mcp.models import MCPToolInfo
    from harness_core.testing.model_types import ModelRequest

MCP_PRS = f"mcp@{w.MCP}/list_prs"
PINNED = w.MCP_TOOLS[w.MCP][0]
CHANGED = PINNED.model_copy(
    update={
        "description": "List pull requests, and close the stale ones.",
        "input_schema": {"type": "object", "properties": {"repo": {"type": "string"}, "close": {"type": "boolean"}}},
    }
)
LEASE_S = 30


class _Died(BaseException):
    pass


@pytest.fixture(autouse=True)
def _deployment() -> Iterator[None]:
    # The hub on at the claim: approvals are what these pins are checked against (MCPLIVE checks live tools otherwise).
    with w.deployment(), patch("app.harness.assembly.assembler.mcp_hub_enabled", return_value=True):
        yield
    registry.reset()


class Rig:
    """One run pinned on the approved ``list_prs``, and the admin and the server that can change under it."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, *turns: Turn) -> None:
        self._monkeypatch = monkeypatch
        self.services = w.Services()
        self.clock = ManualClock()
        self.journal = w.pipeshub_journal(clock=self.clock, lease_ms=LEASE_S * 1000)
        self.port = ScriptedModelPort(ScriptedModel(ModelScript(id="mcp-26", turns=list(turns))))
        self.assembler = PipesHubRuntimeAssembler(self.services, model_factory=w.model_factory(self.port))
        self.driver = RunDriver(journal=self.journal, assembler=w.ClaimAssembler(self.assembler), clock=self.clock)
        self._revision = 0
        self.approve(PINNED)
        self.spec = self._pinned()
        self.journal.admit("run-1", org_id=w.ORG, session_id="ses-1", spec=self.spec, input_text="list prs")

    def approve(self, tool: MCPToolInfo) -> None:
        """The server now lists ``tool`` and the admin approves it."""
        self._monkeypatch.setitem(w.MCP_TOOLS, w.MCP, [tool])
        self._write_approval(tool)

    def withdraw(self) -> None:
        """The admin approves the server with none of its tools; the server lists what it listed."""
        self._write_approval()

    def _write_approval(self, *tools: MCPToolInfo) -> None:
        self._revision += 1
        self.services.config.put(
            manifest_path(w.MCP),
            approval_document(
                w.MCP, tuple(descriptor_of(t) for t in tools), by="p_admin", at_ms=self._revision, previous=None
            ),
        )

    def _pinned(self) -> RunSpec:
        digest = descriptor_of(PINNED).digest()
        raw = dump_contract(w.pinned_spec(tool_ids=[MCP_PRS], mcp=[w.MCP]))
        raw["schemaVersion"] = 3
        raw["grants"]["tools"][0].update(descriptorDigest=digest, digestVersion=2)
        raw["extensions"]["x.pipeshub"]["mcp"][0].update(
            manifestDigest=ApprovedManifest({"list_prs": digest}, "p_admin", 1).granted_digest(["list_prs"]),
            digestVersion=2,
        )
        return validate_contract(RunSpec, raw)

    async def attempt(self) -> tuple[str, str | None]:
        outcome = await self.driver.run_claimed(await w.claim_next(self.journal))
        return outcome.status, outcome.reason

    async def attempt_that_dies(self) -> None:
        registry.arm("worker.model.after_response_commit", Raise(_Died))
        with pytest.raises(_Died):
            _ = await self.attempt()
        registry.reset()
        _ = self.clock.advance(LEASE_S + 1)
        _ = self.journal.sweep()

    def offered(self, call: int) -> tuple[str, object]:
        """What the model was told ``list_prs`` is on its ``call``-th request."""
        (tool,) = [t for t in self.port.calls[call].tools or [] if t.name == "mcp_github_list_prs"]
        return tool.description, tool.input_schema


def _calls_the_tool(meanwhile: object = None) -> Turn:
    def reply(_: ModelRequest) -> Reply:
        if callable(meanwhile):
            meanwhile()
        return Reply(tool_calls=[ToolCallSpec(name="mcp_github_list_prs", args={"repo": "a"})])

    return Turn(from_request=reply)


async def test_mcp26a_a_running_attempt_goes_on_with_the_descriptor_it_was_pinned_on(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rig = Rig(monkeypatch, _calls_the_tool(lambda: rig.approve(CHANGED)), Turn(reply=Reply(text="two open")))

    assert await rig.attempt() == ("completed", None)

    assert len(rig.port.calls) == 2
    assert rig.offered(1) == rig.offered(0)
    assert "close" not in str(rig.offered(1))
    # The approval did move under the attempt: the same pin can no longer be claimed.
    with pytest.raises(CapabilityLost) as lost:
        _ = await rig.assembler.build(w.claim(rig.spec))
    assert set(lost.value.changed) == {f"tool:{MCP_PRS}", f"mcp:{w.MCP}"}


async def test_mcp26b_every_later_claim_waits_its_bound_then_the_run_is_capability_lost(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rig = Rig(monkeypatch, _calls_the_tool(lambda: rig.approve(CHANGED)), Turn(reply=Reply(text="never")))
    await rig.attempt_that_dies()

    outcomes = []
    for delay in CAPABILITY_RECHECK_S:
        outcomes.append(await rig.attempt())
        _ = rig.clock.advance(delay)
    final = await rig.attempt()

    assert outcomes == [("yielded", "capability_wait")] * len(CAPABILITY_RECHECK_S)
    assert final == ("failed", "capability_lost")
    assert rig.journal.status("run-1") == "failed"
    assert len(rig.port.calls) == 1, "no model call on the approval nobody pinned"


async def test_mcp26c_the_pinned_approval_restored_within_the_bound_runs_on_the_same_pin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rig = Rig(monkeypatch, _calls_the_tool(lambda: rig.approve(CHANGED)), Turn(reply=Reply(text="two open")))
    await rig.attempt_that_dies()
    assert await rig.attempt() == ("yielded", "capability_wait")

    rig.approve(PINNED)
    _ = rig.clock.advance(CAPABILITY_RECHECK_S[0])

    assert await rig.attempt() == ("completed", None)
    assert rig.offered(1) == rig.offered(0)


async def test_mcp26e_an_approval_withdrawn_mid_attempt_costs_the_next_claim_though_the_server_did_not_change(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Only the pin can see this one: what the next attempt would observe of the server is what the first saw."""
    rig = Rig(monkeypatch, _calls_the_tool(lambda: rig.withdraw()), Turn(reply=Reply(text="never")))
    await rig.attempt_that_dies()

    assert await rig.attempt() == ("yielded", "capability_wait")
    assert len(rig.port.calls) == 1
