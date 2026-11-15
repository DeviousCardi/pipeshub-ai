"""Admin reviews of artefacts PipesHub stores and hashes itself: one decision per exact digest (ADR-SEC-01 D1, D4).

A review document holds, for one artefact (a skill, by name), the admin's decision on each digest they decided
(``approved`` or ``denied``), the publisher attestations submitted with it, and the history of decisions. Content
whose digest nobody decided is waiting for review: a change is a new digest, so every edit of third-party content
waits again, and ``last_approved`` is what its diff is shown against.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, Literal, cast

if TYPE_CHECKING:
    from collections.abc import Mapping

    from harness_core.engines.types import JsonValue

ReviewStateName = Literal["pending", "approved", "denied"]
REVIEW_SCHEMA: Final = "pipeshub.artefact-review/1"
HISTORY_LIMIT: Final = 50
# Decided digests kept: every approved one a run may still have pinned, and the latest denials.
VERSIONS_LIMIT: Final = 20


class FindingsNotAcknowledged(ValueError):
    """An approval of content the scanner flagged, without the admin acknowledging the findings."""

    reason_code = "artefact_findings_unacknowledged"


@dataclass(frozen=True, slots=True)
class ReviewState:
    digest: str
    state: ReviewStateName
    by: str = ""
    at: int = 0


def _section(
    document: Mapping[str, object] | None, name: str
) -> dict[str, dict[str, object]]:
    raw = (document or {}).get(name)
    if not isinstance(raw, dict):
        return {}
    return {
        str(k): dict(cast("dict[str, object]", v))
        for k, v in cast("dict[str, object]", raw).items()
        if isinstance(v, dict)
    }


def state_of(document: Mapping[str, object] | None, digest: str) -> ReviewState:
    """The admin's standing on ``digest``: ``pending`` until they decide it."""
    entry = _section(document, "versions").get(digest)
    state = entry.get("state") if entry is not None else None
    if entry is None or state not in ("approved", "denied"):
        return ReviewState(digest, "pending")
    return ReviewState(
        digest,
        cast("ReviewStateName", state),
        str(entry.get("by") or ""),
        int(cast("int", entry.get("at") or 0)),
    )


def last_approved(document: Mapping[str, object] | None) -> str | None:
    approved = [
        (int(cast("int", v.get("at") or 0)), d)
        for d, v in _section(document, "versions").items()
        if v.get("state") == "approved"
    ]
    return max(approved)[1] if approved else None


def attestation_of(
    document: Mapping[str, object] | None, digest: str
) -> Mapping[str, object] | None:
    return _section(document, "attestations").get(digest)


def _trimmed(versions: dict[str, dict[str, object]]) -> dict[str, dict[str, object]]:
    if len(versions) <= VERSIONS_LIMIT:
        return versions
    order = sorted(versions, key=lambda d: int(cast("int", versions[d].get("at") or 0)))
    keep = {d for d in order if versions[d].get("state") == "approved"} | set(
        order[-VERSIONS_LIMIT:]
    )
    return {d: v for d, v in versions.items() if d in keep}


def _document(
    document: Mapping[str, object] | None,
    subject: str,
    *,
    versions: dict[str, dict[str, object]] | None = None,
    attestations: dict[str, dict[str, object]] | None = None,
    event: dict[str, object],
) -> dict[str, object]:
    history = [*cast("list[object]", (document or {}).get("history") or []), event]
    return {
        "schema": REVIEW_SCHEMA,
        "subject": subject,
        "versions": _trimmed(
            versions if versions is not None else _section(document, "versions")
        ),
        "attestations": attestations
        if attestations is not None
        else _section(document, "attestations"),
        "history": history[-HISTORY_LIMIT:],
    }


def decided(
    document: Mapping[str, object] | None,
    *,
    subject: str,
    digest: str,
    approve: bool,
    by: str,
    at_ms: int,
    flagged: bool,
    acknowledge_findings: bool = False,
) -> dict[str, object]:
    """``document`` with the admin's decision on ``digest``. Approving content the scanner flagged needs the
    findings acknowledged, so a click that did not see them cannot enable it. A decision can be changed later; the
    history keeps each one."""
    if approve and flagged and not acknowledge_findings:
        raise FindingsNotAcknowledged(
            "the content scanner flagged this content; acknowledge its findings to approve it"
        )
    versions = _section(document, "versions")
    entry: dict[str, object] = {
        "state": "approved" if approve else "denied",
        "by": by,
        "at": at_ms,
    }
    if approve and flagged:
        entry["acknowledged"] = True
    versions[digest] = entry
    event: dict[str, object] = {
        "at": at_ms,
        "by": by,
        "action": entry["state"],
        "digest": digest,
    }
    return _document(document, subject, versions=versions, event=event)


def with_attestation(
    document: Mapping[str, object] | None,
    *,
    subject: str,
    digest: str,
    attestation: Mapping[str, JsonValue],
    by: str,
    at_ms: int,
) -> dict[str, object]:
    """``document`` holding a publisher's attestation for ``digest``, checked again at every use against the roots
    in force then, so removing a publisher's key withdraws what it signed."""
    attestations = _section(document, "attestations")
    attestations[digest] = dict(attestation)
    event: dict[str, object] = {
        "at": at_ms,
        "by": by,
        "action": "signed",
        "digest": digest,
    }
    return _document(document, subject, attestations=attestations, event=event)


__all__ = [
    "HISTORY_LIMIT",
    "REVIEW_SCHEMA",
    "FindingsNotAcknowledged",
    "ReviewState",
    "ReviewStateName",
    "attestation_of",
    "decided",
    "last_approved",
    "state_of",
    "with_attestation",
]
