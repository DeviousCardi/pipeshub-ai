"""CPD10-43: with ``CONTROL_PLANE_POLICY_STORE=on`` no reader reads a KV policy document.

``on`` stops Node writing ``/services/agentHarness/{approvals,engineProfiles,modelAccess}``. The readers that could
still reach one (today's loop's flow guard, a run without a pin for its approvals and its engine governance, the model
gateway, an agent save's engine ceiling: AG1) are chosen by one mode check. In ``off`` and ``dual`` each reads its
document exactly as before; in ``on`` each answers from what Node resolved or from the org's live layer, and its
answer equals what it read from the same documents.

The live layers are Node's own bytes: ``contracts/harness/vectors/policy-store-live-layers.json`` is what Node's live
route serves for the documents of ``approvals.json`` and ``engine-profiles.json`` once the policy store holds them
(``backend/nodejs/apps/tests/modules/agent-harness/cpd10-store-on-live-layers.test.ts`` writes and checks it).
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any, Final, cast, get_args

import pytest

from app.agents.agent_loop.hooks.flow_guard import register_legacy_flow_guard
from app.agents.engine_settings import AgentEngineSettings
from app.config.constants.service import config_node_constants
from app.control_plane.contracts.generated.live_layer import (
    LiveLayer as LiveLayerDocument,
)
from app.control_plane.runtime.deployment import DeploymentLayer
from app.control_plane.runtime.live_layer import (
    LIVE_TTL_S,
    LiveLayerUnavailable,
    ReloadingLiveLayerCache,
)
from app.harness import policy_documents as mode
from app.harness.access.live_policies import LiveOrgAccessPolicies
from app.harness.policy_documents import (
    ENV_POLICY_STORE,
    KV,
    LIVE,
    InvalidPolicyStoreMode,
    ResolvedPolicyRequired,
    policy_documents,
    policy_store_mode,
)
from app.harness.run_policy.select import (
    RunPolicies,
    engine_profiles,
    legacy_flow_rules,
    org_access_policies,
)
from app.harness.run_policy.stored import StoredEngineCeilings, StoredRunPolicy
from app.harness.unpinned import (
    ConfiguredApprovals,
    ConfiguredEngineCeilings,
    ConfiguredOrgAccessPolicies,
    UnpinnedRunPolicy,
)
from harness_core.access.errors import AccessPolicyUnavailable
from harness_core.access.types import AccessRouteRef
from harness_core.contracts.generated.sink import SinkDescriptor
from harness_core.effects.flow import FlowRule
from harness_core.effects.types import EffectKind, ToolEffect, refresh_policy
from harness_core.engines.errors import (
    ProfileCeilingUnavailable,
    ProfileInvalid,
    ProfileWidening,
)
from harness_core.engines.profiles import constraint_from_wire, profile_digest
from harness_core.kernel.core.messages import ToolCall
from harness_core.kernel.hooks.registry import HookRegistry
from harness_core.logs import HarnessLog
from harness_core.testing import ManualClock
from harness_core.testing.contracts.engine_profiles import (
    CeilingEnv,
    EngineCeilingSourceContract,
)
from harness_core.testing.engines.durable import engine_profile
from tests.cohesion.support import REPO_ROOT
from tests.support.config_service import FakeConfigurationService
from tests.support.harness_edition import default_harness_edition  # noqa: F401 - the fixture, used by name

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

    from app.harness.run_policy.ports import RunPolicy

VECTORS: Final = REPO_ROOT / "contracts" / "harness" / "vectors"
SERVED: Final[list[dict[str, Any]]] = json.loads((VECTORS / "policy-store-live-layers.json").read_text(encoding="utf-8"))["cases"]
APPROVAL_VECTORS: Final[dict[str, dict[str, Any]]] = {
    vector["id"]: vector for vector in json.loads((VECTORS / "approvals.json").read_text(encoding="utf-8"))["documents"]
}
ENGINE_VECTORS: Final[dict[str, dict[str, Any]]] = {
    vector["id"]: vector for vector in json.loads((VECTORS / "engine-profiles.json").read_text(encoding="utf-8"))["cases"]
}

APPROVALS: Final = config_node_constants.AGENT_HARNESS_APPROVALS.value
ENGINE_PROFILES: Final = config_node_constants.AGENT_HARNESS_ENGINE_PROFILES.value
MODEL_ACCESS: Final = config_node_constants.AGENT_HARNESS_MODEL_ACCESS.value
KV_DOCUMENTS: Final = {"approvals": APPROVALS, "engineProfiles": ENGINE_PROFILES, "modelAccess": MODEL_ACCESS}

LOG: Final = HarnessLog.named("tests.cpd10.store_on")
ACCESS: Final = AccessRouteRef("route", "digest")
CALL: Final = ToolCall(id="c", name="t", arguments={})
SINK: Final = SinkDescriptor(egress="external", args_leave_boundary=True)
EFFECT_KINDS: Final[tuple[EffectKind, ...]] = get_args(EffectKind)
# A tool no vector names, beside the ones they do: a class rule and a tool rule are both exercised.
UNNAMED_TOOL: Final = "jira@inst/unnamed"

MODES: Final = ["off", "dual", "on"]
READERS: Final = ["flow_guard", "unpinned_approvals", "unpinned_engine_governance", "model_access", "ag1"]
# The document each reader reads while the KV documents are the record.
READS: Final = {
    "flow_guard": APPROVALS,
    "unpinned_approvals": APPROVALS,
    "unpinned_engine_governance": ENGINE_PROFILES,
    "model_access": MODEL_ACCESS,
    "ag1": ENGINE_PROFILES,
}


class KvPolicyDocumentRead(AssertionError):
    """A reader read a KV policy document nobody writes any more."""


class Config(FakeConfigurationService):
    """The configuration store holding a case's KV policy documents; once ``retired`` (Node stopped writing them),
    reading one is recorded and fails. The readers catch what a read raises and fail closed, so every case also
    asserts ``policy_reads``."""

    def __init__(self, documents: dict[str, Any]) -> None:
        super().__init__({KV_DOCUMENTS[name]: document for name, document in documents.items()})
        self.retired = False
        self.policy_reads: list[str] = []

    async def get_config(self, key: str, default: Any = None, use_cache: bool = False, *, raise_on_error: bool = False) -> Any:  # noqa: ANN401
        if key in KV_DOCUMENTS.values():
            self.policy_reads.append(key)
            if self.retired:
                raise KvPolicyDocumentRead(key)
        return await super().get_config(key, default, use_cache, raise_on_error=raise_on_error)


class LiveRoute:
    """Node's internal live route (``LiveLayerSource``), serving what the vector says Node serves."""

    def __init__(self, served: dict[str, Any] | None) -> None:
        self._served = served
        self.up = True
        self.loads = 0

    async def load(self, org_id: str, since: int | None) -> LiveLayerDocument | None:
        self.loads += 1
        if not self.up or self._served is None:
            raise LiveLayerUnavailable("the internal live route is unreachable")
        assert self._served["orgId"] == org_id
        if since == self._served["revision"]:
            return None
        return LiveLayerDocument.model_validate(self._served)


