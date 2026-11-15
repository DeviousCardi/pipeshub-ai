"""DEV-ONLY: which coding engine the durable lane's engine agent runs on (``E2E_ENGINE``, run.sh durable).

    python3 engines.py image <kind>      the image every run of that engine uses (exit 1: not a release engine)
    python3 engines.py kinds             every release engine, the default first (QAFINAL-FU-ENG: the docker lane runs
                                         the engine job specs on each)

Read from the release allowlist (backend/python/harness_engines/allowlist.json), the file the worker and the broker
read, so the lane asks for the image a run really starts and a new engine version needs no edit here. Standard
library only: run.sh and seed.py run it on the host.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

ALLOWLIST = Path(__file__).resolve().parents[2] / "backend" / "python" / "harness_engines" / "allowlist.json"


def _entries() -> list[dict[str, Any]]:
    return json.loads(ALLOWLIST.read_text())["engines"]


def default_kind() -> str:
    """The release default: the allowlist's first engine, the one an agent with ``engineProfile {}`` runs on."""
    return str(_entries()[0]["kind"])


def kinds() -> list[str]:
    """Every release engine once, in the allowlist's order (the default first)."""
    return list(dict.fromkeys(str(e["kind"]) for e in _entries()))


def image(kind: str) -> str:
    """The image of the kind's first entry (the version new conversations start on)."""
    for entry in _entries():
        if entry["kind"] == kind:
            return str(entry["image"])
    kinds = sorted({str(e["kind"]) for e in _entries()})
    raise KeyError(f"E2E_ENGINE={kind} is not a release engine ({', '.join(kinds)})")


def profile(kind: str | None) -> dict[str, Any]:
    """The engine agent's ``engineProfile``: ``{}`` for the release default, so the default lane stores what it always
    did; another kind narrows the agent to that engine alone."""
    kind = kind or default_kind()
    image(kind)
    return {} if kind == default_kind() else {"engines": [kind]}


def org_ceiling(kind: str | None) -> dict[str, Any] | None:
    """The org's engine ceiling the lane sets before its engine agent: an ACP engine runs only where the org's admin
    names it (``optedIn``, engine-profiles.ts), so ``{"engines": [kind]}``; a native engine needs none."""
    kind = kind or default_kind()
    image(kind)
    return {"engines": [kind]} if kind.startswith("acp-") else None


def main(argv: list[str]) -> int:
    if argv == ["kinds"]:
        print("\n".join(kinds()))
        return 0
    if len(argv) != 2 or argv[0] != "image":
        print("usage: engines.py image <kind> | kinds", file=sys.stderr)
        return 2
    try:
        print(image(argv[1]))
    except KeyError as error:
        print(error.args[0], file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
