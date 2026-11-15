"""WP-39 (G-40, GA-20 follow-ups): the org's policy webhook's ``ask`` is explained, and the webhook hears a dry run.

WP39-EX-1 the webhook's ``ask`` is journaled with its own rule, ``external_policy`` (layer org): no conversation grant
          and no "Don't ask again", whatever the run's own rule offered; where the call goes is kept for the card.
WP39-EX-2 a journal whose claim does not name ``external_policy_asks`` (an older Node) gets no reason at all, as in
          round 9: the card shows the call alone, offers no grant, and the batch leaves it out.
WP39-EX-3 an edition's rule that asks as well keeps its own reason when it names who approves (it routes the decision
          to that rule's approvers, which the webhook's reason would drop); one that names no approver yields to the
          webhook's reason, which is outermost.
WP39-EX-4 the engine kernel's view writes the same reason under the same capability.
WP39-DR-1 the question tells the webhook whether the run is a dry run (``dryRun``); the guard carries the run's
          gate (a required argument where the loop and the engine build a run's guard).
"""

from __future__ import annotations

import pytest

from typing import TYPE_CHECKING

from harness_core.effects import flow
from harness_core.effects.external_policy import (
    EXTERNAL_POLICY_RULE,
    ExternalPolicyGuard,
    ExternalVerdict,
    PolicyQuestion,
)
from harness_core.effects.flow import reason_for_journal
from harness_core.effects.types import allow_all
from harness_core.journal.types import EXTERNAL_POLICY_ASKS
from harness_core.security.token_patterns import redact_secrets_in

from ..durable.support import World, reply, scripted
from .test_ga20_external_policy import Consultant, Hooks, _call, _effect

if TYPE_CHECKING:
    from pydantic import JsonValue

    from harness_core.effects import ApprovalDecision
    from harness_core.effects.types import ToolEffect
    from harness_core.kernel.core.messages import ToolCall

DESTINATION: dict[str, JsonValue] = {"label": "#g", "key": "sha256:" + "a" * 64}


class _AsksForTheConversation:
    """A layer's write rule that offers "allow for this conversation" and "Don't ask again"."""

    def __call__(self, call: ToolCall, effect: ToolEffect) -> ApprovalDecision:
        return "ask" if effect.needs_intent_commit else "allow"

    def ask_reason(self, call: ToolCall, effect: ToolEffect) -> dict[str, JsonValue]:
        return {
            "rule": "writes",
            "layer": "agent",
            "toolId": effect.tool_id,
            "conversationGrant": True,
            "destination": DESTINATION,
            "ruleGrant": {"instanceId": "mcp-1", "toolName": "post_message"},
        }


class _EditionRuleAsks(_AsksForTheConversation):
    def ask_reason(self, call: ToolCall, effect: ToolEffect) -> dict[str, JsonValue]:
        return {
            "rule": "edition_rule",
            "layer": "org",
            "toolId": effect.tool_id,
            "conversationGrant": False,
            "editionPart": {"level": "l2", "approvers": "admins"},
        }


def _guard(verdict: str, base: object = allow_all, *, dry_run: bool = False, consultant: Consultant | None = None) -> ExternalPolicyGuard:
    return ExternalPolicyGuard(
        base,  # type: ignore[arg-type]
        Hooks(),
        consultant or Consultant(ExternalVerdict(verdict)),  # type: ignore[arg-type]
        "org-1",
        "run-1",
        lambda call: redact_secrets_in(call.arguments),  # type: ignore[arg-type]
        dry_run=dry_run,
    )


async def _explained(world: World, verdict: str, base: object) -> list[dict[str, JsonValue]]:
    world.admit()
    _, port = scripted(reply("", ("post_message", {"channel": "#g", "text": "hi"})), reply("done"))
    await world.run(world.kernel(port, approval=_guard(verdict, base)))
    assert [e.data["kind"] for e in world.events("interaction.requested")] == ["approval"]
    return [dict(e.data) for e in world.events("interaction.explained")]


async def test_wp39_ex1_the_webhooks_ask_is_explained_by_its_own_rule_and_offers_no_grant() -> None:
    for base in (allow_all, _AsksForTheConversation()):
        (explained,) = await _explained(World(), "ask", base)
        assert explained["rule"] == EXTERNAL_POLICY_RULE
        assert explained["layer"] == "org"
        assert explained["conversationGrant"] is False
        assert "ruleGrant" not in explained
    # The run's rule named where the call goes; the card keeps it in its title.
    (explained,) = await _explained(World(), "ask", _AsksForTheConversation())
    assert explained["destination"] == DESTINATION