class World:
    """One case's documents, in KV and as Node serves them from the policy store, and the readers over both."""

    def __init__(self, case: dict[str, Any]) -> None:
        self.org: str = case["orgId"]
        self.agent: str | None = case["agentKey"]
        self.config = Config(case["documents"])
        self.route = LiveRoute(case["live"])
        self.live = ReloadingLiveLayerCache(self.route, ManualClock())

    def run_policy(self) -> RunPolicy:
        """The policy of a run admitted without a pin, as a worker's composition root selects it."""
        run = SimpleNamespace(
            resolved=None, org_id=self.org, agent=None if self.agent is None else SimpleNamespace(agent_key=self.agent)
        )
        services = SimpleNamespace(config_service=lambda: self.config)
        return RunPolicies(services, live=self.live).for_run(run, LOG)  # type: ignore[arg-type]

    async def flow_rules(self, resolved: tuple[FlowRule, ...] | None) -> tuple[FlowRule, ...]:
        return await legacy_flow_rules(self.config, org_id=self.org, agent_key=self.agent, resolved=resolved, log=LOG)  # type: ignore[arg-type]


def _case(case_id: str) -> dict[str, Any]:
    return next(case for case in SERVED if case["id"] == case_id)


def _served(source: str) -> list[Any]:
    """The cases of ``source`` Node can serve from the store (a document its readers refuse is never copied)."""
    return [pytest.param(case, id=case["id"]) for case in SERVED if case["source"] == source and case["live"] is not None]


