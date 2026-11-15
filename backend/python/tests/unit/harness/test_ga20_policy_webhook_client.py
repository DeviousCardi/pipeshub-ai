"""GA-20 / G-40: the worker's side of the org's policy webhook, as Node's admin API stores it.

PW-1 the setting is read where Node keeps it, with errors raised (an unreadable store denies, never reads as "no
     webhook"), kept for a short TTL, and only an enabled webhook is asked.
PW-1b before Node has moved the webhooks to their own document, they are read from the document they shared with
     other settings; once that document exists, even empty, the old one is not read.
PW-2 the question is one POST of JSON to the checked address, with the admin's header and the original Host; the
     answer's decision and reason are read.
PW-3 a non-2xx answer (a redirect included) raises, and so does an answer without a decision it understands: the
     guard denies both.
PW-4 loopback, link-local and metadata addresses are refused before any request.
PW-5 a run is wrapped only when its org has a webhook on, or the setting cannot be read (then it denies).
WP39-DR-1 the question says whether the run is a dry run (``dryRun``), and the guard is built with the run's gate.
"""

from __future__ import annotations

import dataclasses
import json

import httpx
import pytest

from app.harness.external_policy import (
    ConfiguredPolicyWebhooks,
    HttpPolicyConsultant,
    PolicyWebhookSettingInvalid,
    external_policy_guarded,
    org_policy_webhooks,
    webhook_of,
)
from app.utils.url_fetcher import FetchError
from harness_core.effects.external_policy import (
    ExternalPolicyGuard,
    ExternalVerdict,
    PolicyQuestion,
    PolicyWebhook,
    UnclearPolicyAnswer,
)
from harness_core.logs import HarnessLog

QUESTION = PolicyQuestion("org-1", "run-1", "inv-1", "send@x/send_mail", "write_external", {"to": "a@example.com"})


def _document(enabled: bool = True) -> dict[str, object]:
    return {
        "orgs": {
            "org-1": {
                "policyWebhook": {
                    "enabled": enabled,
                    "url": "https://203.0.113.10/decide",
                    "timeoutMs": 2500,
                    "authHeader": {"name": "X-Key", "value": "k-1"},
                },
                "updatedAt": 1,
                "updatedBy": "p_admin",
            }
        },
        "movedAt": 1,
    }


POLICY_WEBHOOK = "/services/agentHarness/policyWebhook"
SHARED_BEFORE = "/services/agentHarness/securityExport"


class FakeConfig:
    """One document under the webhook's key; ``shared`` is the document the webhooks were kept in before."""

    def __init__(self, document: object, *, shared: object = None) -> None:
        self.document = document
        self.shared = shared
        self.reads: list[dict[str, object]] = []

    async def get_config(self, key: str, **options: object) -> object:
        self.reads.append({"key": key, **options})
        found = self.document if key == POLICY_WEBHOOK else self.shared if key == SHARED_BEFORE else None
        if isinstance(found, Exception):
            raise found
        return found


async def test_pw1_the_setting_is_read_strictly_kept_briefly_and_only_an_enabled_hook_counts() -> None:
    now = [0.0]
    config = FakeConfig(_document())
    hooks = ConfiguredPolicyWebhooks(config, clock=lambda: now[0])  # type: ignore[arg-type]

    hook = await hooks.webhook("org-1")
    assert hook == PolicyWebhook("https://203.0.113.10/decide", 2.5, ("X-Key", "k-1"))
    assert config.reads == [{"key": POLICY_WEBHOOK, "use_cache": False, "raise_on_error": True}]
    assert await hooks.webhook("org-2") is None
    assert len(config.reads) == 1
    now[0] = 16.0
    config.document = _document(enabled=False)
    assert await hooks.webhook("org-1") is None
    assert len(config.reads) == 2

    config.document = RuntimeError("kv down")
    now[0] = 40.0
    with pytest.raises(RuntimeError):
        await hooks.webhook("org-1")
    assert webhook_of(None, "org-1") is None
    with pytest.raises(PolicyWebhookSettingInvalid):
        webhook_of({"orgs": {"org-1": {"policyWebhook": {"enabled": True, "url": 7}}}}, "org-1")


