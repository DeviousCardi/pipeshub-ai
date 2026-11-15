"""QA26-P5 (MCP-24, MCP-G5): the manifest and runner routes' authorization as one table.

Rows are callers (the owning org's admin, its member, another org's admin, nobody); columns
are the three hub routes. Each cell is the status the caller gets, and a refused call
leaves the stored instance and manifest exactly as they were. The admin oracle is the
caller's own role per (org, user), as ``fetch_caller_role`` answers it from Node.
"""

from __future__ import annotations

import copy
from collections.abc import Iterator
from typing import TYPE_CHECKING, Any

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.agents.constants.mcp_server_constants import (
    get_mcp_credentials_path,
    get_mcp_instance_path,
)
from app.api.routes import mcp_hub as hub_routes
from app.api.routes import mcp_servers as server_routes
from app.harness.mcp_hub.manifests import manifest_path
from tests.support.bound_org import bound_like_auth
from tests.unit.harness.credentials.support import DictConfig
from tests.unit.harness.mcp_hub.support import (
    INSTANCE_ID,
    URL,
    FakeServer,
    http_instance,
    hub_on,
    serve,
)

if TYPE_CHECKING:
    from collections.abc import Iterator

STDIO_ID = "mcp-stdio-qa26"
CALLERS: dict[str, dict[str, str] | None] = {
    "owning org admin": {"userId": "admin-1", "orgId": "org-1"},
    "owning org member": {"userId": "member-1", "orgId": "org-1"},
    "other org admin": {"userId": "admin-2", "orgId": "org-2"},
    "unauthenticated": None,
}
ADMINS = {("org-1", "admin-1"), ("org-2", "admin-2")}


def _stdio() -> dict[str, Any]:
    return {
        "_id": STDIO_ID,
        "orgId": "org-1",
        "createdBy": "admin-1",
        "name": "Echo",
        "typeId": None,
        "transport": "stdio",
        "authMode": "none",
        "command": "python3",
        "args": ["/opt/echo.py"],
        "requiredEnv": [],
        "isCustom": True,
        "createdAt": 0,
        "updatedAt": 0,
    }


@pytest.fixture
def config() -> DictConfig:
    return DictConfig(
        {
            get_mcp_instance_path(INSTANCE_ID): http_instance(),
            get_mcp_instance_path(STDIO_ID): _stdio(),
            get_mcp_credentials_path(INSTANCE_ID, "admin-1"): {"isAuthenticated": True, "credentials": {"apiToken": "t"}},
            get_mcp_credentials_path(INSTANCE_ID, "admin-2"): {"isAuthenticated": True, "credentials": {"apiToken": "t2"}},
        }
    )


@pytest.fixture
def client(config: DictConfig, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    _ = serve(monkeypatch, {URL: FakeServer()})
    _ = hub_on(monkeypatch)

    async def is_admin(_user_id: str, request: Request, _config: object) -> bool:
        user = request.state.user
        return (user["orgId"], user["userId"]) in ADMINS

    monkeypatch.setattr(hub_routes, "check_user_is_admin", is_admin)
    app = FastAPI()

    @app.middleware("http")
    async def user(request: Request, call_next: Any) -> Any:  # noqa: ANN401 - Starlette's own types
        caller = CALLERS[request.headers["x-caller"]]
        request.state.user = dict(caller) if caller is not None else {}
        with bound_like_auth(request.state.user):
            return await call_next(request)

    app.state.config_service = config
    app.dependency_overrides[server_routes.require_mcp_enabled] = lambda: None
    app.include_router(hub_routes.router)
    with TestClient(app) as test_client:
        yield test_client


def _approve_body(client: TestClient) -> dict[str, Any]:
    listed = client.get(f"/api/v1/mcp-servers/instances/{INSTANCE_ID}/manifest", headers={"x-caller": "owning org admin"})
    assert listed.status_code == 200, listed.text
    return {"tools": [{"name": t["name"], "digest": t["digest"]} for t in listed.json()["tools"]]}


ROUTES = {
    "read manifest": ("GET", f"/api/v1/mcp-servers/instances/{INSTANCE_ID}/manifest"),
    "approve manifest": ("PUT", f"/api/v1/mcp-servers/instances/{INSTANCE_ID}/manifest"),
    "configure runner": ("PUT", f"/api/v1/mcp-servers/instances/{STDIO_ID}/runner"),
}
TABLE = {
    "owning org admin": {"read manifest": 200, "approve manifest": 200, "configure runner": 200},
    "owning org member": {"read manifest": 403, "approve manifest": 403, "configure runner": 403},
    "other org admin": {"read manifest": 404, "approve manifest": 404, "configure runner": 404},
    "unauthenticated": {"read manifest": 401, "approve manifest": 401, "configure runner": 401},
}


@pytest.mark.parametrize(
    ("caller", "route"),
    [(caller, route) for caller in TABLE for route in ROUTES],
    ids=[f"{caller}-{route}".replace(" ", "_") for caller in TABLE for route in ROUTES],
)
def test_qa26_p5_manifest_routes_authz_table(client: TestClient, config: DictConfig, caller: str, route: str) -> None:
    method, path = ROUTES[route]
    body: dict[str, Any] | None = None
    if route == "approve manifest":
        body = _approve_body(client)
    elif route == "configure runner":
        body = {"egressHosts": ["api.example.test"]}
    before = copy.deepcopy(config.values)

    response = client.request(method, path, json=body, headers={"x-caller": caller})

    assert response.status_code == TABLE[caller][route], response.text
    if response.status_code != 200:
        assert config.values == before, "a refused call changed the stored instance or manifest"
        assert "apiToken" not in response.text and "org-1" not in response.text
    elif route == "approve manifest":
        assert config.values[manifest_path(INSTANCE_ID)]["history"][-1]["by"] == "admin-1"
