# ruff: noqa: ANN401, ANN201, ANN202, ANN204
"""``unindex_record`` against a recording fake: what it removes, in which order, and that a failed run can be repeated."""
from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.modules.indexing.unindex import unindex_record

RECORD = {"_key": "rec-1", "orgId": "org-1", "virtualRecordId": "v-1"}
LINKS = [
    {"recordId": "rec-1", "collection": "categories", "entityId": "cat-1"},
    {"recordId": "rec-1", "collection": "topics", "entityId": "top-1"},
]


class Rig:
    def __init__(self, *, holders: list[str] | None = None, links: list | None = None) -> None:
        self.calls: list[str] = []
        graph = MagicMock()
        self.graph = graph

        def note(name: str, result: Any = None) -> AsyncMock:
            async def run(*_a: Any, **_kw: Any) -> Any:
                self.calls.append(name)
                if self.fail_at == name:
                    self.fail_at = None
                    raise RuntimeError(f"{name} failed")
                return result

            return AsyncMock(side_effect=run)

        self.fail_at: str | None = None
        graph.get_record_taxonomy_links = note("links", LINKS if links is None else links)
        graph.update_node = note("fields", True)
        graph.get_records_by_virtual_record_id = note("holders", ["rec-1"] if holders is None else holders)
        graph.stage_states_delete_for_virtual_records = note("stage_states", 1)
        self.processor = MagicMock()
        self.processor.graph_provider = graph
        self.processor._release_skipped_content = note("release")
        self.store = MagicMock()
        self.store.delete_entity = note("title_deleted")
        self.processor.sink_orchestrator.entity_vector_store = self.store
        self.clear_classification = note("classification")
        self.clear_for_record = note("mentions")
        self.points = note("taxonomy_points")

    async def run(self, record: dict | None = None) -> None:
        with (
            patch("app.modules.indexing.unindex.GraphDBTransformer") as transformer,
            patch("app.modules.indexing.unindex.NamedEntityGraphWriter") as writer,
            patch("app.modules.indexing.unindex.GraphDataStore"),
            patch("app.modules.indexing.unindex.delete_unreached_taxonomy_points", self.points),
        ):
            transformer.return_value.clear_classification = self.clear_classification
            writer.return_value.clear_for_record = self.clear_for_record
            await unindex_record(record or RECORD, "org-1", processor=self.processor, logger=MagicMock())


STEPS = ["links", "classification", "mentions", "fields", "holders", "stage_states", "release", "taxonomy_points"]


@pytest.mark.asyncio
async def test_every_step_runs_in_order_and_the_title_point_is_kept() -> None:
    rig = Rig()
    await rig.run()
    assert rig.calls == STEPS
    assert "title_deleted" not in rig.calls


@pytest.mark.asyncio
async def test_the_taxonomy_refs_are_read_before_any_edge_is_cleared_and_reach_the_point_cleanup() -> None:
    rig = Rig()
    await rig.run()
    assert rig.calls.index("links") < rig.calls.index("classification")
    refs = rig.points.await_args.args[-1]
    assert {r["id"] for r in refs} == {"cat-1", "top-1"}


@pytest.mark.asyncio
async def test_a_failed_taxonomy_read_deletes_nothing_and_the_retry_finds_the_refs() -> None:
    rig = Rig()
    rig.fail_at = "links"
    with pytest.raises(RuntimeError):
        await rig.run()
    assert rig.calls == ["links"]
    rig.calls.clear()
    await rig.run()
    assert rig.calls == STEPS
    assert rig.points.await_args.args[-1]


@pytest.mark.asyncio
@pytest.mark.parametrize("step", STEPS)
async def test_a_run_that_fails_at_any_step_is_completed_by_the_retry(step: str) -> None:
    rig = Rig()
    rig.fail_at = step
    with pytest.raises(RuntimeError):
        await rig.run()
    rig.calls.clear()
    await rig.run()
    assert rig.calls == STEPS


@pytest.mark.asyncio
async def test_a_twin_keeps_the_stage_states_but_the_vectors_and_content_release_runs() -> None:
    rig = Rig(holders=["rec-1", "twin-1"])
    await rig.run()
    assert "stage_states" not in rig.calls
    assert "release" in rig.calls


@pytest.mark.asyncio
async def test_a_record_with_no_vrid_skips_the_content_steps_only() -> None:
    rig = Rig()
    await rig.run({"_key": "rec-1", "orgId": "org-1"})
    assert rig.calls == ["links", "classification", "mentions", "fields", "taxonomy_points"]


@pytest.mark.asyncio
async def test_a_record_with_no_taxonomy_links_has_no_point_cleanup() -> None:
    rig = Rig(links=[])
    await rig.run()
    assert "taxonomy_points" not in rig.calls
