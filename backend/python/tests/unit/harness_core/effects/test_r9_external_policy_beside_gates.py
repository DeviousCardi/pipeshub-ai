"""The org's policy webhook (WP-35, G-40/GA-20) beside the run gates (WP-31, G-03/G-04), edit-then-approve (WP-29,
AP-06) and connect waits (WP-33, G-12), as round 9 merged them.

R9-EP-1 a plan-gated run's write, once the plan is approved, is asked about and runs as the webhook says; while the
        plan waits the gate refuses it with its own words and the webhook is never asked.
R9-EP-2 a call a person edited before approving it is asked about again with the person's arguments: the webhook's
        refusal of the edit stands, on the runner and on the loop across the suspension that waited for the person.
R9-EP-3 a dry run asks the webhook as a real run would: its refusal is a refusal, its ``ask`` asks nobody and is
        noted on the shadowed outcome, and no answer in time denies.
R9-EP-4 a connected call is decided in a new attempt; the webhook is asked there, not left to deny it unasked.
R9-EP-7 the webhook's ``ask`` is never explained by the run's own rule: that reason would offer "allow for this
        conversation", which never answers the webhook, and would let WP-36's batch decide it with other calls (G-13).
        WP-39: it is explained by its own rule, ``external_policy``, to a journal naming ``external_policy_asks``;
        an older journal gets no reason, so the card shows the call alone and the batch leaves it out.
"""

from __future__ import annotations

import dataclasses
from typing import TYPE_CHECKING

from harness_core.contracts.generated.run_spec import RunGates
from harness_core.effects import EffectRunner, RequestEffectLog
from harness_core.effects.edits import ApprovedEdit
from harness_core.effects.external_policy import (
    EXTERNAL_POLICY_RULE,
    ExternalPolicyGuard,
    ExternalVerdict,
)
from harness_core.effects.types import allow_all
from harness_core.gates.plan import PLAN_RULE, PlanGatedPolicy
from harness_core.interactions.connect import ConnectNeed
from harness_core.testing.contracts.effect_log import context
from harness_core.testing.run_spec import minimal_run_spec

from ..durable.support import RUN, World, reply, scripted
from .test_ga20_external_policy import Consultant, Ran, _call, _effect, guard

if TYPE_CHECKING:
    from pydantic import JsonValue

    from harness_core.effects import ApprovalDecision, EffectCall, HoldDecision
    from harness_core.effects.external_policy import PolicyQuestion
    from harness_core.effects.types import ToolEffect
    from harness_core.kernel.core.messages import ToolCall

EDITED: dict[str, JsonValue] = {"to": "rival@example.org", "body": "the customer list"}


@dataclasses.dataclass
class _Gate:
    approved: bool = False
    declined: bool = False


class _RefusesTheRival(Consultant):
    """Allows every call but one addressed to ``rival@example.org``."""

    async def ask(self, webhook: object, question: PolicyQuestion) -> ExternalVerdict:
        self.questions.append(question)
        said = str(question.arguments)
        return ExternalVerdict("deny", "No mail to rivals") if "rival@" in said else ExternalVerdict("allow")


class _ApprovesWithEdit:
    def __init__(self) -> None:
        self.asked = 0

    async def hold(self, call: EffectCall) -> HoldDecision | None:
        self.asked += 1
        return "approved"

    def approved_edit(self, call: EffectCall) -> ApprovedEdit | None:
        return ApprovedEdit(EDITED, "sha256:edit")


def _asks_for_writes(call: ToolCall, effect: ToolEffect) -> ApprovalDecision:
    return "ask" if effect.needs_intent_commit else "allow"


async def test_r9_ep1_an_approved_plans_write_is_asked_about_and_runs() -> None:
    consultant = Consultant(ExternalVerdict("allow"))
    policy = PlanGatedPolicy(guard(consultant), _Gate(approved=True))  # type: ignore[arg-type]
    ran = Ran()
    call = _call(_effect())
    result = await EffectRunner(RequestEffectLog(), policy).run(call, context(call), ran)
    assert (result.disposition, ran.count) == ("executed", 1)
    assert len(consultant.questions) == 1


async def test_r9_ep1_a_write_before_the_plan_is_approved_is_refused_by_the_gate_and_never_sent_out() -> None:
    consultant = Consultant(ExternalVerdict("allow"))
    policy = PlanGatedPolicy(guard(consultant), _Gate())  # type: ignore[arg-type]
    call = _call(_effect())
    result = await EffectRunner(RequestEffectLog(), policy).run(call, context(call), Ran())
    assert result.disposition == "denied"
    assert consultant.questions == []
    assert policy.denial(call.call, call.effect)[0] == PLAN_RULE


