"""Source metadata an edition reads onto a record (``SourceMetadataReader``) is kept in ``Record.edition_fields`` and
stored as one ``editionFields`` map: written only once set, a key the source dropped written as null so the merging
upsert clears it, and read back from either store (Neo4j holds the map as JSON text).

SMD-1..SMD-6.
"""

from __future__ import annotations

import json

from app.config.constants.arangodb import Connectors, OriginTypes
from app.connectors.core.base.source_metadata import (
    apply_source_metadata,
    held_metadata,
    metadata_changed,
)
from app.models.entities import (
    EDITION_FIELDS_KEY,
    Record,
    RecordType,
    clean_edition_fields,
    edition_fields_of,
)
from app.schema.arango.documents import record_schema
from app.schema.node_schema_registry import JSON_ENCODED_FIELDS


def _record(**fields: object) -> Record:
    return Record(
        record_name="one.pdf",
        record_type=RecordType.FILE,
        external_record_id="ext-1",
        version=1,
        origin=OriginTypes.CONNECTOR,
        connector_name=Connectors.GOOGLE_DRIVE,
        connector_id="c1",
        **fields,
    )


def test_smd1_a_record_without_edition_fields_writes_no_key() -> None:
    record = _record()
    assert record.edition_fields is None
    assert EDITION_FIELDS_KEY not in record.to_arango_base_record()
    assert apply_source_metadata(record, None, {"gone": None}) is False
    assert record.edition_fields is None
    assert "edition_fields" not in record.model_dump(exclude_none=True)


def test_smd2_a_new_records_fields_are_written_and_a_none_is_not() -> None:
    record = _record()
    assert apply_source_metadata(record, None, {"tag": "One", "gone": None}) is False, "a new record is not a change"
    assert record.edition_fields == {"tag": "One"}
    assert record.to_arango_base_record()[EDITION_FIELDS_KEY] == {"tag": "One"}


def test_smd3_a_key_the_source_dropped_is_written_as_null_and_reads_back_absent() -> None:
    existing = _record(edition_fields={"tag": "One", "kept": 1})
    record = _record()
    assert apply_source_metadata(record, existing, {"kept": 1}) is True
    stored = record.to_arango_base_record()[EDITION_FIELDS_KEY]
    assert stored == {"tag": None, "kept": 1}
    assert edition_fields_of({EDITION_FIELDS_KEY: stored}) == {"kept": 1}


def test_smd4_unchanged_fields_are_no_change() -> None:
    existing = _record(edition_fields={"tag": "One"})
    record = _record()
    assert apply_source_metadata(record, existing, held_metadata(existing)) is False
    assert record.edition_fields == {"tag": "One"}
    assert metadata_changed(existing, {"tag": "Two"}) is True
    assert metadata_changed(None, {"tag": "Two"}) is False


def test_smd5_fields_read_back_from_a_map_or_its_json_text() -> None:
    assert edition_fields_of({EDITION_FIELDS_KEY: json.dumps({"tag": "One", "x": None})}) == {"tag": "One"}
    assert edition_fields_of({EDITION_FIELDS_KEY: "not json"}) is None
    assert edition_fields_of({EDITION_FIELDS_KEY: ["tag"]}) is None
    assert edition_fields_of({}) is None
    assert clean_edition_fields({1: "x", "tag": "One"}) == {"tag": "One"}


def test_smd6_the_record_schema_admits_the_map_and_neo4j_decodes_it() -> None:
    assert record_schema["rule"]["properties"][EDITION_FIELDS_KEY] == {"type": ["object", "null"]}
    assert EDITION_FIELDS_KEY in JSON_ENCODED_FIELDS["records"]
