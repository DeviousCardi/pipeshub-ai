"""WP97-FU-1: the human-test seed (``deployment/e2e/seed_human.py``) enforces the release default for the org's approval class
rules. The stack's org layer held ``writes: ask``, set on the admin page at some point, so every engine write to the
person's own space asked there and its research runs measured governance, not the default. Node's admin route is a fake:
the seed's policy merge is what is under test, not the stack.
"""

from __future__ import annotations

import importlib
import json
import os
import sys
from pathlib import Path
from typing import Any

import pytest

REPO = Path(__file__).resolve().parents[5]
sys.path.insert(0, str(REPO / "deployment" / "e2e"))
for name, value in {
    "E2E_API": "http://127.0.0.1:9", "E2E_ADMIN_EMAIL": "admin@acme-demo.example", "E2E_ADMIN_PASSWORD": "x",
    "E2E_STATE": os.devnull, "E2E_MEMBER_FILE": os.devnull,
}.items():
    os.environ.setdefault(name, value)
seed_human = importlib.import_module("seed_human")

INSTANCE = "f6cf3be4"
TOOL = f"mcp@{INSTANCE}/create_ticket"
APPROVALS = "/api/v1/agent-harness/admin/approvals"


class FakeAdmin:
    """Node's approvals admin route over one stored policy."""

    def __init__(self, org: dict[str, Any]) -> None:
        self.policy: dict[str, Any] = {"org": org, "agents": {}}
        self.puts: list[dict[str, Any]] = []

    def call(self, method: str, path: str, body: dict[str, Any] | None = None, **_: object) -> tuple[Any, int]:
        assert path == APPROVALS
        if method == "PUT":
            assert body is not None
            self.puts.append(body)
            self.policy = json.loads(json.dumps(body["policy"]))
        return {"policy": json.loads(json.dumps(self.policy)), "updatedAt": 1}, 200


@pytest.fixture
def admin(monkeypatch: pytest.MonkeyPatch) -> FakeAdmin:
    fake = FakeAdmin({"tools": {TOOL: "ask"}, "writes": "ask", "flow": {"level": "ask"}})
    monkeypatch.setattr(seed_human, "call", fake.call)
    monkeypatch.setattr(seed_human, "save_state", lambda _state: None)
    return fake


def test_wp97_seed_1_an_org_writes_rule_the_seed_did_not_set_is_removed_and_logged(
    admin: FakeAdmin, capsys: pytest.CaptureFixture[str]
) -> None:
    seed_human.approvals("token", {"mcpInstanceId": INSTANCE})

    assert admin.policy["org"] == {"tools": {TOOL: "ask"}, "flow": {"level": "ask"}}, "the tool rule and flow stay"
    (logged,) = [json.loads(line) for line in capsys.readouterr().err.splitlines() if "seed.approvals_reset" in line]
    assert logged == {"event": "seed.approvals_reset", "removed": {"writes": "ask"}}


def test_wp97_seed_2_a_session_that_tests_governance_keeps_the_org_rules(admin: FakeAdmin) -> None:
    seed_human.approvals("token", {"mcpInstanceId": INSTANCE}, keep_org_rules=True)
    assert admin.puts == [], "nothing to change"
    assert admin.policy["org"]["writes"] == "ask"


def test_wp97_seed_3_every_class_rule_goes_and_a_stale_tool_rule_is_replaced() -> None:
    merged, removed = seed_human.org_rules(
        {"tools": {"mcp@old/create_ticket": "ask", "web@x/fetch": "deny"}, "classes": {"write": "ask"}, "writes": "deny"},
        TOOL,
        keep_org_rules=False,
    )
    assert merged == {"tools": {"web@x/fetch": "deny", TOOL: "ask"}}
    assert removed == {"classes": {"write": "ask"}, "writes": "deny"}


def test_wp97_seed_4_a_seeded_default_is_left_alone(admin: FakeAdmin) -> None:
    admin.policy["org"] = {"tools": {TOOL: "ask"}}
    seed_human.approvals("token", {"mcpInstanceId": INSTANCE})
    assert admin.puts == []


def test_wp97_seed_5_the_opt_in_is_a_flag_or_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[bool] = []
    monkeypatch.setattr(seed_human, "load_state", lambda: {"mcpInstanceId": INSTANCE})
    monkeypatch.setattr(seed_human, "sign_in", lambda: "token")
    for step in ("member", "knowledge", "restore_pages", "skill", "agents"):
        monkeypatch.setattr(seed_human, step, lambda *_a, **_k: None)
    monkeypatch.setattr(seed_human, "approvals", lambda _t, _s, *, keep_org_rules: seen.append(keep_org_rules))

    seed_human.main([])
    seed_human.main(["--keep-org-rules"])
    monkeypatch.setenv("E2E_KEEP_ORG_RULES", "1")
    seed_human.main([])

    assert seen == [False, True, True]