@pytest.fixture
def store_mode(monkeypatch: pytest.MonkeyPatch) -> Iterator[Callable[[str | None], None]]:
    """Starts a process with ``CONTROL_PLANE_POLICY_STORE`` set to a value (``None``: unset)."""

    def start(value: str | None) -> None:
        if value is None:
            monkeypatch.delenv(ENV_POLICY_STORE, raising=False)
        else:
            monkeypatch.setenv(ENV_POLICY_STORE, value)
        policy_store_mode.cache_clear()

    # The deployment's own flow rule off: the cases compare what the documents and the layers say.
    monkeypatch.setenv("HARNESS_FLOW_GUARD", "false")
    start(None)
    yield start
    policy_store_mode.cache_clear()


def _effects(tools: list[str]) -> list[ToolEffect]:
    return [ToolEffect(tool, kind, False, SINK) for tool in [*tools, UNNAMED_TOOL] for kind in EFFECT_KINDS]


async def _decisions(world: World, effects: list[ToolEffect], *, engine: bool) -> list[str]:
    policy = world.run_policy()
    approvals = await policy.approvals()
    rules = await policy.engine_governance(approvals, engine_profile()) if engine else approvals.rules
    return [rules(CALL, effect) for effect in effects]


# The mode


@pytest.mark.parametrize(
    ("value", "expected", "documents"),
    [
        (None, "dual", KV),
        ("", "dual", KV),
        ("  ", "dual", KV),
        ("dual", "dual", KV),
        (" Dual ", "dual", KV),
        ("OFF", "off", KV),
        ("on", "on", LIVE),
        (" On ", "on", LIVE),
    ],
)
def test_cpd10_43_the_mode_is_parsed_as_node_parses_it(
    store_mode: Callable[[str | None], None], value: str | None, expected: str, documents: str
) -> None:
    store_mode(value)

    assert policy_store_mode() == expected
    assert policy_documents() == documents


@pytest.mark.parametrize("value", ["shadow", "true", "1", "enabled", "o n"])
def test_cpd10_43_a_value_the_switch_does_not_know_refuses_instead_of_reading_on_a_guess(
    store_mode: Callable[[str | None], None], value: str
) -> None:
    store_mode(value)

    with pytest.raises(InvalidPolicyStoreMode, match=ENV_POLICY_STORE):
        _ = policy_documents()
    with pytest.raises(InvalidPolicyStoreMode):
        _ = RunPolicies(SimpleNamespace(), deployment=DeploymentLayer())  # type: ignore[arg-type]
    assert mode.InvalidPolicyStoreMode.reason_code == "invalid_policy_store_mode"


def test_cpd10_43_the_mode_is_read_once_per_process(
    store_mode: Callable[[str | None], None], monkeypatch: pytest.MonkeyPatch
) -> None:
    store_mode("on")
    assert policy_documents() == LIVE

    monkeypatch.setenv(ENV_POLICY_STORE, "off")

    assert policy_documents() == LIVE, "a deployment changes it with a restart, as Node reads it at boot"


# Mode × reader: where each reader reads


async def _read(world: World, reader: str) -> None:
    """One read by ``reader`` as production makes it."""
    if reader == "flow_guard":
        context = SimpleNamespace(
            previous_conversations=[], tool_state={}, config_service=world.config, org_id=world.org, agent_key=world.agent
        )
        _ = await register_legacy_flow_guard(HookRegistry(), context)
    elif reader == "unpinned_approvals":
        _ = await world.run_policy().approvals()
    elif reader == "unpinned_engine_governance":
        policy = world.run_policy()
        _ = await policy.engine_governance(await policy.approvals(), engine_profile())
    elif reader == "model_access":
        _ = await org_access_policies(world.config, lambda: world.live, pin_on=False).policy(world.org)  # type: ignore[arg-type]
    else:
        resolver = engine_profiles(world.config, lambda: world.live)  # type: ignore[arg-type]
        _ = await resolver.resolve_engine_profile(world.org, None, None, access=ACCESS)


