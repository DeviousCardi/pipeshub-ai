"""GA-20 / G-40 (worker half): an org's external policy webhook is asked before every call that writes outside the
organization, and fails closed.

EP-1 (GA-20) a webhook that does not answer within the org's timeout denies the call, with the reason, and the
     call never runs; the denial is journaled as ``tool.denied`` with rule ``external_policy`` (the record the org's
     audit chain keeps).
EP-2 an error, an unreadable setting or an answer it does not understand denies too.
EP-3 the webhook's own deny reaches the model quoted as data; its ``ask`` asks a person; its ``allow`` never loosens
     the run's own rules.
EP-4 reads and calls that stay inside the organization are never sent, and an org without a webhook is unaffected.
EP-5 one question per call: the plan's consultation is reused when the call runs.
EP-6 the question carries the call's arguments with secrets masked.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from harness_core.contracts.generated.sink import SinkDescriptor
from harness_core.effects import (
    EffectCall,
    EffectRunner,
    RequestEffectLog,
    ToolEffect,
    ToolExecution,
    args_digest,
)
from harness_core.effects.external_policy import (
    EXTERNAL_POLICY_RULE,
    ExternalPolicyGuard,
    ExternalVerdict,
    PolicyWebhook,
    UnclearPolicyAnswer,
)
from harness_core.effects.types import allow_all, tool_id_for
from harness_core.kernel.core.messages import ToolCall
from harness_core.security.token_patterns import redact_secrets_in
from harness_core.testing.contracts.effect_log import context

from ..durable.support import World, reply, scripted

if TYPE_CHECKING:
    from collections.abc import Mapping

    from pydantic import JsonValue

    from harness_core.effects import ApprovalDecision, HoldDecision
    from harness_core.effects.external_policy import PolicyQuestion
    from harness_core.effects.types import ToolContext

HOOK = PolicyWebhook(url="https://dlp.example.com/decide", timeout_s=0.05, auth_header=("X-Key", "k"))


def _effect(egress: str = "external", kind: str = "write") -> ToolEffect:
    return ToolEffect(
        tool_id_for("send_mail"), kind, False, SinkDescriptor(egress=egress, args_leave_boundary=egress == "external")
    )


def _call(effect: ToolEffect, args: dict[str, JsonValue] | None = None) -> EffectCall:
    arguments: dict[str, JsonValue] = args if args is not None else {"to": "partner@example.com", "body": "Q3 plan"}
    return EffectCall(
        "run-1", "inv-1", ToolCall(id="inv-1", name="send_mail", arguments=arguments), effect, args_digest(arguments)
    )


class Hooks:
    def __init__(self, hook: PolicyWebhook | None = HOOK, error: Exception | None = None) -> None:
        self.hook, self.error = hook, error

    async def webhook(self, org_id: str) -> PolicyWebhook | None:
        if self.error is not None:
            raise self.error
        return self.hook


class Consultant:
    def __init__(self, verdict: ExternalVerdict | None = None, *, delay: float = 0.0, error: Exception | None = None) -> None:
        self.verdict, self.delay, self.error = verdict or ExternalVerdict("allow"), delay, error
        self.questions: list[PolicyQuestion] = []

    async def ask(self, webhook: PolicyWebhook, question: PolicyQuestion) -> ExternalVerdict:
        self.questions.append(question)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error is not None:
            raise self.error
        return self.verdict


def guard(consultant: Consultant, hooks: Hooks | None = None, base: object = allow_all) -> ExternalPolicyGuard:
    return ExternalPolicyGuard(
        base,  # type: ignore[arg-type]
        hooks or Hooks(),
        consultant,
        "org-1",
        "run-1",
        lambda call: redact_secrets_in(call.arguments),  # type: ignore[arg-type]
    )


class Ran:
    def __init__(self) -> None:
        self.count = 0

    async def __call__(self, call: ToolCall, ctx: ToolContext) -> ToolExecution:
        self.count += 1
        return ToolExecution(status="ok", content="sent")


class _Approves:
    async def hold(self, call: EffectCall) -> HoldDecision | None:
        return "approved"


async def _run(policy: ExternalPolicyGuard, effect: ToolEffect | None = None, **runner: object) -> tuple[str, str, int]:
    ran = Ran()
    call = _call(effect or _effect())
    result = await EffectRunner(RequestEffectLog(), policy, **runner).run(call, context(call), ran)  # type: ignore[arg-type]
    content = str(result.execution.content) if result.execution is not None else ""
    return result.disposition, content, ran.count


async def test_ep1_ga20_a_webhook_that_does_not_answer_in_time_denies_with_its_reason() -> None:
    disposition, said, ran = await _run(guard(Consultant(delay=5.0)))

    assert disposition == "denied"
    assert ran == 0
    assert "external policy check did not answer in time" in said
    assert "do not retry it" in said


async def test_ep2_an_error_an_unreadable_setting_or_an_unclear_answer_denies() -> None:
    for policy, words in (
        (guard(Consultant(error=OSError("connection refused"))), "failed"),
        (guard(Consultant(), Hooks(error=RuntimeError("kv down"))), "could not be read"),
        (guard(Consultant(error=UnclearPolicyAnswer("no decision"))), "gave an answer it does not understand"),
    ):
        disposition, said, ran = await _run(policy)
        assert (disposition, ran) == ("denied", 0)
        assert words in said


async def test_ep3_the_webhooks_deny_ask_and_allow_combine_with_the_runs_own_rules() -> None:
    disposition, said, _ = await _run(guard(Consultant(ExternalVerdict("deny", 'Contains "customer list"'))))
    assert disposition == "denied"
    assert 'its reason: "Contains \\"customer list\\""' in said

    asked = guard(Consultant(ExternalVerdict("ask")))
    disposition, _, ran = await _run(asked, hold=_Approves())
    assert (disposition, ran) == ("executed", 1)
    call = _call(_effect())
    assert asked(call.call, call.effect) == "ask"
    assert asked.grant_answers(call.call, call.effect) is False

    def denies(call: ToolCall, effect: ToolEffect) -> ApprovalDecision:
        return "deny"

    disposition, _, ran = await _run(guard(Consultant(ExternalVerdict("allow")), base=denies))
    assert (disposition, ran) == ("denied", 0)


async def test_ep4_reads_inside_calls_and_orgs_without_a_webhook_are_not_sent() -> None:
    consultant = Consultant(delay=5.0)
    for effect in (_effect(kind="read"), _effect(egress="internal_audience"), _effect(egress="self")):
        disposition, _, ran = await _run(guard(consultant), effect)
        assert (disposition, ran) == ("executed", 1)
    assert consultant.questions == []

    disposition, _, ran = await _run(guard(Consultant(delay=5.0), Hooks(hook=None)))
    assert (disposition, ran) == ("executed", 1)


async def test_ep5_one_question_per_call() -> None:
    consultant = Consultant()
    policy = guard(consultant)
    call = _call(_effect())
    await policy.consult(call.call, call.effect)
    await policy.consult(call.call, call.effect)
    disposition, _, _ = await _run(policy)
    assert disposition == "executed"
    assert len(consultant.questions) == 1


async def test_ep6_the_question_carries_the_arguments_with_secrets_masked() -> None:
    consultant = Consultant()
    secret = "sk-" + "proj-" + "Q7mZ2rT9xL4pW8vK3dN6sH1bY5"
    await _run(guard(consultant), None)
    policy = guard(consultant)
    call = _call(_effect(), {"to": "a@example.com", "api_key": "short", "body": f"key {secret}"})
    await policy.consult(call.call, call.effect)
    question = consultant.questions[-1]
    assert (question.org_id, question.run_id, question.invocation_id, question.risk) == (
        "org-1",
        "run-1",
        "inv-1",
        "write_external",
    )
    assert secret not in str(question.arguments)
    assert "short" not in str(question.arguments)
    assert "a@example.com" in str(question.arguments)


async def test_ep1_ga20_the_durable_loop_journals_the_denial_for_the_audit_chain() -> None:
    world = World()
    sends = Ran()

    async def send_note(args: Mapping[str, JsonValue], ctx: ToolContext) -> ToolExecution:
        return await sends(ToolCall(id="x", name="send_note"), ctx)

    world.tools.add("send_note", send_note, tags=[("category", "write")])
    world.admit()
    policy = guard(Consultant(delay=5.0))
    model, port = scripted(reply("", ("send_note", {"text": "hi"})), reply("It was not sent."))
    disposition = await world.run(world.kernel(port, approval=policy))

    assert disposition.status == "completed"
    assert sends.count == 0
    denied = [e for e in world.events() if e.type == "tool.denied"]
    assert [e.data["rule"] for e in denied] == [EXTERNAL_POLICY_RULE]
    assert "did not answer in time" in str(model.requests[-1])
