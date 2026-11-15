"""Connect waits (WP-33, G-12) on the engine path beside the org's policy webhook (WP-35, G-40), as round 9 merged them.

R9-EP-5 an engine's first outside write of an unconnected item still waits for the connect when the org has a webhook:
        the gateway decides whether the call would run over a fresh policy that has asked the webhook about it, and
        the webhook is asked once for the call, not again when it runs.
R9-EP-6 a write the webhook refuses is refused at once, with its words, and nobody is asked to connect.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from harness_core.effects.external_policy import ExternalPolicyGuard, ExternalVerdict
from harness_core.interactions.connect import ConnectNeed
from harness_core.interactions.connect_wait import BridgeConnectWait
from harness_core.interactions.ports import RunBinding
from harness_core.testing.contracts.tool_endpoint import BINDING, build_endpoint, claims_for
from harness_core.testing.engines.gateway import FakeInteractionBridge
from tests.unit.harness_core.effects.test_ga20_external_policy import Consultant, Hooks

if TYPE_CHECKING:
    from harness_core.effects.types import ApprovalPolicy
    from harness_core.kernel.core.messages import ToolCall

RUN = RunBinding("org-1", "ses-1", "run-1")
JIRA = ConnectNeed("Jira", "toolset", "inst_jira_1")


class Gate:
    def need(self, call: ToolCall) -> ConnectNeed | None:
        return JIRA if call.name == "create" else None

    def declined(self, call: ToolCall) -> str:
        return "interaction_denied: Jira was not connected, so this call was not made"


def _webhook(consultant: Consultant):  # noqa: ANN202 - build_endpoint's guard
    def wrap(base: ApprovalPolicy) -> ApprovalPolicy:
        return ExternalPolicyGuard(base, Hooks(), consultant, "org-1", "run-1", lambda call: dict(call.arguments))

    return wrap


async def test_r9_ep5_an_outside_write_waits_for_the_connect_when_the_webhook_allows_it() -> None:
    bridge = FakeInteractionBridge()
    consultant = Consultant(ExternalVerdict("allow"))
    world = build_endpoint(
        needs_authentication=frozenset({"create"}),
        connect=BridgeConnectWait(bridge, RUN, Gate()),
        guard=_webhook(consultant),
    )
    result = await world.endpoint.call_tool(claims_for(BINDING), "create", {"q": "x"})
    assert result.disposition == "deferred" and len(bridge.requests) == 1 and world.runs == []
    assert len(consultant.questions) == 1


async def test_r9_ep5_a_connected_item_runs_with_the_webhooks_one_answer() -> None:
    consultant = Consultant(ExternalVerdict("allow"))
    world = build_endpoint(guard=_webhook(consultant), needs_authentication=frozenset())
    result = await world.endpoint.call_tool(claims_for(BINDING), "create", {"q": "x"})
    assert result.disposition == "executed" and world.runs == ["create"]
    assert len(consultant.questions) == 1


async def test_r9_ep6_a_write_the_webhook_refuses_is_refused_without_a_connect_wait() -> None:
    bridge = FakeInteractionBridge()
    consultant = Consultant(ExternalVerdict("deny", "No new issues today"))
    world = build_endpoint(
        needs_authentication=frozenset({"create"}),
        connect=BridgeConnectWait(bridge, RUN, Gate()),
        guard=_webhook(consultant),
    )
    result = await world.endpoint.call_tool(claims_for(BINDING), "create", {"q": "x"})
    assert (result.disposition, result.is_error) == ("denied", True)
    assert "No new issues today" in result.text
    assert bridge.requests == [] and world.runs == []
    assert len(consultant.questions) == 1