@pytest.mark.parametrize("reader", READERS)
@pytest.mark.parametrize("store", MODES)
async def test_cpd10_43_mode_by_reader_the_document_while_it_is_the_record_and_never_once_the_store_is(
    store_mode: Callable[[str | None], None], store: str, reader: str
) -> None:
    store_mode(store)
    world = World(_case("D-4"))
    world.config.retired = store == "on"

    if store == "on" and reader == "flow_guard":
        # Today's loop holds no live layer: without the turn's resolved rules the request is refused.
        with pytest.raises(ResolvedPolicyRequired):
            await _read(world, reader)
    else:
        await _read(world, reader)

    if store == "on":
        assert world.config.policy_reads == []
        assert world.route.loads == (0 if reader == "flow_guard" else 1)
    else:
        assert READS[reader] in world.config.policy_reads
        assert set(world.config.policy_reads) <= {APPROVALS, READS[reader]}
        assert world.route.loads == 0, "nothing joins or calls the live route while the documents are the record"


@pytest.mark.usefixtures("default_harness_edition")
@pytest.mark.parametrize("store", MODES)
async def test_cpd10_43_mode_by_reader_which_policy_a_run_without_a_pin_gets(
    store_mode: Callable[[str | None], None], store: str
) -> None:
    store_mode(store)

    policy = World(_case("D-4")).run_policy()

    # No placement rule in this build: the policy is handed out as it is.
    assert isinstance(policy, StoredRunPolicy if store == "on" else UnpinnedRunPolicy)
    assert policy.pinned is False and policy.stages() is None


@pytest.mark.parametrize("pin_on", [False, True])
@pytest.mark.parametrize("store", MODES)
def test_cpd10_43_the_gateway_reads_the_live_layer_with_the_pin_on_or_the_store_as_the_record(
    store_mode: Callable[[str | None], None], store: str, pin_on: bool
) -> None:
    store_mode(store)
    world = World(_case("MA-2"))

    policies = org_access_policies(world.config, lambda: world.live, pin_on=pin_on)  # type: ignore[arg-type]

    live = pin_on or store == "on"
    assert isinstance(policies, LiveOrgAccessPolicies if live else ConfiguredOrgAccessPolicies)


# Equality: the same documents, read from KV in ``dual`` and from Node's live layer in ``on``


@pytest.mark.parametrize("case", _served("approvals.json"))
async def test_cpd10_43_a_run_without_a_pin_decides_from_the_live_layer_as_it_did_from_the_approvals_document(
    store_mode: Callable[[str | None], None], case: dict[str, Any]
) -> None:
    vector = APPROVAL_VECTORS[case["id"]]
    effects = _effects(sorted(vector["effective"]["tools"]))

    store_mode("dual")
    documents = World(case)
    from_documents = await _decisions(documents, effects, engine=False)
    flow_from_documents = (await documents.run_policy().approvals()).flow_rules

    store_mode("on")
    stored = World(case)
    stored.config.retired = True
    from_live = await _decisions(stored, effects, engine=False)
    flow_from_live = (await stored.run_policy().approvals()).flow_rules

    assert from_live == from_documents
    assert flow_from_live == flow_from_documents
    assert stored.config.policy_reads == []
    # Both are the vector's answer, which Node's reader of the document shares.
    expected_flow = tuple(FlowRule(rule["level"], rule["above"]) for rule in vector["effective"].get("flow", []))
    assert flow_from_live == expected_flow
    for effect, decision in zip(effects, from_live, strict=True):
        by_class = vector["effective"]["classes"][effect.effect]
        by_tool = vector["effective"]["tools"].get(effect.tool_id, "allow")
        assert decision == max(by_class, by_tool, key=["allow", "ask", "deny"].index), effect


@pytest.mark.parametrize("case", [*_served("approvals.json"), *_served("engine-profiles.json")])
async def test_cpd10_43_an_engine_run_without_a_pin_is_governed_from_the_live_layer_as_from_the_documents(
    store_mode: Callable[[str | None], None], case: dict[str, Any]
) -> None:
    effects = _effects([])

    store_mode("dual")
    documents = World(case)
    from_documents = await _decisions(documents, effects, engine=True)
    assert ENGINE_PROFILES in documents.config.policy_reads

    store_mode("on")
    stored = World(case)
    stored.config.retired = True

    assert await _decisions(stored, effects, engine=True) == from_documents
    assert stored.config.policy_reads == []