async def test_r9_ep1_the_loop_runs_a_plan_gated_write_once_the_plan_and_the_webhook_allow_it() -> None:
    world = World()
    world.admit(spec=minimal_run_spec().model_copy(update={"gates": RunGates(planApproval="required")}))
    consultant = Consultant(ExternalVerdict("allow"))
    _, port = scripted(
        reply("", ("submit_plan", {"plan": "File the bug.", "steps": ["File it"]})),
        reply("", ("create_issue", {"title": "Login fails"})),
        reply("Filed."),
    )
    suspended = await world.run(world.kernel(port, approval=guard(consultant)))
    assert suspended.status == "suspended" and suspended.reason is not None
    world.journal.resolve_interaction(RUN, suspended.reason, "approved")
    # A new attempt assembles a new policy, as the worker does.
    done = await world.run(world.kernel(port, approval=guard(consultant)))
    assert done.status == "completed"
    assert [e.op for e in world.saas.effects] == ["create_issue"]
    assert [q.tool_id for q in consultant.questions] == [world.events("tool.intent")[-1].data["toolId"]]


async def test_r9_ep2_the_runner_asks_again_about_the_persons_edit_and_its_refusal_stands() -> None:
    consultant = _RefusesTheRival()
    hold = _ApprovesWithEdit()
    ran = Ran()
    call = _call(_effect())
    result = await EffectRunner(RequestEffectLog(), guard(consultant, base=_asks_for_writes), hold=hold).run(
        call, context(call), ran
    )
    assert (result.disposition, ran.count, hold.asked) == ("denied", 0, 1)
    assert [q.arguments for q in consultant.questions][-1] == EDITED
    assert result.execution is None or "No mail to rivals" in str(result.execution.content)


async def test_r9_ep2_the_runner_runs_an_edit_the_webhook_allows() -> None:
    consultant = Consultant(ExternalVerdict("allow"))
    ran = Ran()
    call = _call(_effect())
    result = await EffectRunner(
        RequestEffectLog(), guard(consultant, base=_asks_for_writes), hold=_ApprovesWithEdit()
    ).run(call, context(call), ran)
    assert (result.disposition, ran.count) == ("executed", 1)
    assert len(consultant.questions) == 2


class _AsksForPosts:
    def __call__(self, call: ToolCall, effect: ToolEffect) -> ApprovalDecision:
        return "ask" if effect.needs_intent_commit else "allow"

    def ask_reason(self, call: ToolCall, effect: ToolEffect) -> dict[str, JsonValue]:
        return {"rule": "writes", "layer": "org", "toolId": effect.tool_id, "conversationGrant": False}


async def _loop_edit(consultant: Consultant, edits: dict[str, JsonValue]) -> tuple[World, str]:
    """The person answers after the attempt that asked has suspended: the next attempt decides the edit."""
    world = World()
    world.admit()
    model, port = scripted(reply("", ("post_message", {"channel": "#general", "text": "hi"})), reply("done"))

    def policy() -> ExternalPolicyGuard:
        return guard(consultant, base=_AsksForPosts())

    suspended = await world.run(world.kernel(port, approval=policy()))
    assert suspended.status == "suspended" and suspended.reason is not None
    world.journal.resolve_interaction(RUN, suspended.reason, "approved", edits=edits)
    done = await world.run(world.kernel(port, approval=policy()))
    assert done.status == "completed"
    return world, str(model.requests[-1])


async def test_r9_ep2_the_loop_asks_the_next_attempt_about_the_edit() -> None:
    consultant = Consultant(ExternalVerdict("allow"))
    world, _ = await _loop_edit(consultant, {"channel": "#team", "text": "summary"})
    posted = [{k: v for k, v in e.payload.items() if k != "invocation"} for e in world.saas.effects]
    assert posted == [{"channel": "#team", "text": "summary"}]
    assert [q.arguments for q in consultant.questions][-1] == {"channel": "#team", "text": "summary"}


async def test_r9_ep2_the_loop_refuses_an_edit_the_webhook_refuses() -> None:
    class _RefusesTeam(Consultant):
        async def ask(self, webhook: object, question: PolicyQuestion) -> ExternalVerdict:
            self.questions.append(question)
            return ExternalVerdict("deny", "Not that channel") if "#team" in str(question.arguments) else ExternalVerdict("allow")

    world, told = await _loop_edit(_RefusesTeam(), {"channel": "#team", "text": "summary"})
    assert world.saas.effects == []
    (denied,) = world.events("tool.denied")
    assert denied.data["rule"] == EXTERNAL_POLICY_RULE
    assert "Not that channel" in told


