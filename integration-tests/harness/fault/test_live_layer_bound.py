"""NFR-23, NFR-37 (CPD-6; NTF-06, NTF-07, IX-NTF-PIN-2, IX-NTF-PIN-3) on real processes.

An org admin's approvals save is a control-plane write in Node: one transaction with its audit entry and outbox
row, published on ``control-plane-events``. A worker holding that org's live layer (``live_probe.py``: the
production ``worker_live_layer`` on the deployment's broker) must see the new revision within 5 s with the
notifier, and within the layer's 30 s time to live with the broker down, when the save itself must still succeed.
These bounds are the requirement's own wall-clock numbers, measured from the moment the save returned.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Any

import pytest

import stack

pytestmark = pytest.mark.fault

NOTIFIED_WITHIN_S = 5.0
LIVE_TTL_S = 30.0
# The probe reads the layer every 0.1 s: what it can add to a bound it is measured against.
PROBE_PERIOD_S = 0.2


# The `updatedAt` each session's last save answered (a save names the one it loaded), by the session's database.
_LOADED: dict[str, Any] = {}


def _save(session: stack.FaultStack, policy: dict[str, Any]) -> float:
    """The admin saves the org's approvals; when the save returned (the write is committed)."""
    database = session.env["MONGO_DB_NAME"]
    saved = stack.http(
        "PUT", f"/__fault/approvals/{stack.ORG}", {"policy": policy, "baseUpdatedAt": _LOADED.get(database)}
    )
    _LOADED[database] = saved.get("updatedAt")
    return time.time()


def _seen(out: Path) -> list[dict[str, Any]]:
    return stack.jsonl(out) if out.exists() else []


def _next_revision(out: Path, after: int, timeout: float) -> dict[str, Any]:
    found: list[dict[str, Any]] = []

    def arrived() -> bool:
        found[:] = [row for row in _seen(out) if row["revision"] > after and not row["stale"]]
        return bool(found)

    stack.wait_for(arrived, timeout, f"the live layer passing revision {after}")
    return found[0]


@pytest.fixture
def probe(fault_stack: stack.FaultStack, credential: str, tmp_path: Path):
    out = tmp_path / "live.jsonl"
    argv = [sys.executable, str(stack.HERE / "live_probe.py"), str(out), stack.ORG]
    process = stack.Process("live-probe", argv, stack.PYTHON_ROOT, fault_stack.env, tmp_path / "probe.log", "LIVE PROBE READY")
    process.start()
    yield out
    process.kill9()


def test_nfr23_a_tightening_reaches_a_workers_live_layer_within_5_s_with_the_notifier(
    fault_stack: stack.FaultStack, probe: Path
) -> None:
    held = _seen(probe)[-1]["revision"]

    saved_at = _save(fault_stack, {"org": {"writes": "deny"}, "agents": {}})
    seen = _next_revision(probe, held, NOTIFIED_WITHIN_S + 5)

    assert seen["at"] - saved_at <= NOTIFIED_WITHIN_S + PROBE_PERIOD_S


def test_nfr23_nfr37_with_the_broker_down_the_save_succeeds_and_reaches_the_live_layer_within_its_time_to_live(
    fault_stack: stack.FaultStack, probe: Path
) -> None:
    if fault_stack.broker != "kafka":
        pytest.skip("the redis broker is the rig's key-value store too: stopping it stops Node, not the notifier")
    held = _seen(probe)[-1]["revision"]
    # Paused, not stopped: the broker neither answers nor refuses, as behind a partition.
    stack.compose("--profile", "kafka", "pause", "kafka")
    try:
        saved_at = _save(fault_stack, {"org": {"writes": "ask"}, "agents": {}})
        seen = _next_revision(probe, held, LIVE_TTL_S + 15)
    finally:
        stack.compose("--profile", "kafka", "unpause", "kafka")

    assert seen["at"] - saved_at <= LIVE_TTL_S + PROBE_PERIOD_S
    assert seen["at"] - saved_at > NOTIFIED_WITHIN_S, "it was the time to live that carried it, not a late event"
