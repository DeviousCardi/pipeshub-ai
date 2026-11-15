#!/usr/bin/env python3
"""Keeps this repository edition-neutral: a change adds no edition-only path, import or licence.

Other editions build on this repository through its extension points (see CONTRIBUTING.md, "Extension
points"); their own code lives in their own repositories. A change here therefore fails when it

1. adds a file under an ``ee/`` directory at any depth, or an edition-only build file
   (``Dockerfile.ee``, a workflow named ``*-ee.yml``, a deployment file named ``*.ee.*``);
2. adds an import of an ``ee`` package or directory (Python ``app.ee``; TypeScript ``@/ee/``, ``./ee/``,
   ``../ee/``);
3. adds a file to a directory that accepts fixes only (``FROZEN``);
4. adds a proprietary licence marker;
5. names a private edition repository, in an added line or a commit message: both are public once pushed;
6. adds a project-tracking document (a status board, a work log, evidence captures, work-package records, research
   or review notes) under ``docs/agent-harness-v2/``: the project's tracker is kept outside this repository, and
   only reference documents (design, decisions, operation, testing) ship here.

It warns, without failing, on a commit message or pull-request body that starts with an edition prefix or
carries a session trailer.

Standard library only, so CI and ``scripts/verify.sh`` run it with ``python3 -I`` before any install.

    python3 -I scripts/edition_guard.py --base origin/main      # the commits since the base
    python3 -I scripts/edition_guard.py --worktree              # what is not committed yet
"""

from __future__ import annotations

import argparse
import fnmatch
import re
import subprocess
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

EDITION_PATHS = (
    re.compile(r"(^|/)ee/"),
    re.compile(r"^Dockerfile\.ee$"),
    re.compile(r"^\.github/workflows/.*-ee\.ya?ml$"),
    re.compile(r"^deployment/.*\.ee\."),
)

PYTHON_SOURCES = (".py", ".pyi")
SCRIPT_SOURCES = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts")
PYTHON_IMPORTS = (
    re.compile(r"^\s*(?:from|import)\s+app\.ee(?:\.|\s|$)"),
    re.compile(r"""import_module\(\s*["']app\.ee(?:\.|["'])"""),
)
_EE_SPECIFIER = r"""["'](?:@/ee/|(?:\.{1,2}/)+ee/)"""
SCRIPT_IMPORTS = (
    re.compile(rf"\bfrom\s+{_EE_SPECIFIER}"),
    re.compile(rf"^\s*import\s+{_EE_SPECIFIER}"),
    re.compile(rf"\b(?:require|import)\(\s*{_EE_SPECIFIER}"),
)

# These directories accept fixes to what is there, never a new file.
FROZEN = (
    "backend/python/tests/evals/**",
    "backend/python/app/agent_loop_lib/eval/**",
    "backend/python/app/agents/agent_loop/evals/**",
    ".github/workflows/*eval*.yml",
    ".github/workflows/*eval*.yaml",
)

# The harness's project tracker and its review notes live outside this repository; these paths held them once and
# must not come back.
_V2 = r"^docs/agent-harness-v2/"
TRACKER_PATHS = (
    re.compile(_V2 + r"(STATUS|REMAINING|NEXT-PHASE|REPORT|REVIEW|PROJECT-PLAN|research)\.md$"),
    re.compile(_V2 + r"(SECURITY-PROGRAM|TESTING-GUIDE)\.md$"),
    re.compile(_V2 + r"(history|notes|research|pr|ui-revamp|classic-jobs|security)/"),
    re.compile(_V2 + r"impl/(?!tool-effects\.md$|mocks/)"),
    re.compile(r"^docs/agent-harness-pending-work\.md$"),
    re.compile(r"^docs/test-plan/wp/"),
    re.compile(r"^docs/test-plan/07-work-packages\.md$"),
    re.compile(r"^docs/agent-harness-design-review\.md$"),
)

# Split so this file does not carry the marker it looks for.
LICENCE_MARKER = "LicenseRef-" + "PipesHub-Proprietary"

# Built from parts so this file does not carry the name it looks for.
PRIVATE_REPOSITORY = re.compile(r"(?i)\bpipeshub-?ai" + r"-ee\b")

MESSAGE_PREFIX = re.compile(r"^\s*(?:ee:|EE-)")
SESSION_TRAILER = re.compile(r"^Claude-Session:", re.M)


@dataclass
class Report:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class AddedLine:
    path: str
    number: int
    text: str


