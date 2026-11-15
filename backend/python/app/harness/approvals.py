"""The durable run's approval policy as its rules give it (P2.6c, P2.11e, SEC1, UX2): pure, nothing read here.

A pinned run's rules come from its pin (``app.harness.run_policy``); a run admitted without one reads the
document below per attempt (``app.harness.unpinned``, until the flip). The document
(``contracts/harness/ext/pipeshub/approvals-document.schema.json``; Node writes an org's sections through its admin
route)::

    {"default": {"writes": "ask"},                                # every org (operator)
     "orgs": {"<orgId>": {"writes": "ask", "flow": {"level": "ask"}}},  # flow: SEC1's rule, per org (SEC2)
     "agents": {"<agentKey>": {"tools": {"<toolId>": "deny"}}},   # deployment-wide (operator)
     "orgAgents": {"<orgId>": {"<agentKey>": {"writes": "deny"}}},
     "updated": {"<orgId>": {"updatedAt": 0, "updatedBy": "..."}}}

An edition's schema overlay may add top-level maps (orgId -> entry) that Node keeps beside the rules; the worker reads
none of them, and the generated model names them, so they are known keys here. Layers apply in that order and may only
narrow (``LayeredApprovalPolicy``). Absent, a run is ``allow`` for every
class. A document whose top level the schema refuses fails closed to ``WRITES_ASK`` as a whole; a layer that
cannot be read fails closed alone. Both logged once; Node reads the same document by the same rule
(``contracts/harness/vectors/approvals.json``).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Final, cast

from app.harness.contracts.generated.pipeshub.approvals_document import PipeshubApprovalsDocument
from app.harness.flow_destination import pipeshub_destination
from harness_core.effects.flow import (
    ENGINE_WRITES_RULE,
    DefaultAskPolicy,
    FlowGuardedPolicy,
    FlowRule,
)
from harness_core.effects.policy import (
    WRITES_ASK,
    ApprovalConfigInvalid,
    ApprovalRules,
    LayeredApprovalPolicy,
    RuleLayer,
    parse_rules,
)
from harness_core.engines.policy import profile_rules

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence

    from pydantic import JsonValue

    from harness_core.effects.flow import (
        AskDestination,
        ConversationGrants,
        GrantingLedger,
    )
    from harness_core.effects.types import ApprovalPolicy, ToolEffect
    from harness_core.engines.types import EngineProfile
    from harness_core.kernel.core.messages import ToolCall
    from harness_core.logs import HarnessLog
    from harness_core.security.labels import SourceLedger


# What a layer or document that cannot be read decides: writes ask, as ``WRITES_ASK``. Its own object, so today's loop,
# which applies only the flow layers, can tell that an org rule it cannot see may be on (FG2).
UNREADABLE_LAYER: Final = ApprovalRules(classes=dict(WRITES_ASK.classes))


def _layer(raw: JsonValue, layer: str, log: HarnessLog) -> ApprovalRules:
    try:
        return parse_rules(raw)
    except ApprovalConfigInvalid as refused:
        log.warning("approvals.config_invalid", reasonCode=refused.reason_code, layer=layer)
        return UNREADABLE_LAYER


# The schema's top-level keys, with those an edition's overlay adds (x-extensible); every one but `default` is a map.
_SECTIONS: Final = frozenset(field.alias or name for name, field in PipeshubApprovalsDocument.model_fields.items())
_MAPS: Final = _SECTIONS - {"default"}


def _document(document: JsonValue, log: HarnessLog) -> Mapping[str, JsonValue] | None:
    """The document when its top level is the schema's, else ``None`` (logged)."""
    if not isinstance(document, Mapping):
        log.warning("approvals.config_invalid", reasonCode="approval_rules_not_object", layer="document")
        return None
    doc = cast("Mapping[str, JsonValue]", document)
    if set(doc) - _SECTIONS:
        log.warning("approvals.config_invalid", reasonCode="approval_document_unknown_key", layer="document")
        return None
    if any(not isinstance(doc[section], Mapping) for section in _MAPS & set(doc)):
        log.warning("approvals.config_invalid", reasonCode="approval_rules_not_object", layer="document")
        return None
    return doc