async def test_wp39_ex2_a_journal_without_the_capability_gets_no_reason_as_before() -> None:
    older = World(journal_accepts=frozenset({"approval_reasons", "approval_rule_layers", "approval_rule_grants"}))
    assert await _explained(older, "ask", _AsksForTheConversation()) == []
    # The run's own ask, without the webhook's, is explained to that journal as before.
    world = World(journal_accepts=frozenset({"approval_reasons", "approval_rule_layers", "approval_rule_grants"}))
    (explained,) = await _explained(world, "allow", _AsksForTheConversation())
    assert explained["rule"] == "writes" and explained["conversationGrant"] is True


def test_wp39_ex2_reason_for_journal_withholds_the_rule_from_a_journal_that_does_not_name_it() -> None:
    reason: dict[str, JsonValue] = {"rule": EXTERNAL_POLICY_RULE, "layer": "org", "toolId": "t", "conversationGrant": False}
    assert reason_for_journal(reason, layers=True, external_policy=True) == reason
    assert reason_for_journal(reason, layers=True) is None
    assert reason_for_journal(reason, layers=False, external_policy=True) is None


def test_wp39_ex3_an_edition_rule_ask_beside_the_webhooks_keeps_its_approvers(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(flow._EDITION_RULES, "edition_rule", "edition_asks")
    monkeypatch.setattr(flow, "_ROUTING_RULES", {"edition_rule"})
    policy = _guard("ask", _EditionRuleAsks())
    call = _call(_effect())
    policy._answers[policy._key(call.call, call.effect)] = ExternalVerdict("ask")
    reason = policy.ask_reason(call.call, call.effect)
    assert reason is not None and reason["rule"] == "edition_rule"
    assert reason["editionPart"] == {"level": "l2", "approvers": "admins"}
    assert policy.grant_answers(call.call, call.effect) is False


def test_wp39_ex3_an_edition_rule_naming_no_approver_yields_to_the_webhooks_reason(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(flow, "_EDITION_RULES", {})
    monkeypatch.setattr(flow, "_ROUTING_RULES", set())
    flow.register_edition_rule("edition_rule", "edition_asks", routes_approval=False)
    policy = _guard("ask", _EditionRuleAsks())
    call = _call(_effect())
    policy._answers[policy._key(call.call, call.effect)] = ExternalVerdict("ask")
    reason = policy.ask_reason(call.call, call.effect)
    assert reason is not None and reason["rule"] == "external_policy"
    assert "editionPart" not in reason
    with pytest.raises(ValueError, match="already defined"):
        flow.register_edition_rule("edition_rule", "edition_asks")
    flow.register_edition_rule("edition_rule", "edition_asks", routes_approval=False)


async def test_wp39_ex4_the_engine_view_writes_the_rule_only_under_the_capability() -> None:
    from harness_core.engines.durable.kernel import (
        _PresentingView,
    )
    from harness_core.journal.types import NewEvent
    from harness_core.logs import HarnessLog

    class _Inner:
        def __init__(self) -> None:
            self.appended: list[NewEvent] = []

        async def append(self, events: list[NewEvent]) -> None:
            self.appended.extend(events)

    class _Sink:
        turn = None

    reason: dict[str, JsonValue] = {"rule": EXTERNAL_POLICY_RULE, "layer": "org", "toolId": "t", "conversationGrant": False}
    for accepted, written in ((True, [EXTERNAL_POLICY_RULE]), (False, [])):
        inner = _Inner()
        view = _PresentingView(
            inner,  # type: ignore[arg-type]
            _Sink(),  # type: ignore[arg-type]
            explains=True,
            layers=True,
            log=HarnessLog.named("test"),
            external_policy=accepted,
        )
        view.reasons["ix.1"] = reason
        await view.append([NewEvent("interaction.requested", {"interactionId": "ix.1", "kind": "approval"})])
        assert [e.data["rule"] for e in inner.appended if e.type == "interaction.explained"] == written


async def test_wp39_dr1_the_question_says_whether_the_run_is_a_dry_run() -> None:
    for dry in (True, False):
        consultant = Consultant(ExternalVerdict("allow"))
        policy = _guard("allow", dry_run=dry, consultant=consultant)
        call = _call(_effect())
        await policy.consult(call.call, call.effect)
        (question,) = consultant.questions
        assert isinstance(question, PolicyQuestion) and question.dry_run is dry


def test_wp39_ex_the_capability_is_named() -> None:
    assert EXTERNAL_POLICY_ASKS == "external_policy_asks"