async def test_pw1b_before_the_move_the_shared_document_is_read_and_after_it_never() -> None:
    now = [0.0]
    config = FakeConfig(None, shared=_document())
    hooks = ConfiguredPolicyWebhooks(config, clock=lambda: now[0])  # type: ignore[arg-type]
    assert await hooks.webhook("org-1") == PolicyWebhook("https://203.0.113.10/decide", 2.5, ("X-Key", "k-1"))
    assert [read["key"] for read in config.reads] == [POLICY_WEBHOOK, SHARED_BEFORE]
    assert config.reads[1] == {"key": SHARED_BEFORE, "use_cache": False, "raise_on_error": True}

    now[0] = 16.0
    config.document = {"orgs": {}, "movedAt": 1}
    config.reads.clear()
    assert await hooks.webhook("org-1") is None
    assert [read["key"] for read in config.reads] == [POLICY_WEBHOOK]

    now[0] = 32.0
    config.document = None
    config.shared = RuntimeError("kv down")
    with pytest.raises(RuntimeError):
        await hooks.webhook("org-1")


def _consultant(handler: object) -> HttpPolicyConsultant:
    return HttpPolicyConsultant(httpx.MockTransport(handler), allow_private=True)  # type: ignore[arg-type]


async def test_pw2_one_post_to_the_checked_address_with_the_admins_header() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"decision": "deny", "reason": "  holds a   customer list "})

    hook = PolicyWebhook("https://203.0.113.10/decide", 2.0, ("X-Key", "k-1"))
    verdict = await _consultant(handler).ask(hook, QUESTION)

    assert verdict == ExternalVerdict("deny", "holds a customer list")
    [request] = seen
    assert request.method == "POST"
    assert request.url.host == "203.0.113.10"
    assert request.headers["X-Key"] == "k-1"
    assert json.loads(request.content) == {
        "orgId": "org-1",
        "runId": "run-1",
        "invocationId": "inv-1",
        "toolId": "send@x/send_mail",
        "risk": "write_external",
        "arguments": {"to": "a@example.com"},
        "dryRun": False,
    }


async def test_wp39_dr1_the_question_tells_the_webhook_a_dry_run_is_one() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"decision": "allow"})

    hook = PolicyWebhook("https://203.0.113.10/decide", 2.0)
    await _consultant(handler).ask(hook, dataclasses.replace(QUESTION, dry_run=True))
    [request] = seen
    assert json.loads(request.content)["dryRun"] is True


@pytest.mark.parametrize(
    ("response", "error"),
    [
        (httpx.Response(500, json={"decision": "allow"}), httpx.HTTPStatusError),
        (httpx.Response(302, headers={"location": "https://elsewhere.example.com/"}), httpx.HTTPStatusError),
        (httpx.Response(200, text="yes"), UnclearPolicyAnswer),
        (httpx.Response(200, json={"decision": "maybe"}), UnclearPolicyAnswer),
    ],
)
async def test_pw3_anything_but_a_clear_2xx_answer_raises(response: httpx.Response, error: type[Exception]) -> None:
    hook = PolicyWebhook("https://203.0.113.10/decide", 2.0)
    with pytest.raises(error):
        await _consultant(lambda request: response).ask(hook, QUESTION)


@pytest.mark.parametrize(
    "url", ["https://169.254.169.254/latest", "https://127.0.0.1/x", "http://203.0.113.10/x"]
)
async def test_pw4_unsafe_endpoints_are_refused_before_any_request(url: str) -> None:
    sent: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(200, json={"decision": "allow"})

    with pytest.raises((FetchError, ValueError)):
        await _consultant(handler).ask(PolicyWebhook(url, 2.0), QUESTION)
    assert sent == []


async def test_pw5_a_run_is_wrapped_only_when_its_org_has_a_webhook_on_or_the_setting_cannot_be_read() -> None:
    log = HarnessLog.named("test")

    def allow(call: object, effect: object) -> str:
        return "allow"

    assert await org_policy_webhooks(FakeConfig(None), "org-1", log) is None  # type: ignore[arg-type]
    assert await org_policy_webhooks(FakeConfig(_document(enabled=False)), "org-1", log) is None  # type: ignore[arg-type]
    on = await org_policy_webhooks(FakeConfig(_document()), "org-1", log)  # type: ignore[arg-type]
    unreadable = await org_policy_webhooks(FakeConfig(RuntimeError("kv down")), "org-1", log)  # type: ignore[arg-type]
    assert on is not None and unreadable is not None
    assert external_policy_guarded(allow, webhooks=None, org_id="org-1", run_id="r", log=log, dry_run=False) is allow  # type: ignore[arg-type]
    for dry in (False, True):
        guarded = external_policy_guarded(allow, webhooks=on, org_id="org-1", run_id="r", log=log, dry_run=dry)  # type: ignore[arg-type]
        assert isinstance(guarded, ExternalPolicyGuard) and guarded.dry_run is dry