def _entry(doc: Mapping[str, JsonValue], section: str, key: str) -> JsonValue:
    return cast("Mapping[str, JsonValue]", doc.get(section, {})).get(key)


def approval_policy(
    document: JsonValue, *, org_id: str, agent_key: str | None, log: HarnessLog
) -> LayeredApprovalPolicy:
    if document is None:
        return LayeredApprovalPolicy()
    doc = _document(document, log)
    if doc is None:
        return LayeredApprovalPolicy((UNREADABLE_LAYER,), ("deployment",))
    layers = [_layer(doc.get("default"), "default", log), _layer(_entry(doc, "orgs", org_id), "orgs", log)]
    # Whose rule each layer is on the approval card (QA6-F6); an agent's rules are its own or the org's for it.
    scopes: list[RuleLayer] = ["deployment", "org"]
    if agent_key is not None:
        layers.append(_layer(_entry(doc, "agents", agent_key), "agents", log))
        scopes.append("agent")
        org_agents = _entry(doc, "orgAgents", org_id)
        if org_agents is not None and not isinstance(org_agents, Mapping):
            log.warning("approvals.config_invalid", reasonCode="approval_rules_not_object", layer="orgAgents")
            layers.append(UNREADABLE_LAYER)
            scopes.append("agent")
        elif org_agents is not None:
            rule = cast("Mapping[str, JsonValue]", org_agents).get(agent_key)
            layers.append(_layer(rule, "orgAgents", log))
            scopes.append("agent")
    return LayeredApprovalPolicy(tuple(layers), tuple(scopes))


def flow_guarded(
    policy: ApprovalPolicy,
    *,
    rules: Sequence[FlowRule],
    ledger: SourceLedger | None,
    run_id: str,
    log: HarnessLog,
    destination: Callable[[ToolCall, ToolEffect], AskDestination | None] | None = None,
    grants: ConversationGrants | None = None,
) -> ApprovalPolicy:
    """``policy`` narrowed by the run's flow ``rules`` over what ``ledger`` says the run has read; unchanged when
    there is none. With ``destination`` and ``grants`` (the loop), a person may allow one destination for the
    conversation."""
    if not rules or ledger is None:
        return policy
    for rule in rules:
        log.info("approvals.flow_guard", level=rule.level, above=rule.above)
        policy = FlowGuardedPolicy(policy, rule, ledger, run_id, log, destination=destination, grants=grants)
    return policy


def engine_guarded(
    default: ApprovalPolicy,
    governance: ApprovalPolicy,
    *,
    rules: Sequence[FlowRule],
    ledger: GrantingLedger,
    run_id: str,
    log: HarnessLog,
) -> ApprovalPolicy:
    """An engine run's approvals (UX2): the org's and agent's rules (``governance``) under the flow ``rules``, and
    the engine's safety default (``ENGINE_APPROVALS`` with its profile's). A person may answer the flow rule and
    the default for the conversation, per tool and destination; the org's rules are never granted."""
    guarded = flow_guarded(
        governance,
        rules=rules,
        ledger=ledger,
        run_id=run_id,
        log=log,
        destination=pipeshub_destination,
        grants=ledger.grants,
    )
    return DefaultAskPolicy(
        guarded,
        default,
        ENGINE_WRITES_RULE,
        ledger,
        run_id,
        destination=pipeshub_destination,
        grants=ledger.grants,
        log=log,
    )


def governed(org_policy: LayeredApprovalPolicy, profile: EngineProfile, ceiling: ApprovalRules) -> LayeredApprovalPolicy:
    """An engine run's governance (QA10-F3): the org's and agent's approval rules, narrowed by what the run's
    engine profile narrows below the release default and by the classes the org's profile ceiling names (the
    pinned profile cannot show a restated release value). Never granted; only ``ENGINE_APPROVALS`` is the
    default."""
    return org_policy.narrowed(profile_rules(profile), "engine").narrowed(ceiling, "org")


__all__ = [
    "UNREADABLE_LAYER",
    "approval_policy",
    "engine_guarded",
    "flow_guarded",
    "governed",
]
