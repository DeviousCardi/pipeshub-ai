"""An org's external policy webhook over every call that writes outside the organization (G-40, GA-20).

Security teams keep their own DLP or approval system in the loop: before such a call is decided, the webhook is
asked, and the stricter of its answer and the run's own rules applies. It fails closed: no answer within the
org's timeout, an error, or an answer that is not one of ``allow``, ``ask`` or ``deny`` denies the call, and the
model is told why. Calls that stay inside the organization, and reads, are never sent.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Final, Literal, Protocol

from harness_core.effects.flow import (
    EXTERNAL_POLICY_REASON_RULE,
    routes_approval,
)
from harness_core.effects.policy import stricter
from harness_core.effects.redaction import redaction_of
from harness_core.effects.types import (
    POLICY_DENIAL,
    ExplainsAsk,
    ExplainsDenial,
    GrantAnswers,
    args_digest,
    refresh_policy,
)
from harness_core.logs import HarnessLog

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping

    from pydantic import JsonValue

    from harness_core.effects.redaction import Redaction
    from harness_core.effects.types import ApprovalDecision, ApprovalPolicy, ToolEffect
    from harness_core.kernel.core.messages import ToolCall

EXTERNAL_POLICY_RULE: Final = EXTERNAL_POLICY_REASON_RULE
# The most of the webhook's reason the model and the person read.
MAX_REASON_CHARS: Final = 500

Verdict = Literal["allow", "ask", "deny"]
VERDICTS: Final[frozenset[str]] = frozenset({"allow", "ask", "deny"})


@dataclass(frozen=True, slots=True)
class ExternalVerdict:
    """The webhook's answer (``reason``: its own words), or the guard's denial when there is none (``failure``)."""

    decision: Verdict
    reason: str | None = None
    failure: str | None = None


@dataclass(frozen=True, slots=True)
class PolicyWebhook:
    """The org's webhook as its admin set it; ``timeout_s`` bounds the whole exchange."""

    url: str
    timeout_s: float
    auth_header: tuple[str, str] | None = None


@dataclass(frozen=True, slots=True)
class PolicyQuestion:
    org_id: str
    run_id: str
    invocation_id: str
    tool_id: str
    risk: str
    # Secret-named values and credential shapes masked (``redact_secrets_in``).
    arguments: JsonValue
    # The run is a dry run (G-03): the call would be shadowed, not made, whatever the webhook answers.
    dry_run: bool = False


class UnclearPolicyAnswer(ValueError):
    """The webhook answered, but not with ``{"decision": "allow" | "ask" | "deny"}``."""


class PolicyWebhooks(Protocol):
    """The org's webhook now, or ``None`` when it has none on. Raises when the setting cannot be read."""

    async def webhook(self, org_id: str) -> PolicyWebhook | None: ...


class PolicyConsultant(Protocol):
    """Asks one webhook one question. Raises on anything that is not an answer (the guard denies)."""

    async def ask(self, webhook: PolicyWebhook, question: PolicyQuestion) -> ExternalVerdict: ...


def writes_outside(effect: ToolEffect) -> bool:
    """A call the webhook is asked about: anything but a read whose sink is outside the organization."""
    return effect.effect != "read" and effect.sink.egress == "external"


def _said(reason: str | None) -> str:
    return " ".join((reason or "").split())[:MAX_REASON_CHARS]


def external_denial(reason: str) -> tuple[str, str]:
    return (
        EXTERNAL_POLICY_RULE,
        f"denied: the organization's external policy check {reason}, so the call was not made. "
        "Tell the user it was not done; do not retry it unless they ask you to.",
    )