@pytest.mark.parametrize("case", _served("approvals.json"))
async def test_cpd10_43_todays_loop_refuses_by_the_resolved_flow_rules_as_it_did_by_the_approvals_document(
    store_mode: Callable[[str | None], None], case: dict[str, Any]
) -> None:
    store_mode("dual")
    documents = World(case)
    from_documents = await documents.flow_rules(None)
    assert documents.config.policy_reads == [APPROVALS]

    store_mode("on")
    stored = World(case)
    stored.config.retired = True
    # What Node resolves for the turn and signs into X-PipesHub-Resolved: the resolved approvals' flow rules.
    resolved = (await stored.run_policy().approvals()).flow_rules
    from_resolved = await stored.flow_rules(resolved)

    assert stored.config.policy_reads == []
    if case["id"] in UNREADABLE_DEPLOYMENT_SECTIONS:
        # Today's loop reads a layer it cannot read as a flow rule that asks; the resolved approvals carry it as
        # writes that ask, which today's loop does not apply. Recorded for the header's `flow` claim (CPD-10 §3).
        assert from_documents == (FlowRule("ask"),) and from_resolved == ()
    else:
        assert from_resolved == from_documents


# Documents whose deployment sections today's readers cannot read: Node serves them as rules that ask for writes.
UNREADABLE_DEPLOYMENT_SECTIONS: Final = frozenset(
    case["id"]
    for case in SERVED
    if case["source"] == "approvals.json" and case["live"] is not None and APPROVAL_VECTORS[case["id"]]["status"] == "invalid"
)


@pytest.mark.parametrize("case", [_case("D-F1"), _case("D-F4"), _case("D-2")], ids=["D-F1", "D-F4", "D-2"])
async def test_cpd10_43_the_deployments_own_flow_rule_joins_a_run_without_a_pin_in_both_sources(
    store_mode: Callable[[str | None], None], monkeypatch: pytest.MonkeyPatch, case: dict[str, Any]
) -> None:
    monkeypatch.setenv("HARNESS_FLOW_GUARD", "true")
    monkeypatch.setenv("HARNESS_FLOW_GUARD_LEVEL", "deny")
    monkeypatch.setenv("HARNESS_FLOW_GUARD_ABOVE", "private")

    store_mode("dual")
    from_documents = (await World(case).run_policy().approvals()).flow_rules
    store_mode("on")
    from_live = (await World(case).run_policy().approvals()).flow_rules

    assert from_live == from_documents
    assert FlowRule("deny", "private") in from_live


