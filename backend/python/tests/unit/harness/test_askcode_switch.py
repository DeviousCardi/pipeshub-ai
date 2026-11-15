"""ASKCODE AC-1..AC-4: the Approval policy page's "Ask before running code" switch stores the org's tool rule
``tools: {"pipeshub@sandbox/run_code": "ask"}`` (and nothing else). That stored org rule, read the way each path reads
it, holds offline ``run_code`` for a person on the durable loop, on an engine's gateway call and on a pinned run,
even when the org's ``writes`` switch is off. Off (no rule), code without network runs as CODEAUTO made it."""

from __future__ import annotations

import pytest

from app.control_plane.runtime.deployment import DeploymentLayer
from app.harness.approvals import approval_policy
from app.harness.run_policy.resolved import APPROVALS, resolved_approvals
from harness_core.kernel.core.messages import ToolCall
from harness_core.logs import HarnessLog
from harness_core.policy.orders import approval_ceiling
from tests.unit.harness_core.effects.test_codeauto_own_sandbox import (
    RUN_CODE,
    RUN_CODE_ID,
    _code_script,
    _engine_world,
    _world,
)

ORG = "org-1"
LOG = HarnessLog.named("tests.askcode")
# What the page saves with the switch on and the writes switch at "Run without asking".
SWITCH_ON = {"tools": {RUN_CODE_ID: "ask"}}
SWITCH_OFF: dict[str, object] = {}


def _org(rules: dict[str, object]) -> object:
    return approval_policy({"orgs": {ORG: rules}}, org_id=ORG, agent_key=None, log=LOG)  # type: ignore[dict-item]


# AC-1: the durable loop.
@pytest.mark.parametrize(
    ("rules", "status"), [(SWITCH_ON, "suspended"), (SWITCH_OFF, "completed")]
)
async def test_ac1_the_switch_holds_offline_run_code_on_the_loop(
    rules: dict[str, object], status: str
) -> None:
    world = _world()
    disposition = await world.run(world.kernel(_code_script(), approval=_org(rules)))
    assert disposition.status == status
    assert len(world.events("interaction.requested")) == (status == "suspended")


# AC-2: an engine's gateway call to run_code (CA-12's path, from the stored org document's shape).
async def test_ac2_the_switch_holds_an_engines_gateway_run_code() -> None:
    world = _engine_world(SWITCH_ON)  # type: ignore[arg-type]
    world.admit("run-askcode", 'tool run_code {"code": "print(1)"}\nsay waiting')
    assert (await world.attempt("run-askcode")).status == "suspended"
    assert [c for c in world.presenter.calls if c[0] == "approval"] == [
        ("approval", "run_code")
    ]
    assert sum(world.effects.values()) == 0


# AC-3: a pinned run reads the org's rule as a lifted ceiling; the tool rule survives the lift.
@pytest.mark.parametrize(
    ("rules", "decision"), [(SWITCH_ON, "ask"), (SWITCH_OFF, "allow")]
)
def test_ac3_a_pinned_runs_ceiling_keeps_the_switch(
    rules: dict[str, object], decision: str
) -> None:
    dimensions = {APPROVALS: {"value": approval_ceiling(rules), "setBy": "org"}}
    policy = resolved_approvals(dimensions, DeploymentLayer()).rules
    call = ToolCall(id="c", name="run_code", arguments={})
    assert policy(call, RUN_CODE) == decision
    if decision == "ask":
        assert policy.ask_reason(call, RUN_CODE) == {
            "rule": "tool",
            "layer": "org",
            "toolId": RUN_CODE_ID,
            "conversationGrant": False,
        }


# AC-4: an agent's own switch narrows that agent alone.
def test_ac4_an_agents_switch_holds_only_that_agent() -> None:
    document = {"orgAgents": {ORG: {"agent-1": SWITCH_ON}}}
    call = ToolCall(id="c", name="run_code", arguments={})
    for agent, decision in (("agent-1", "ask"), ("agent-2", "allow")):
        policy = approval_policy(document, org_id=ORG, agent_key=agent, log=LOG)  # type: ignore[arg-type]
        assert policy(call, RUN_CODE) == decision