@dataclass
class ExternalPolicyGuard:
    """``base`` narrowed by the org's policy webhook, consulted once per call before it is decided."""

    base: ApprovalPolicy
    webhooks: PolicyWebhooks
    consultant: PolicyConsultant
    org_id: str
    run_id: str
    arguments: Callable[[ToolCall], JsonValue]
    dry_run: bool = False
    log: HarnessLog = field(default_factory=lambda: HarnessLog.named("harness_core.effects.external_policy"))
    # The webhook's answer per call and arguments, or why there is none (a denial reason). The arguments are part of
    # the key so a call a person edited before approving it (AP-06) is asked about again with what they wrote.
    _answers: dict[tuple[str, str, str], ExternalVerdict] = field(default_factory=dict)
    # Whether the org has a webhook on, as the last refresh read it; None: never read, or unreadable.
    _has_webhook: bool | None = None

    @staticmethod
    def _key(call: ToolCall, effect: ToolEffect) -> tuple[str, str, str]:
        return call.id, effect.tool_id, args_digest(call.arguments)

    async def refresh(self) -> None:
        """Also learns whether the org has a webhook on, so a call decided without its own consultation is denied
        only when there is one to ask (or the setting cannot be read)."""
        await refresh_policy(self.base)
        try:
            self._has_webhook = await self.webhooks.webhook(self.org_id) is not None
        except Exception as error:  # an unreadable setting fails closed, whatever it raised
            self._has_webhook = None
            self.log.warning(
                "effects.external_policy_unreadable", rule=EXTERNAL_POLICY_RULE, errorType=type(error).__name__
            )

    async def consult(self, call: ToolCall, effect: ToolEffect) -> None:
        if not writes_outside(effect) or self._key(call, effect) in self._answers:
            return
        self._answers[self._key(call, effect)] = await self._ask(call, effect)

    async def _ask(self, call: ToolCall, effect: ToolEffect) -> ExternalVerdict:
        try:
            webhook = await self.webhooks.webhook(self.org_id)
        except Exception as error:  # an unreadable setting fails closed, whatever it raised
            self._logged("setting_unreadable", effect, error)
            return ExternalVerdict("deny", failure="could not be read")
        if webhook is None:
            return ExternalVerdict("allow")
        question = PolicyQuestion(
            org_id=self.org_id,
            run_id=self.run_id,
            invocation_id=call.id,
            tool_id=effect.tool_id,
            risk=effect.risk,
            arguments=self.arguments(call),
            dry_run=self.dry_run,
        )
        try:
            # GA-20: the org's timeout bounds the exchange even when the transport's own does not hold.
            verdict = await asyncio.wait_for(self.consultant.ask(webhook, question), timeout=webhook.timeout_s)
        except TimeoutError as error:
            self._logged("timeout", effect, error)
            return ExternalVerdict("deny", failure="did not answer in time")
        except UnclearPolicyAnswer as error:
            self._logged("bad_answer", effect, error)
            return ExternalVerdict("deny", failure="gave an answer it does not understand")
        except Exception as error:  # any failure to answer denies (fail closed)
            self._logged("failed", effect, error)
            return ExternalVerdict("deny", failure="failed")
        if verdict.decision not in VERDICTS:
            self._logged("bad_answer", effect, None)
            return ExternalVerdict("deny", failure="gave an answer it does not understand")
        if verdict.decision != "allow":
            self.log.info(
                "effects.external_policy_narrowed",
                toolId=effect.tool_id,
                invocationId=call.id,
                decision=verdict.decision,
                rule=EXTERNAL_POLICY_RULE,
            )
        return verdict

    def _logged(self, reason: str, effect: ToolEffect, error: BaseException | None) -> None:
        self.log.warning(
            "effects.external_policy_denied",
            toolId=effect.tool_id,
            reasonCode=reason,
            rule=EXTERNAL_POLICY_RULE,
            errorType=type(error).__name__ if error is not None else None,
        )

    def _own(self, call: ToolCall, effect: ToolEffect) -> ApprovalDecision:
        if not writes_outside(effect):
            return "allow"
        answer = self._answers.get(self._key(call, effect))
        if answer is not None:
            return answer.decision
        # Decided without its consultation: allowed only when the org is known to have no webhook on.
        return "allow" if self._has_webhook is False else "deny"

    def __call__(self, call: ToolCall, effect: ToolEffect) -> ApprovalDecision:
        return stricter(self.base(call, effect), self._own(call, effect))

    def redaction(self, call: ToolCall, effect: ToolEffect) -> Redaction | None:
        return redaction_of(self.base, call, effect)

    def denial(self, call: ToolCall, effect: ToolEffect) -> tuple[str, str]:
        if self._own(call, effect) == "deny":
            answer = self._answers.get(self._key(call, effect))
            if answer is None:
                return external_denial("was not made")
            if answer.failure is not None:
                return external_denial(answer.failure)
            # The webhook's words are quoted as data, so text inside them never reads as the refusal's own.
            said = _said(answer.reason)
            return external_denial(f"refused it (its reason: {json.dumps(said, ensure_ascii=False)})" if said else "refused it")
        return self.base.denial(call, effect) if isinstance(self.base, ExplainsDenial) else POLICY_DENIAL

    def ask_reason(self, call: ToolCall, effect: ToolEffect) -> Mapping[str, JsonValue] | None:
        base = self.base.ask_reason(call, effect) if isinstance(self.base, ExplainsAsk) else None
        if self._own(call, effect) != "ask":
            return base
        # An edition's rule that names who approves keeps its reason: Node routes the decision by it, and it offers
        # no grant and no batch either.
        if routes_approval(base):
            return base
        # The webhook's own rule, never the base's: the base's would offer an "allow for this conversation" that
        # never answers the webhook (``grant_answers``) and let WP-36 batch the call with others (G-13). A journal
        # that does not name the rule gets no reason (``reason_for_journal``): the card shows the call alone.
        reason: dict[str, JsonValue] = {
            "rule": EXTERNAL_POLICY_RULE,
            "layer": "org",
            "toolId": effect.tool_id,
            "conversationGrant": False,
        }
        if base is not None and "destination" in base:
            reason["destination"] = base["destination"]
        return reason

    def grant_answers(self, call: ToolCall, effect: ToolEffect) -> bool:
        # The webhook's ask is the org's, never one a person's "allow for this conversation" answers.
        if self._own(call, effect) == "ask":
            return False
        return isinstance(self.base, GrantAnswers) and self.base.grant_answers(call, effect)


__all__ = [
    "EXTERNAL_POLICY_RULE",
    "ExternalPolicyGuard",
    "ExternalVerdict",
    "PolicyConsultant",
    "PolicyQuestion",
    "PolicyWebhook",
    "PolicyWebhooks",
    "UnclearPolicyAnswer",
    "VERDICTS",
    "external_denial",
    "writes_outside",
]
