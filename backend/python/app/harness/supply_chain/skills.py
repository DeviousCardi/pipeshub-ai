"""Skill trust (C3.57, C6.34, AD-05): a skill imported from outside PipesHub is used only once a publisher's key
signed its bundle or an admin approved that exact bundle.

The review of each imported skill lives at ``/services/harness/supply-chain/skills/{orgId}/{name}``, written only
by the admin review route. Where a skill came from is PipesHub's record (``source`` in the skill's metadata: the
import route sets ``imported`` and every edit keeps it), never a claim of the package. A skill written in PipesHub,
or shipped by the release, is first party.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Final, Protocol, cast

import yaml

from harness_core.logs import HarnessLog
from harness_core.skills.types import SkillBundleUnavailable
from harness_core.supply_chain.reviews import attestation_of, state_of
from harness_core.supply_chain.skill_scan import scan_skill
from harness_core.supply_chain.trust import (
    ArtefactKind,
    ArtefactUntrusted,
    TrustRoots,
    TrustVerdict,
    decide_trust,
    parse_attestation,
)

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping

    from harness_core.engines.types import JsonValue

REVIEWS_ROOT: Final = "/services/harness/supply-chain/skills"
IMPORTED: Final = "imported"
_AGENT_LOOP: Final = "agent-loop"
_LOG = HarnessLog.named("app.harness.supply_chain")


class ReviewConfig(Protocol):
    async def get_config(
        self,
        key: str,
        default: Any = None,  # noqa: ANN401
        use_cache: bool = False,  # noqa: FBT001, FBT002
        *,
        raise_on_error: bool = False,
    ) -> Any: ...  # noqa: ANN401

    async def set_config(self, key: str, value: Any) -> bool: ...  # noqa: ANN401


class SkillUntrusted(SkillBundleUnavailable):
    """An imported skill no publisher signed and no admin approved at this content: never mounted or loaded."""

    reason = "skill_untrusted"

    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(message)
        self.code = code


def review_path(org_id: str, name: str) -> str:
    return f"{REVIEWS_ROOT}/{org_id}/{name}"


async def read_review(
    config: ReviewConfig, org_id: str, name: str
) -> dict[str, Any] | None:
    """The stored review; an unreadable store raises, so nothing is trusted on a guess."""
    document = await config.get_config(
        review_path(org_id, name), default=None, use_cache=False, raise_on_error=True
    )
    return cast("dict[str, Any]", document) if isinstance(document, dict) else None


def _mapping(value: object) -> dict[str, object]:
    return dict(cast("dict[str, object]", value)) if isinstance(value, dict) else {}


def skill_source(files: Mapping[str, bytes]) -> str:
    """Where the skill came from, as PipesHub recorded it in the bundle's SKILL.md metadata (``manual`` when unset,
    as the skill store reads it)."""
    content = files.get("SKILL.md", b"").decode("utf-8", errors="replace")
    if not content.startswith("---"):
        return "manual"
    parts = content.split("---", 2)
    try:
        front = yaml.safe_load(parts[1]) if len(parts) >= 3 else None
    except yaml.YAMLError:
        return IMPORTED
    source = _mapping(_mapping(_mapping(front).get("metadata")).get(_AGENT_LOOP)).get("source")
    return source if isinstance(source, str) and source else "manual"


def with_imported_source(content: str) -> str:
    """``content`` whose metadata says it was imported, whatever the package claimed (``builtin`` or ``manual``
    included): the import route is the one place that knows."""
    if not content.startswith("---"):
        raise ValueError("an imported SKILL.md has YAML frontmatter")
    parts = content.split("---", 2)
    if len(parts) < 3:
        raise ValueError("an imported SKILL.md has YAML frontmatter")
    loaded: object = yaml.safe_load(parts[1]) or {}
    if not isinstance(loaded, dict):
        raise ValueError("YAML frontmatter must be a mapping of key: value pairs")
    front = _mapping(cast("object", loaded))
    metadata = _mapping(front.get("metadata"))
    loop = _mapping(metadata.get(_AGENT_LOOP))
    loop["source"] = IMPORTED
    _ = loop.pop("status", None)
    metadata[_AGENT_LOOP] = loop
    front["metadata"] = metadata
    return f"---\n{yaml.safe_dump(front, sort_keys=False)}---{parts[2]}"


class SkillTrust:
    """``decide_trust`` for skills, over the org's stored reviews and the roots in force now."""

    def __init__(
        self, config: ReviewConfig, roots: Callable[[], TrustRoots] | None = None
    ) -> None:
        from app.harness.supply_chain.roots import trust_roots

        self._config = config
        self._roots = roots or trust_roots

    async def verdict(
        self, org_id: str, name: str, digest: str, files: Mapping[str, bytes]
    ) -> TrustVerdict:
        """How the skill at ``digest`` is trusted; ``ArtefactUntrusted`` when it is not."""
        if skill_source(files) != IMPORTED:
            return TrustVerdict("first_party")
        review = await read_review(self._config, org_id, name)
        stored = attestation_of(review, digest)
        attestation = parse_attestation(stored) if stored is not None else None
        return decide_trust(
            ArtefactKind.SKILL,
            name,
            digest,
            first_party=False,
            roots=self._roots(),
            attestation=attestation,
            review=state_of(review, digest),
        )

    async def check(
        self, org_id: str, name: str, digest: str, files: Mapping[str, bytes]
    ) -> None:
        """Refuses an untrusted skill as ``SkillUntrusted`` (logged), so every reader treats it as not there."""
        try:
            _ = await self.verdict(org_id, name, digest, files)
        except ArtefactUntrusted as refused:
            _LOG.warning(
                "supply_chain.skill_refused",
                orgId=org_id,
                skill=name,
                digest=digest,
                reasonCode=refused.reason,
            )
            raise SkillUntrusted(
                f"Skill {name!r} is not approved for use", code=refused.reason
            ) from None
        except Exception as exc:
            _LOG.warning(
                "supply_chain.skill_refused",
                orgId=org_id,
                skill=name,
                reasonCode="review_unreadable",
            )
            raise SkillUntrusted(
                f"Skill {name!r} could not be checked", code="review_unreadable"
            ) from exc

    async def standing(
        self, org_id: str, name: str, digest: str, files: Mapping[str, bytes]
    ) -> dict[str, JsonValue] | None:
        """What the skills page shows of an imported skill: whether agents may use it and why not; None for first
        party content, which needs no review."""
        if skill_source(files) != IMPORTED:
            return None
        try:
            verdict = await self.verdict(org_id, name, digest, files)
        except ArtefactUntrusted as refused:
            state = {
                "artefact_denied": "denied",
                "artefact_pending_review": "pending",
            }.get(refused.reason, "untrusted")
            return {
                "state": state,
                "reasonCode": refused.reason,
                "digest": digest,
                "findings": _findings(files),
            }
        return {
            "state": "trusted",
            "route": verdict.route,
            "digest": digest,
            "findings": _findings(files),
        }


def _findings(files: Mapping[str, bytes]) -> list[JsonValue]:
    return [f.as_json() for f in scan_skill(files)]  # type: ignore[misc]


__all__ = [
    "IMPORTED",
    "REVIEWS_ROOT",
    "ReviewConfig",
    "SkillTrust",
    "SkillUntrusted",
    "read_review",
    "review_path",
    "skill_source",
    "with_imported_source",
]