async def test_r9_ep3_a_dry_run_hears_the_webhook_as_a_real_run_would() -> None:
    call = _call(_effect())

    async def never(call: ToolCall, ctx: object) -> object:
        raise AssertionError("a dry run made the call")

    refused = await EffectRunner(RequestEffectLog(), guard(Consultant(ExternalVerdict("deny", "no"))), dry_run=True).run(
        call, context(call), never  # type: ignore[arg-type]
    )
    assert refused.disposition == "denied"

    late = await EffectRunner(RequestEffectLog(), guard(Consultant(delay=5.0)), dry_run=True).run(
        call, context(call), never  # type: ignore[arg-type]
    )
    assert late.disposition == "denied"

    hold = _ApprovesWithEdit()
    asked = await EffectRunner(
        RequestEffectLog(), guard(Consultant(ExternalVerdict("ask"))), hold=hold, dry_run=True
    ).run(call, context(call), never)  # type: ignore[arg-type]
    assert asked.disposition == "executed" and asked.execution is not None
    assert asked.execution.shadow is not None and asked.execution.shadow.would_ask is True
    assert hold.asked == 0


class _Unconnected:
    def need(self, call: ToolCall) -> ConnectNeed | None:
        return ConnectNeed("Slack", "toolset", "inst_slack_1") if call.name == "post_message" else None

    def declined(self, call: ToolCall) -> str:
        return "interaction_denied: Slack was not connected"


async def test_r9_ep4_a_connected_call_is_asked_about_in_the_attempt_that_decides_it() -> None:
    world = World()
    world.admit()
    consultant = Consultant(ExternalVerdict("allow"))
    _, port = scripted(reply("", ("post_message", {"channel": "#general", "text": "hi"})), reply("posted"))
    suspended = await world.run(world.kernel(port, approval=guard(consultant), connect=_Unconnected()))
    assert suspended.status == "suspended" and suspended.reason is not None
    world.journal.resolve_interaction(RUN, suspended.reason, "approved")
    done = await world.run(world.kernel(port, approval=guard(consultant), connect=_Unconnected()))
    assert done.status == "completed"
    assert [e.op for e in world.saas.effects] == ["post_message"]
    assert world.events("tool.denied") == []


def test_r9_the_plan_gate_passes_consultation_through() -> None:
    from harness_core.effects.types import ConsultingPolicy

    assert isinstance(PlanGatedPolicy(allow_all, _Gate()), ConsultingPolicy)  # type: ignore[arg-type]


class _AsksWritesForTheConversation:
    def __call__(self, call: ToolCall, effect: ToolEffect) -> ApprovalDecision:
        return "ask" if effect.needs_intent_commit else "allow"

    def ask_reason(self, call: ToolCall, effect: ToolEffect) -> dict[str, JsonValue]:
        return {"rule": "writes", "layer": "org", "toolId": effect.tool_id, "conversationGrant": True}


async def test_r9_ep7_the_webhooks_ask_offers_no_conversation_grant_and_no_batch() -> None:
    older = frozenset({"approval_reasons", "approval_rule_layers"})
    for base in (allow_all, _AsksWritesForTheConversation()):
        for accepts in (older, None):
            world = World(journal_accepts=accepts)
            world.admit()
            _, port = scripted(reply("", ("post_message", {"channel": "#g", "text": "hi"})), reply("done"))
            await world.run(world.kernel(port, approval=guard(Consultant(ExternalVerdict("ask")), base=base)))
            assert [e.data["kind"] for e in world.events("interaction.requested")] == ["approval"]
            explained = [(e.data["rule"], e.data["conversationGrant"]) for e in world.events("interaction.explained")]
            assert explained == ([] if accepts is older else [(EXTERNAL_POLICY_RULE, False)])

    world = World()
    world.admit()
    _, port = scripted(reply("", ("post_message", {"channel": "#g", "text": "hi"})), reply("done"))
    await world.run(world.kernel(port, approval=guard(Consultant(ExternalVerdict("allow")), base=_AsksWritesForTheConversation())))
    (explained,) = world.events("interaction.explained")
    assert explained.data["rule"] == "writes" and explained.data["conversationGrant"] is True
