"""Writes the approvals document of the durable lane (E2E2) through ``ConfigurationService``, in the app container.

    python /e2e/pyrun.py /e2e/seed_config.py approvals <orgId>
    python /e2e/pyrun.py /e2e/seed_config.py github <orgId> <userId>

``github`` (WP-26, the repository picker): an org GitHub toolset instance named "GitHub" and <userId>'s sign-in to it,
holding the fake SaaS's GitHub token (``FAKE_SAAS_GITHUB_TOKEN``), as the OAuth callback would leave them. The fake
GitHub cannot run an OAuth sign-in, so the lane writes the result. Idempotent: an existing instance is reused.

No route writes ``/services/agentHarness/approvals`` yet (FLAGS.md: operator only; P2.11e builds the admin route),
so the lane writes it as an operator would, through the same service and KV store every process reads, and reads
it back. Engine runs already ask for writes (``ENGINE_APPROVALS``); the document makes the org's own rule say so too.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import uuid

from app.config.constants.service import config_node_constants
from app.harness.assembly.services import HarnessServices

KEY = config_node_constants.AGENT_HARNESS_APPROVALS.value


async def write_approvals(org_id: str) -> None:
    config = HarnessServices().config_service()
    current = await config.get_config(KEY, default=None) or {}
    if not isinstance(current, dict):
        raise SystemExit(f"{KEY} holds {type(current).__name__}, not a document")
    document = dict(current)
    document["orgs"] = {**dict(document.get("orgs") or {}), org_id: {"writes": "ask"}}
    if not await config.set_config(KEY, document):
        raise SystemExit(f"{KEY} was not written")
    stored = await config.get_config(KEY, default=None, use_cache=False)
    if not isinstance(stored, dict) or (stored.get("orgs") or {}).get(org_id) != {"writes": "ask"}:
        raise SystemExit(f"{KEY} reads back as {json.dumps(stored)[:200]}")
    print(json.dumps({"approvals": {"orgs": {org_id: stored["orgs"][org_id]}}}))


INSTANCES_KEY = "/services/toolset-instances"
GITHUB_INSTANCE_NAME = "GitHub"


async def write_github(org_id: str, user_id: str) -> None:
    token = os.environ.get("FAKE_SAAS_GITHUB_TOKEN", "")
    if not token:
        raise SystemExit("FAKE_SAAS_GITHUB_TOKEN is not set in the app container")
    config = HarnessServices().config_service()
    instances = await config.get_config(INSTANCES_KEY, default=[]) or []
    if not isinstance(instances, list):
        raise SystemExit(f"{INSTANCES_KEY} holds {type(instances).__name__}, not a list")
    found = next(
        (i for i in instances if isinstance(i, dict) and i.get("orgId") == org_id
         and i.get("toolsetType") == "github" and i.get("instanceName") == GITHUB_INSTANCE_NAME),
        None,
    )
    if found is None:
        now = int(time.time() * 1000)
        found = {
            "_id": str(uuid.uuid4()), "instanceName": GITHUB_INSTANCE_NAME, "toolsetType": "github",
            "authType": "OAUTH", "orgId": org_id, "createdBy": user_id, "scope": "org",
            "createdAtTimestamp": now, "updatedAtTimestamp": now,
        }
        if not await config.set_config(INSTANCES_KEY, [*instances, found]):
            raise SystemExit(f"{INSTANCES_KEY} was not written")
    toolset_path = f"/services/toolsets/{found['_id']}/{user_id}"
    auth = {
        "isAuthenticated": True, "instanceId": found["_id"], "toolsetType": "github", "orgId": org_id,
        "userId": user_id, "credentials": {"access_token": token, "token_type": "bearer"},
        "updatedAtTimestamp": int(time.time() * 1000),
    }
    if not await config.set_config(toolset_path, auth):
        raise SystemExit(f"{toolset_path} was not written")
    stored = await config.get_config(toolset_path, default=None, use_cache=False)
    if not isinstance(stored, dict) or stored.get("isAuthenticated") is not True:
        raise SystemExit(f"{toolset_path} does not read back")
    print(json.dumps({"github": {"instanceId": found["_id"], "userId": user_id}}))


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "approvals":
        asyncio.run(write_approvals(sys.argv[2]))
    elif len(sys.argv) == 4 and sys.argv[1] == "github":
        asyncio.run(write_github(sys.argv[2], sys.argv[3]))
    else:
        raise SystemExit("usage: seed_config.py approvals <orgId> | github <orgId> <userId>")
