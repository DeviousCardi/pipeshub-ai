"""WP-63 (AD-03): Node refuses a public-suffix wildcard (``*.co.uk``, ``*.github.io``) by the same public suffix list
the worker reads through ``tld``: the module Node imports is what ``app.scripts.public_suffixes_ts`` writes from it."""

from __future__ import annotations

from app.harness.flow_destination import registrable_domain
from app.scripts.public_suffixes_ts import OUTPUT, module, rules


def test_ad_03_the_committed_node_module_is_the_pinned_list() -> None:
    assert OUTPUT.read_text(encoding="utf-8") == module(), "run python -m app.scripts.public_suffixes_ts"


def test_ad_03_the_list_holds_the_suffixes_the_worker_reads() -> None:
    listed = set(rules())
    assert {"com", "co.uk", "github.io", "*.ck", "!www.ck"} <= listed
    assert registrable_domain("x.github.io") == "x.github.io"
    assert registrable_domain("docs.example.com") == "example.com"
