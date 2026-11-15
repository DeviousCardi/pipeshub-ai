"""DP7-MVP-1: the durable lane's engine option (``E2E_ENGINE=<kind> deployment/e2e/run.sh durable``).

The engine agent and a new default chat run on the release engine the option names; the lane asks for that engine's
run image from the allowlist, the file the worker and broker read. The running lane proves the rest; these keep the
wiring from drifting.
"""

from __future__ import annotations

import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[5]
E2E = REPO / "deployment" / "e2e"
RUN_SH = E2E / "run.sh"
ALLOWLIST = REPO / "backend" / "python" / "harness_engines" / "allowlist.json"
SCRIPTED_MODEL_TS = REPO / "frontend" / "tests" / "e2e" / "harness" / "support" / "scripted-model.ts"


@pytest.fixture(scope="module")
def engines():
    # Loaded by its path: `import engines` found the test packages of that name (tests/unit/harness/engines,
    # tests/unit/harness_core/engines) whenever an earlier test in the worker had imported one (R26-FU).
    spec = importlib.util.spec_from_file_location("e2e_engines", E2E / "engines.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _release() -> list[dict]:
    return json.loads(ALLOWLIST.read_text())["engines"]


def test_r25_el_1_each_kind_maps_to_the_run_image_of_its_first_allowlist_entry(engines) -> None:
    first: dict[str, str] = {}
    for entry in _release():
        first.setdefault(entry["kind"], entry["image"])
    assert first, "the allowlist lists no engine"
    for kind, image in first.items():
        assert engines.image(kind) == image
    with pytest.raises(KeyError, match="not a release engine"):
        engines.image("no-such-engine")


def test_r25_el_2_the_default_engine_keeps_the_empty_profile_and_another_narrows_to_itself(engines) -> None:
    default = _release()[0]["kind"]
    assert engines.default_kind() == default
    assert engines.profile(None) == {}
    assert engines.profile(default) == {}
    other = next(e["kind"] for e in _release() if e["kind"] != default)
    assert engines.profile(other) == {"engines": [other]}
    with pytest.raises(KeyError):
        engines.profile("no-such-engine")


def test_r25_el_3_the_cli_prints_the_image_or_fails() -> None:
    ok = subprocess.run([sys.executable, "-I", str(E2E / "engines.py"), "image", "claude_code"],
                        capture_output=True, text=True, check=False)
    assert ok.returncode == 0
    assert ok.stdout.strip() == next(e["image"] for e in _release() if e["kind"] == "claude_code")
    bad = subprocess.run([sys.executable, "-I", str(E2E / "engines.py"), "image", "nope"],
                         capture_output=True, text=True, check=False)
    assert bad.returncode == 1
    assert "not a release engine" in bad.stderr


def test_r25_el_4_run_sh_keeps_the_option_in_the_stack_env_and_passes_it_to_the_seed_and_the_specs() -> None:
    text = RUN_SH.read_text()
    assert re.search(r"^E2E_ENGINE=\$\{E2E_ENGINE:-\$\(default_engine\)\}$", text, re.M), "kept in the stack env"
    assert 'E2E_ENGINE="$(envv E2E_ENGINE)"' in text, "the seed's engine agent reads the stack's engine"
    assert '-e E2E_CODING_ENGINE="$(envv E2E_ENGINE)"' in text, "a new default chat is pinned to it"
    assert 'engines.py" image' in text, "the image check reads the allowlist"
    code = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))
    assert not re.search(r"pxh-(opencode|claude-code|codex)[\w-]*:", code), "no engine image is hard-coded"


def test_r25_el_5_the_specs_read_the_pinned_engine_from_the_variable_run_sh_sets() -> None:
    assert "env.E2E_CODING_ENGINE" in SCRIPTED_MODEL_TS.read_text()


def test_r25_el_6_the_specs_shell_tool_names_are_the_scripted_models() -> None:
    from harness_core.testing.engines.script import SHELL_TOOLS

    lane_ts = (REPO / "frontend" / "tests" / "e2e" / "harness" / "support" / "lane.ts").read_text()
    found = re.search(r"ENGINE_SHELL_TOOLS: readonly string\[\] = \[([^\]]*)\]", lane_ts)
    assert found, "ENGINE_SHELL_TOOLS is declared in lane.ts"
    assert set(re.findall(r"'([^']+)'", found.group(1))) == set(SHELL_TOOLS)


def test_qafinal_fu_eng_1_kinds_lists_each_release_engine_once_with_the_default_first(engines) -> None:
    kinds = engines.kinds()
    assert kinds[0] == engines.default_kind()
    assert sorted(kinds) == sorted({e["kind"] for e in _release()})
    assert len(kinds) == len(set(kinds))
    done = subprocess.run([sys.executable, "-I", str(E2E / "engines.py"), "kinds"], capture_output=True, text=True,
                          check=True)
    assert done.stdout.split() == kinds


def test_qafinal_fu_eng_2_each_engines_job_start_samples_keep_a_file_of_their_own() -> None:
    """The docker lane runs the job-start spec on every engine; one file name would let the last engine's samples
    replace the others' in the report folder."""
    spec = (REPO / "frontend" / "tests" / "e2e" / "qa" / "latency-engine.spec.ts").read_text()
    assert "process.env.E2E_CODING_ENGINE || DEFAULT_SCRIPTED_ENGINE" in spec
    assert "recordSamples(test.info(), `job-${ENGINE}`" in spec


def test_qafinal_fu_eng_3_an_acp_engine_is_named_in_the_org_ceiling_and_a_native_one_needs_none(engines) -> None:
    """An ACP engine runs only where the org's admin names it; without the ceiling the engine agent's create is
    refused (ENGINE_PROFILE_WIDENING, dimension engine), as the acp-opencode lane's seed was."""
    for kind in engines.kinds():
        ceiling = engines.org_ceiling(kind)
        assert ceiling == ({"engines": [kind]} if kind.startswith("acp-") else None), kind
    assert engines.org_ceiling(None) is None
    seed = (E2E / "seed.py").read_text()
    durable = seed[seed.index("def seed_durable"):seed.index("def seed_harness")]
    assert durable.index("admin/engine-profile") < durable.index('state["engineAgentKey"] = create_tool_agent(')
