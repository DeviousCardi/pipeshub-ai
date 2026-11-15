"""The image starts no agent-harness process unless the operator turns the harness on (ADR-OPS-06, R50-OFF).

process_monitor.sh runs as the image runs it, with /app pointed at a temporary tree and node/python replaced by stubs
that log their start; no Docker. Unset is the default an install upgraded from a release without the harness has.
"""

from __future__ import annotations

import contextlib
import os
import signal
import subprocess
from typing import TYPE_CHECKING

import pytest

from tests.support.settle import SETTLE_S
from tests.unit.deployment.test_process_monitor_stop import _tree, _wait_for

if TYPE_CHECKING:
    from pathlib import Path

WORKER = "app.harness_main"
MODEL_GATEWAY = "app.model_gateway_main"


def _started(tmp_path: Path, switch: dict[str, str]) -> str:
    script, log, stubs = _tree(tmp_path)
    out = tmp_path / "monitor.out"
    env = {"PATH": f"{stubs}:/usr/bin:/bin", "HOME": str(tmp_path), "CHECK_INTERVAL": "600", **switch}
    with out.open("w") as sink:
        monitor = subprocess.Popen(["bash", str(script)], env=env, stdout=sink, stderr=subprocess.STDOUT,
                                   start_new_session=True)
    try:
        assert _wait_for(lambda: "Beginning monitoring cycle" in out.read_text(), SETTLE_S), out.read_text()
        return log.read_text()
    finally:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(monitor.pid, signal.SIGKILL)


@pytest.mark.parametrize("switch", [{}, {"AGENT_HARNESS_WORKER_ENABLED": ""}, {"AGENT_HARNESS_WORKER_ENABLED": "false"}],
                         ids=["unset", "blank", "false"])
def test_with_the_harness_off_no_harness_process_starts(tmp_path: Path, switch: dict[str, str]) -> None:
    started = _started(tmp_path, switch)
    assert "app.query_main" in started and "dist/index.js" in started
    assert WORKER not in started
    assert MODEL_GATEWAY not in started


def test_with_the_harness_on_the_worker_and_its_model_gateway_start(tmp_path: Path) -> None:
    started = _started(tmp_path, {"AGENT_HARNESS_WORKER_ENABLED": "true"})
    assert WORKER in started
    assert MODEL_GATEWAY in started