async def test_cpd10_43_resolved_flow_rules_are_met_with_the_deployments_own_in_every_mode(
    store_mode: Callable[[str | None], None], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HARNESS_FLOW_GUARD", "true")
    monkeypatch.setenv("HARNESS_FLOW_GUARD_ABOVE", "private")
    for store in MODES:
        store_mode(store)
        world = World(_case("D-F1"))
        world.config.retired = True

        rules = await world.flow_rules((FlowRule("deny", "private"),))

        assert rules == (FlowRule("deny", "private"),), "the deployment's ask from private is covered by the deny"
        assert await world.flow_rules(()) == (FlowRule("ask", "private"),)
        assert world.config.policy_reads == [], "a request that carries its resolved rules reads no document"


@pytest.mark.parametrize("case", _served("inline"))
async def test_cpd10_43_the_model_gateway_narrows_from_the_live_layer_as_from_the_model_access_document(
    store_mode: Callable[[str | None], None], case: dict[str, Any]
) -> None:
    store_mode("dual")
    documents = World(case)
    from_document = await org_access_policies(documents.config, lambda: documents.live, pin_on=False).policy(documents.org)  # type: ignore[arg-type]
    assert documents.config.policy_reads == [MODEL_ACCESS]

    store_mode("on")
    stored = World(case)
    stored.config.retired = True
    from_live = await org_access_policies(stored.config, lambda: stored.live, pin_on=False).policy(stored.org)  # type: ignore[arg-type]

    assert from_live == from_document
    assert stored.config.policy_reads == []


async def _ag1(world: World, vector: dict[str, Any]) -> dict[str, Any]:
    """An agent save's check of its engine profile under the org's ceiling, as the route's resolver answers it."""
    layers = vector["layers"]
    try:
        profile = await engine_profiles(world.config, lambda: world.live).resolve_engine_profile(  # type: ignore[arg-type]
            world.org,
            constraint_from_wire(layers["agent"]) if "agent" in layers else None,
            constraint_from_wire(layers["request"]) if "request" in layers else None,
            access=ACCESS,
        )
    except ProfileWidening as refused:
        return {"refused": "widening", "dimension": refused.field, "layer": refused.layer}
    except ProfileInvalid:
        return {"refused": "invalid"}
    return {"profileDigest": profile_digest(profile)}


@pytest.mark.parametrize("case", _served("engine-profiles.json"))
async def test_cpd10_43_an_agent_save_is_checked_under_the_live_layers_ceiling_as_under_the_documents(
    store_mode: Callable[[str | None], None], case: dict[str, Any]
) -> None:
    vector = ENGINE_VECTORS[case["id"]]

    store_mode("dual")
    documents = World(case)
    from_document = await _ag1(documents, vector)
    ceiling = await ConfiguredEngineCeilings(documents.config).ceiling(documents.org)  # type: ignore[arg-type]
    assert ceiling == constraint_from_wire(vector["layers"]["org"])

    store_mode("on")
    stored = World(case)
    stored.config.retired = True

    assert await _ag1(stored, vector) == from_document
    assert await StoredEngineCeilings(stored.live).ceiling(stored.org) == ceiling
    assert stored.config.policy_reads == []


async def test_cpd10_43_an_org_without_a_ceiling_has_none_in_the_live_layer_either(
    store_mode: Callable[[str | None], None],
) -> None:
    store_mode("on")
    world = World(_case("D-4"))

    assert await StoredEngineCeilings(world.live).ceiling(world.org) is None


# Fail closed


async def test_cpd10_43_a_live_layer_that_cannot_be_read_asks_before_a_write_as_for_a_pinned_run(
    store_mode: Callable[[str | None], None],
) -> None:
    store_mode("on")
    world = World(_case("D-2"))
    world.config.retired = True
    world.route.up = False
    policy = world.run_policy()

    governance = policy.live((await policy.approvals()).rules)
    # The effect runner refreshes a live policy before it decides.
    await refresh_policy(governance)

    by_kind = {kind: governance(CALL, ToolEffect(UNNAMED_TOOL, kind, False, SINK)) for kind in EFFECT_KINDS}
    assert by_kind == {"read": "allow", "workspace": "allow", "write": "ask", "execute": "ask"}
    assert world.config.policy_reads == []

    world.route.up = True
    world.live = ReloadingLiveLayerCache(world.route, ManualClock())
    reachable = world.run_policy()
    governance = reachable.live((await reachable.approvals()).rules)
    await refresh_policy(governance)
    assert {governance(CALL, ToolEffect(UNNAMED_TOOL, kind, False, SINK)) for kind in EFFECT_KINDS} == {"allow"}


async def test_cpd10_43_a_tightening_reaches_a_run_without_a_pin_within_its_attempt(
    store_mode: Callable[[str | None], None],
) -> None:
    store_mode("on")
    world = World(_case("D-2"))
    policy = world.run_policy()
    governance = policy.live((await policy.approvals()).rules)
    write = ToolEffect(UNNAMED_TOOL, "write", False, SINK)
    await refresh_policy(governance)
    assert governance(CALL, write) == "allow"

    world.route._served = _case("D-3")["live"] | {"revision": 2}  # pyright: ignore[reportPrivateUsage]
    world.live.on_change(SimpleNamespace(org_id=world.org, revision=2, previous=1))  # type: ignore[arg-type]
    await refresh_policy(governance)

    assert governance(CALL, write) == "ask"


async def test_cpd10_43_the_gateway_and_an_agent_save_refuse_on_a_live_layer_that_cannot_be_read(
    store_mode: Callable[[str | None], None],
) -> None:
    store_mode("on")
    world = World(_case("EV-2"))
    world.config.retired = True
    world.route.up = False

    with pytest.raises(AccessPolicyUnavailable):
        _ = await org_access_policies(world.config, lambda: world.live, pin_on=False).policy(world.org)  # type: ignore[arg-type]
    with pytest.raises(ProfileCeilingUnavailable):
        _ = await engine_profiles(world.config, lambda: world.live).resolve_engine_profile(  # type: ignore[arg-type]
            world.org, None, None, access=ACCESS
        )
    assert world.config.policy_reads == []


async def test_cpd10_43_two_layers_that_set_the_orgs_ceiling_refuse_the_save(store_mode: Callable[[str | None], None]) -> None:
    store_mode("on")
    case = _case("EV-2")
    ceiling = next(scoped for scoped in case["live"]["layers"] if "engineProfile" in scoped["layer"])
    world = World({**case, "live": {**case["live"], "layers": [*case["live"]["layers"], ceiling]}})

    with pytest.raises(ProfileInvalid, match="more than one layer"):
        _ = await StoredEngineCeilings(world.live).ceiling(world.org)


async def test_cpd10_43_todays_loop_without_resolved_rules_is_refused_and_registers_no_guard(
    store_mode: Callable[[str | None], None],
) -> None:
    store_mode("on")
    world = World(_case("D-F1"))
    world.config.retired = True
    hooks = HookRegistry()
    context = SimpleNamespace(
        previous_conversations=[], tool_state={}, config_service=world.config, org_id=world.org, agent_key=world.agent
    )

    with pytest.raises(ResolvedPolicyRequired) as refused:
        _ = await register_legacy_flow_guard(hooks, context)

    assert refused.value.reason_code == "resolved_required"
    assert world.config.policy_reads == []
    assert context.tool_state == {}, "nothing watches a request that was refused"

    context.resolved_flow_rules = (FlowRule("ask"),)
    assert await register_legacy_flow_guard(hooks, context) is True
    context.resolved_flow_rules = ()
    assert await register_legacy_flow_guard(HookRegistry(), context) is False
    assert world.config.policy_reads == []


def test_cpd10_43_the_agent_loop_context_carries_the_resolved_flow_rules() -> None:
    from app.agents.agent_loop.context import AgentContext

    rules = (FlowRule("deny", "private"),)

    assert AgentContext.from_chat_state({"org_id": "o", "user_id": "u"}).resolved_flow_rules is None
    assert AgentContext.from_chat_state({"org_id": "o", "user_id": "u", "resolved_flow_rules": rules}).resolved_flow_rules == rules
    assert AgentContext.from_chat_state({"org_id": "o", "user_id": "u", "resolved_flow_rules": ()}).resolved_flow_rules == ()


async def test_cpd10_43_a_kv_reader_reached_past_the_selection_reads_nothing_and_fails_closed(
    store_mode: Callable[[str | None], None],
) -> None:
    store_mode("on")
    world = World(_case("D-4"))
    world.config.retired = True
    write = ToolEffect(UNNAMED_TOOL, "write", False, SINK)

    approvals = await ConfiguredApprovals(world.config).policy(org_id=world.org, agent_key=world.agent, log=LOG)  # type: ignore[arg-type]
    assert approvals(CALL, write) == "ask"
    with pytest.raises(ProfileCeilingUnavailable):
        _ = await ConfiguredEngineCeilings(world.config).ceiling(world.org)  # type: ignore[arg-type]
    with pytest.raises(AccessPolicyUnavailable):
        _ = await ConfiguredOrgAccessPolicies(world.config).policy(world.org)  # type: ignore[arg-type]

    assert world.config.policy_reads == []


def test_cpd10_43_a_run_without_a_pin_and_without_a_live_layer_is_refused_never_read_from_kv(
    store_mode: Callable[[str | None], None],
) -> None:
    store_mode("on")
    run = SimpleNamespace(resolved=None, org_id="org-1", agent=None)

    with pytest.raises(ResolvedPolicyRequired):
        _ = RunPolicies(SimpleNamespace(), deployment=DeploymentLayer()).for_run(run, LOG)  # type: ignore[arg-type]


# The port's contract on the live-layer adapter (C-2)


class _StoredCeilings:
    """``CeilingEnv`` over the live layer: an admin's save reaches the org layer Node serves and names the org in a
    change event, as every control-plane write does."""

    def __init__(self) -> None:
        self._clock = ManualClock()
        self._ceilings: dict[str, Any] = {}
        self._revisions: dict[str, int] = {}
        self._up = True
        self._live = ReloadingLiveLayerCache(self, self._clock)

    @property
    def source(self) -> StoredEngineCeilings:
        return StoredEngineCeilings(self._live)

    async def load(self, org_id: str, since: int | None) -> LiveLayerDocument | None:
        if not self._up:
            raise LiveLayerUnavailable("the internal live route is unreachable")
        revision = self._revisions.get(org_id, 0)
        if since == revision:
            return None
        layer: dict[str, Any] = {"schemaVersion": 1, "scope": {"kind": "live"}}
        if org_id in self._ceilings:
            layer["engineProfile"] = self._ceilings[org_id]
        return LiveLayerDocument.model_validate(
            {"schemaVersion": 1, "orgId": org_id, "revision": revision, "layers": [{"layer": layer}], "revokedBindings": []}
        )

    async def store(self, org_id: str, ceiling: Any) -> None:  # noqa: ANN401
        if ceiling is None:
            _ = self._ceilings.pop(org_id, None)
        else:
            self._ceilings[org_id] = ceiling
        revision = self._revisions.get(org_id, 0) + 1
        self._revisions[org_id] = revision
        self._live.on_change(SimpleNamespace(org_id=org_id, revision=revision, previous=revision - 1))  # type: ignore[arg-type]

    async def store_raw(self, org_id: str, raw: Any) -> None:  # noqa: ANN401
        await self.store(org_id, raw)

    def break_reads(self) -> None:
        """The live route is gone for longer than a held layer may be answered from."""
        self._up = False
        _ = self._clock.advance(LIVE_TTL_S)


class TestStoredEngineCeilingsContract(EngineCeilingSourceContract):
    @pytest.fixture
    def ceiling_env(self) -> CeilingEnv:
        return _StoredCeilings()


# AG1 through the route's own function and the process's one live layer


class _Refused(Exception):
    pass


async def _save(world: World, body: dict[str, Any], claimer: object | None) -> object:
    from app.api.routes import agent as routes

    state = SimpleNamespace() if claimer is None else SimpleNamespace(harness_inline=claimer)
    request = SimpleNamespace(
        app=SimpleNamespace(state=state, container=SimpleNamespace(config_service=lambda: world.config)),
        state=SimpleNamespace(user={"role": "admin", "isAdmin": True}),
    )
    services: dict[str, Any] = {"config_service": world.config}
    return await routes._agent_engine_settings(request, services, world.org, "agent-1", body, None)  # type: ignore[arg-type]  # pyright: ignore[reportPrivateUsage]


@pytest.mark.parametrize("store", MODES)
async def test_cpd10_43_ag1_the_agent_save_route_checks_under_the_same_ceiling_in_every_mode(
    store_mode: Callable[[str | None], None], monkeypatch: pytest.MonkeyPatch, store: str
) -> None:
    from app.api.routes import agent as routes

    monkeypatch.setattr(routes, "is_request_admin", lambda request: True)
    store_mode(store)
    # The org admits one engine only: an agent that names another is refused, one that names it is stored.
    world = World(_case("EV-2"))
    world.config.retired = store == "on"
    claimer = SimpleNamespace(live_layer=lambda: world.live)
    admitted = cast("str", _case("EV-2")["documents"]["engineProfiles"]["orgs"][world.org]["ceiling"]["engines"][0])
    other = "opencode" if admitted != "opencode" else "codex"

    stored = await _save(world, {"engineProfile": {"engines": [admitted]}}, claimer)
    with pytest.raises(routes.AgentError) as refused:
        _ = await _save(world, {"engineProfile": {"engines": [other]}}, claimer)

    assert stored == AgentEngineSettings({"engines": [admitted]}, None)
    assert "ENGINE_PROFILE_WIDENING" in str(refused.value.detail)
    if store == "on":
        assert world.config.policy_reads == [] and world.route.loads == 1
    else:
        assert world.config.policy_reads == [ENGINE_PROFILES, ENGINE_PROFILES] and world.route.loads == 0


async def test_cpd10_43_the_query_service_has_one_live_layer_shared_with_its_inline_claimer(
    store_mode: Callable[[str | None], None],
) -> None:
    from app.api.routes.harness import inline_claimer
    from app.harness.inline import InlineClaimer

    store_mode("on")
    world = World(_case("EV-2"))
    container = SimpleNamespace(config_service=lambda: world.config, logger=lambda: None)
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(), container=container))

    claimer = inline_claimer(request)  # type: ignore[arg-type]
    layer = claimer.live_layer()

    assert isinstance(claimer, InlineClaimer)
    assert inline_claimer(request) is claimer and claimer.live_layer() is layer  # type: ignore[arg-type]
    await claimer.aclose()
