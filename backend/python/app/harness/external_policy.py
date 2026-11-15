"""The org's external policy webhook for the worker (G-40, GA-20): its setting, read where Node keeps it, and the
call that asks it.

Node's admin API keeps each org's ``policyWebhook`` in the encrypted ``/services/agentHarness/policyWebhook``
document; ``ConfigurationService`` reads it back decrypted. Until Node has moved the webhooks there (its first start
of this release writes the document, even empty), they are read from ``/services/agentHarness/securityExport``,
where they were kept beside other settings, so no configured webhook goes unasked during an upgrade. The request goes only to the address that was checked
(``resolve_public_http_target`` and ``plan_hop``: never loopback, link-local or metadata, private ones only where
the deployment allows them), follows no redirect, and carries the call's arguments with secrets masked.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Mapping
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, cast

import httpx

from app.config.constants.service import config_node_constants
from app.utils.public_http import plan_hop
from app.utils.url_fetcher import private_addresses_blocked, resolve_public_http_target
from harness_core.effects.external_policy import (
    ExternalPolicyGuard,
    ExternalVerdict,
    PolicyWebhook,
    UnclearPolicyAnswer,
)
from harness_core.security.token_patterns import redact_secrets_in

if TYPE_CHECKING:
    from collections.abc import Callable

    from pydantic import JsonValue

    from app.config.configuration_service import ConfigurationService
    from harness_core.effects.external_policy import PolicyQuestion
    from harness_core.effects.types import ApprovalPolicy
    from harness_core.kernel.core.messages import ToolCall
    from harness_core.logs import HarnessLog

# How long one read of the setting serves: an admin's change applies within it.
SETTING_TTL_S = 15.0
# The most of the webhook's answer read; the decision is one word.
MAX_ANSWER_BYTES = 16 * 1024
MAX_REASON_CHARS = 500


class PolicyWebhookSettingInvalid(ValueError):
    """The stored setting is not one the admin API writes."""


def webhook_of(document: object, org_id: str) -> PolicyWebhook | None:
    """The org's webhook from the policy webhook document (or the one it was kept in before); ``None`` when it has
    none on."""
    if document is None:
        return None
    if not isinstance(document, Mapping):
        raise PolicyWebhookSettingInvalid("the policy webhook document is not an object")
    orgs = cast("Mapping[str, object]", document).get("orgs")
    entry = cast("Mapping[str, object]", orgs).get(org_id) if isinstance(orgs, Mapping) else None
    if entry is None:
        return None
    if not isinstance(entry, Mapping):
        raise PolicyWebhookSettingInvalid("an org entry is not an object")
    hook = cast("Mapping[str, object]", entry).get("policyWebhook")
    if hook is None:
        return None
    if not isinstance(hook, Mapping):
        raise PolicyWebhookSettingInvalid("policyWebhook is not an object")
    fields = cast("Mapping[str, object]", hook)
    if fields.get("enabled") is not True:
        return None
    url, timeout_ms, header = fields.get("url"), fields.get("timeoutMs"), fields.get("authHeader")
    if not isinstance(url, str) or not isinstance(timeout_ms, int) or isinstance(timeout_ms, bool):
        raise PolicyWebhookSettingInvalid("policyWebhook needs a url and a timeoutMs")
    auth: tuple[str, str] | None = None
    if isinstance(header, Mapping):
        name, value = cast("Mapping[str, object]", header).get("name"), cast("Mapping[str, object]", header).get("value")
        if not isinstance(name, str) or not isinstance(value, str):
            raise PolicyWebhookSettingInvalid("authHeader needs a name and a value")
        auth = (name, value)
    elif header is not None:
        raise PolicyWebhookSettingInvalid("authHeader is not an object")
    return PolicyWebhook(url=url, timeout_s=timeout_ms / 1000, auth_header=auth)


@dataclass
class _Read:
    document: object
    at: float


class ConfiguredPolicyWebhooks:
    """``PolicyWebhooks`` over ``ConfigurationService``, each read kept ``SETTING_TTL_S``. A failed read raises:
    the guard then denies, it never falls back to asking nobody."""

    def __init__(self, config_service: ConfigurationService, *, clock: Callable[[], float] = time.monotonic) -> None:
        self._config_service = config_service
        self._now = clock
        self._read: _Read | None = None
        self._lock = asyncio.Lock()

    async def webhook(self, org_id: str) -> PolicyWebhook | None:
        async with self._lock:
            if self._read is None or self._now() - self._read.at >= SETTING_TTL_S:
                # raise_on_error: a store that cannot be read must deny, never read as "no webhook".
                document = await self._config_service.get_config(
                    config_node_constants.AGENT_HARNESS_POLICY_WEBHOOK.value, use_cache=False, raise_on_error=True
                )
                if document is None:
                    document = await self._config_service.get_config(
                        config_node_constants.AGENT_HARNESS_SECURITY_EXPORT.value, use_cache=False, raise_on_error=True
                    )
                self._read = _Read(document, self._now())
            return webhook_of(self._read.document, org_id)


def _verdict(body: bytes) -> ExternalVerdict:
    try:
        answer = json.loads(body)
    except ValueError as error:
        raise UnclearPolicyAnswer("the answer is not JSON") from error
    if not isinstance(answer, Mapping):
        raise UnclearPolicyAnswer("the answer is not an object")
    fields = cast("Mapping[str, object]", answer)
    decision, reason = fields.get("decision"), fields.get("reason")
    if decision not in ("allow", "ask", "deny"):
        raise UnclearPolicyAnswer("the answer has no decision it understands")
    said = " ".join(reason.split())[:MAX_REASON_CHARS] if isinstance(reason, str) else ""
    return ExternalVerdict(decision, said or None)


class HttpPolicyConsultant:
    """``PolicyConsultant`` over https: one POST to the checked address, no redirect, the answer read capped."""

    def __init__(self, transport: httpx.AsyncBaseTransport | None = None, *, allow_private: bool | None = None) -> None:
        self._transport = transport
        self._allow_private = allow_private

    async def ask(self, webhook: PolicyWebhook, question: PolicyQuestion) -> ExternalVerdict:
        if not webhook.url.startswith("https://"):
            raise ValueError("the policy webhook must be https")
        allow_private = not private_addresses_blocked() if self._allow_private is None else self._allow_private
        target = await asyncio.to_thread(resolve_public_http_target, webhook.url, allow_private=allow_private)
        plan = plan_hop(webhook.url, replace(target, addresses=target.addresses[:1]))
        body = json.dumps(
            {
                "orgId": question.org_id,
                "runId": question.run_id,
                "invocationId": question.invocation_id,
                "toolId": question.tool_id,
                "risk": question.risk,
                "arguments": question.arguments,
                "dryRun": question.dry_run,
            },
            ensure_ascii=False,
        ).encode()
        headers = {**plan.headers, "content-type": "application/json"}
        if webhook.auth_header is not None:
            headers[webhook.auth_header[0]] = webhook.auth_header[1]
        async with httpx.AsyncClient(
            trust_env=False, follow_redirects=False, timeout=webhook.timeout_s, transport=self._transport
        ) as client:
            request = client.build_request(
                "POST", plan.request_url, headers=headers, content=body, extensions=dict(plan.extensions)
            )
            response = await client.send(request, stream=True)
            try:
                if response.status_code < 200 or response.status_code >= 300:
                    raise httpx.HTTPStatusError(
                        f"the policy webhook answered {response.status_code}", request=request, response=response
                    )
                read = b""
                async for chunk in response.aiter_bytes():
                    read += chunk
                    if len(read) > MAX_ANSWER_BYTES:
                        raise ValueError("the policy webhook's answer is too large")
            finally:
                await response.aclose()
        return _verdict(read)


def _masked_arguments(call: ToolCall) -> JsonValue:
    return redact_secrets_in(cast("JsonValue", call.arguments))


async def org_policy_webhooks(config_service: ConfigurationService, org_id: str, log: HarnessLog) -> ConfiguredPolicyWebhooks | None:
    """The org's webhook source when its runs must consult one: it has a webhook on, or its setting cannot be read
    (then the guard denies every call that writes outside). ``None``: the org has none, and nothing is wrapped. Read
    when an attempt is assembled, so a webhook turned on applies from the next run; turning one off is read live."""
    webhooks = ConfiguredPolicyWebhooks(config_service)
    try:
        return webhooks if await webhooks.webhook(org_id) is not None else None
    except Exception as error:  # an unreadable setting fails closed, whatever it raised
        log.warning("effects.external_policy_unreadable", reasonCode="setting_unreadable", errorType=type(error).__name__)
        return webhooks


def external_policy_guarded(
    policy: ApprovalPolicy,
    *,
    webhooks: ConfiguredPolicyWebhooks | None,
    org_id: str,
    run_id: str,
    log: HarnessLog,
    dry_run: bool,
    consultant: HttpPolicyConsultant | None = None,
) -> ApprovalPolicy:
    """``policy`` narrowed by the org's policy webhook (outermost, so every rule under it is asked first); unchanged
    when ``webhooks`` is ``None`` (``org_policy_webhooks``: the org has none). ``dry_run``: the run's dry-run gate,
    told to the webhook with every question."""
    if webhooks is None:
        return policy
    return ExternalPolicyGuard(
        policy,
        webhooks,
        consultant or HttpPolicyConsultant(),
        org_id,
        run_id,
        _masked_arguments,
        dry_run=dry_run,
        log=log,
    )


__all__ = [
    "ConfiguredPolicyWebhooks",
    "HttpPolicyConsultant",
    "PolicyWebhookSettingInvalid",
    "external_policy_guarded",
    "org_policy_webhooks",
    "webhook_of",
]