def added_lines(diff: str) -> list[AddedLine]:
    """The lines a unified diff (``git diff -U0``) adds, with the file and line number each lands at."""
    out: list[AddedLine] = []
    path: str | None = None
    number = 0
    for line in diff.splitlines():
        if line.startswith("+++ "):
            target = line[4:].strip()
            path = None if target == "/dev/null" else target.removeprefix("b/")
        elif line.startswith("@@"):
            hunk = re.match(r"@@ -\d+(?:,\d+)? \+(\d+)", line)
            number = int(hunk.group(1)) if hunk else 0
        elif line.startswith("+") and path is not None:
            out.append(AddedLine(path, number, line[1:]))
            number += 1
    return out


def _frozen(path: str) -> bool:
    return any(fnmatch.fnmatchcase(path, pattern) for pattern in FROZEN)


def check(added_paths: Sequence[str], diff: str, messages: Sequence[str] = ()) -> Report:
    report = Report()
    for path in added_paths:
        if any(pattern.search(path) for pattern in EDITION_PATHS):
            report.errors.append(f"{path}: an edition-only path; it belongs in that edition's repository")
        if _frozen(path):
            report.errors.append(f"{path}: a new file in a directory that accepts fixes only")
        if any(pattern.search(path) for pattern in TRACKER_PATHS):
            report.errors.append(f"{path}: a project-tracking document; the tracker is kept outside this repository")
    for line in added_lines(diff):
        where = f"{line.path}:{line.number}"
        if line.path.endswith(PYTHON_SOURCES) and any(p.search(line.text) for p in PYTHON_IMPORTS):
            report.errors.append(f"{where}: imports an edition package; use an extension point instead")
        if line.path.endswith(SCRIPT_SOURCES) and any(p.search(line.text) for p in SCRIPT_IMPORTS):
            report.errors.append(f"{where}: imports an edition directory; use an extension point instead")
        if LICENCE_MARKER in line.text:
            report.errors.append(f"{where}: a proprietary licence marker; this repository's code is Apache-2.0")
        if PRIVATE_REPOSITORY.search(line.text):
            report.errors.append(f"{where}: names a private repository; say \"the enterprise edition\" instead")
    for message in messages:
        subject = message.strip().splitlines()[0] if message.strip() else ""
        if PRIVATE_REPOSITORY.search(message):
            report.errors.append(f"message {subject!r}: names a private repository")
        if MESSAGE_PREFIX.match(subject):
            report.warnings.append(f"message {subject!r}: starts with an edition prefix")
        if SESSION_TRAILER.search(message):
            report.warnings.append(f"message {subject!r}: carries a session trailer")
    return report


def _git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=REPO, check=True, capture_output=True, text=True).stdout


def _untracked() -> list[str]:
    return [p for p in _git("ls-files", "--others", "--exclude-standard").splitlines() if p]


def _untracked_diff(paths: list[str]) -> str:
    """An untracked file as a diff that adds every line of it."""
    parts: list[str] = []
    for path in paths:
        try:
            text = (REPO / path).read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        lines = text.splitlines()
        parts.append(f"+++ b/{path}\n@@ -0,0 +1,{len(lines)} @@\n" + "".join(f"+{line}\n" for line in lines))
    return "".join(parts)


def collect(base: str | None, worktree: bool) -> tuple[list[str], str, list[str]]:
    if worktree:
        untracked = _untracked()
        added = [p for p in _git("diff", "HEAD", "--name-only", "--no-renames", "--diff-filter=A").splitlines() if p]
        diff = _git("diff", "HEAD", "-U0", "--no-color", "--no-renames", "--diff-filter=AM")
        return [*added, *untracked], diff + _untracked_diff(untracked), []
    assert base is not None
    span = f"{base}...HEAD"
    added = [p for p in _git("diff", span, "--name-only", "--no-renames", "--diff-filter=A").splitlines() if p]
    diff = _git("diff", span, "-U0", "--no-color", "--no-renames", "--diff-filter=AM")
    messages = [m for m in _git("log", "--format=%B%x00", f"{base}..HEAD").split("\x00") if m.strip()]
    return added, diff, messages


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    where = parser.add_mutually_exclusive_group(required=True)
    where.add_argument("--base", help="check the commits since this ref (a pull request's base)")
    where.add_argument("--worktree", action="store_true", help="check what is not committed yet")
    parser.add_argument("--pr-body", type=Path, help="a file holding the pull request's body, to warn on")
    args = parser.parse_args(argv)
    added, diff, messages = collect(args.base, args.worktree)
    if args.pr_body is not None and args.pr_body.is_file():
        messages.append(args.pr_body.read_text(encoding="utf-8"))
    report = check(added, diff, messages)
    for warning in report.warnings:
        print(f"warning: {warning}")
    for error in report.errors:
        print(f"error: {error}")
    if report.errors:
        print(f"edition guard: {len(report.errors)} problem(s); see CONTRIBUTING.md, \"Extension points\"")
        return 1
    print("edition guard: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
