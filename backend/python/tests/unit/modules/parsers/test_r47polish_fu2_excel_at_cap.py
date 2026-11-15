"""R47POLISH-FU-2: a workbook load that sits at its memory allowance is refused at once, not after the CPU limit.

At the cap pymalloc cannot map a new arena, so every small object falls back to malloc after a failed ``mmap``, and
each malloc that fails makes glibc try a new arena (a 128 MiB reservation, two ``munmap``s, a failing ``mprotect``)
before Python sees it; frees elsewhere let the next allocations succeed, so openpyxl went on at a crawl (40,000
``<mergeCell>`` at 38 MB: past 40 s in 2 runs of 3, memory flat at the cap, nearly all system time). The growth
watcher now interrupts a load that stays within two arenas of the cap for 0.3 s. These tests drive the watcher with a
reported data segment, so they do not depend on the host's allocator.
"""

from __future__ import annotations

import signal
import time

import pytest

from app.modules.parsers.excel import workbook_model as wm
from tests.support.excel_workbooks import workbook_zip

LIMIT = 64 * 1024 * 1024


def _slow_extract(_data: bytes) -> wm.WorkbookModel:
    """Python work that goes on until it is interrupted, as openpyxl does at the cap."""
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        sum(range(1000))
    raise AssertionError("the load was never interrupted")


def _at_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(wm._GrowthWatcher, "_vm_data_kb", staticmethod(lambda: 1 << 40))
    monkeypatch.setattr(wm, "_extract", _slow_extract)


@pytest.mark.skipif(not hasattr(signal, "SIGXCPU") or wm.resource is None, reason="POSIX only")
def test_a_load_that_sits_at_its_allowance_is_refused_within_a_second(monkeypatch: pytest.MonkeyPatch) -> None:
    _at_cap(monkeypatch)
    before = signal.getsignal(signal.SIGXCPU)
    # No CPU limit: only the watcher can stop the endless load (it would raise AssertionError after 20 s otherwise).
    with pytest.raises(wm.WorkbookRefused) as refused:
        wm.load_workbook_model(workbook_zip(""), LIMIT, LIMIT, None, None)
    assert refused.value.args[0] == "too_large"
    assert "stayed at its" in str(refused.value)
    assert signal.getsignal(signal.SIGXCPU) == before


@pytest.mark.skipif(not hasattr(signal, "SIGXCPU") or wm.resource is None, reason="POSIX only")
def test_a_watcher_that_cannot_read_its_sample_counts_as_at_the_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    def no_memory() -> int:
        raise MemoryError

    monkeypatch.setattr(wm._GrowthWatcher, "_vm_data_kb", staticmethod(no_memory))
    monkeypatch.setattr(wm, "_extract", _slow_extract)
    with pytest.raises(wm.WorkbookRefused, match="stayed at its"):
        wm.load_workbook_model(workbook_zip(""), LIMIT, LIMIT, None, 30)


def test_a_load_below_its_allowance_is_not_interrupted() -> None:
    before = signal.getsignal(signal.SIGXCPU) if hasattr(signal, "SIGXCPU") else None
    model = wm.load_workbook_model(workbook_zip('<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>'), LIMIT, LIMIT, None, 30)
    assert model.sheetnames == ["S"]
    if before is not None:
        assert signal.getsignal(signal.SIGXCPU) == before


class _Calls:
    def __init__(self) -> None:
        self.count = 0

    def __call__(self) -> None:
        self.count += 1


def _watcher(cap_kb: int = 100_000) -> tuple[wm._GrowthWatcher, _Calls]:
    watcher = wm._GrowthWatcher()
    calls = _Calls()
    watcher.arm(cap_kb * 1024, calls)
    return watcher, calls


def test_a_brief_touch_of_the_cap_is_not_a_stall() -> None:
    watcher, calls = _watcher()
    at, below = 100_000, 100_000 - 4096
    for t, kb in [(0.0, at), (0.1, at), (0.2, below), (0.3, at), (0.5, at), (0.59, at)]:
        watcher._watch_cap(kb, t)
    assert (calls.count, watcher.stalled) == (0, False)
    watcher._watch_cap(at, 0.61)
    watcher._watch_cap(at, 0.9)
    assert (calls.count, watcher.stalled) == (1, True)


def test_a_disarmed_watcher_never_interrupts() -> None:
    watcher, calls = _watcher()
    watcher.disarm()
    for t in (0.0, 1.0, 2.0):
        watcher._watch_cap(100_000, t)
    assert calls.count == 0
