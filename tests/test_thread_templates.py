"""
Tests for UP-18: Thread templates.

Covers:
- Built-in template seeding (unit, in-memory DB)
- template CRUD: list, get, create, delete (unit)
- thread_create with template resolution (unit)
- Error cases: duplicate ID, delete built-in, invalid template on thread_create
- HTTP integration: GET/POST/DELETE /api/templates, POST /api/threads with template
"""
import json

import aiosqlite
import httpx
import pytest

from src.db import crud
from src.db.database import init_schema

from tests._constants import TEST_BASE_URL as BASE_URL


# ─────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────

def _build_client() -> httpx.Client:
    return httpx.Client(base_url=BASE_URL, timeout=10)


def _require_server_or_skip(client: httpx.Client) -> None:
    try:
        resp = client.get("/api/templates")
        if resp.status_code < 500:
            return
    except Exception:
        pass
    pytest.skip(f"AgentChatBus server is not reachable at {BASE_URL}")


async def _setup_db():
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)
    return db


# ─────────────────────────────────────────────
# Unit tests (in-memory DB)
# ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_builtin_templates_seeded():
    """4 built-in templates are created after init_schema."""
    db = await _setup_db()
    try:
        templates = await crud.template_list(db)
        assert len(templates) == 4, f"Expected 4 built-in templates, got {len(templates)}"
        ids = {t.id for t in templates}
        assert "code-review" in ids
        assert "security-audit" in ids
        assert "architecture" in ids
        assert "brainstorm" in ids
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_builtin_templates_are_builtin():
    """All seeded templates have is_builtin=True."""
    db = await _setup_db()
    try:
        templates = await crud.template_list(db)
        for t in templates:
            assert t.is_builtin is True, f"Template {t.id} should be builtin"
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_template_list():
    """template_list returns all templates."""
    db = await _setup_db()
    try:
        templates = await crud.template_list(db)
        assert len(templates) >= 4
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_template_get_existing():
    """template_get returns correct template by ID."""
    db = await _setup_db()
    try:
        t = await crud.template_get(db, "code-review")
        assert t is not None
        assert t.id == "code-review"
        assert t.name == "Code Review"
        assert t.system_prompt is not None
        assert len(t.system_prompt) > 0
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_template_get_nonexistent():
    """template_get returns None for unknown ID."""
    db = await _setup_db()
    try:
        t = await crud.template_get(db, "does-not-exist")
        assert t is None
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_template_create_custom():
    """template_create creates a non-builtin template."""
    db = await _setup_db()
    try:
        t = await crud.template_create(
            db,
            id="my-custom",
            name="My Custom Template",
            description="Test template",
            system_prompt="You are a helpful assistant.",
        )
        assert t.id == "my-custom"
        assert t.is_builtin is False
        # Verify it appears in list
        templates = await crud.template_list(db)
        ids = {tmpl.id for tmpl in templates}
        assert "my-custom" in ids
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_template_create_duplicate_id():
    """template_create raises ValueError on duplicate ID."""
    db = await _setup_db()
    try:
        with pytest.raises(ValueError, match="already exists"):
            await crud.template_create(db, id="code-review", name="Conflict")
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_template_delete_custom():
    """template_delete succeeds for custom (non-builtin) templates."""
    db = await _setup_db()
    try:
        await crud.template_create(db, id="to-delete", name="Delete Me")
        await crud.template_delete(db, "to-delete")
        t = await crud.template_get(db, "to-delete")
        assert t is None
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_template_delete_builtin_raises():
    """template_delete raises ValueError for built-in templates."""
    db = await _setup_db()
    try:
        with pytest.raises(ValueError, match="built-in"):
            await crud.template_delete(db, "code-review")
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_thread_create_with_template():
    """thread_create applies template system_prompt when no system_prompt provided."""
    db = await _setup_db()
    try:
        thread = await crud.thread_create(db, "Test Template Thread", template="code-review")
        assert thread.template_id == "code-review"
        assert thread.system_prompt is not None
        assert len(thread.system_prompt) > 0
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_thread_create_template_override_prompt():
    """Caller-provided system_prompt takes precedence over template default."""
    db = await _setup_db()
    try:
        custom_prompt = "My custom system prompt"
        thread = await crud.thread_create(
            db,
            "Override Prompt Thread",
            system_prompt=custom_prompt,
            template="code-review",
        )
        assert thread.system_prompt == custom_prompt
        assert thread.template_id == "code-review"
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_thread_create_nonexistent_template():
    """thread_create raises ValueError when template ID does not exist."""
    db = await _setup_db()
    try:
        with pytest.raises(ValueError, match="not found"):
            await crud.thread_create(db, "Bad Template Thread", template="nonexistent")
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_thread_create_template_stores_template_id():
    """thread.template_id is persisted and retrievable."""
    db = await _setup_db()
    try:
        thread = await crud.thread_create(db, "Persistent Template Test", template="brainstorm")
        fetched = await crud.thread_get(db, thread.id)
        assert fetched is not None
        assert fetched.template_id == "brainstorm"
    finally:
        await db.close()


# ─────────────────────────────────────────────
# HTTP integration tests (require running server)
# ─────────────────────────────────────────────

def test_api_list_templates():
    """GET /api/templates returns at least 4 built-in templates."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = client.get("/api/templates")
        assert r.status_code == 200, r.text
        templates = r.json()
        assert isinstance(templates, list)
        assert len(templates) >= 4
        ids = {t["id"] for t in templates}
        assert "code-review" in ids
        assert "brainstorm" in ids


def test_api_get_template():
    """GET /api/templates/code-review returns template details."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = client.get("/api/templates/code-review")
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["id"] == "code-review"
        assert data["name"] == "Code Review"
        assert data["is_builtin"] is True
        assert "system_prompt" in data


def test_api_get_template_not_found():
    """GET /api/templates/{unknown} returns 404."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = client.get("/api/templates/does-not-exist-xyzzy")
        assert r.status_code == 404


def test_api_create_custom_template():
    """POST /api/templates creates a custom template."""
    with _build_client() as client:
        _require_server_or_skip(client)
        import uuid
        custom_id = f"test-custom-{uuid.uuid4().hex[:8]}"
        r = client.post("/api/templates", json={
            "id": custom_id,
            "name": "Integration Test Template",
            "description": "Created by integration test",
            "system_prompt": "Test system prompt.",
        })
        assert r.status_code == 201, r.text
        data = r.json()
        assert data["id"] == custom_id
        assert data["is_builtin"] is False


def test_api_create_thread_with_template():
    """POST /api/threads with template applies template defaults."""
    with _build_client() as client:
        _require_server_or_skip(client)
        register_resp = client.post(
            "/api/agents/register",
            json={"ide": "VS Code", "model": "GPT-5.3-Codex"},
        )
        assert register_resp.status_code == 200, register_resp.text
        agent = register_resp.json()
        r = client.post("/api/threads", json={
            "topic": f"Integration Template Thread {id(client)}",
            "template": "code-review",
            "creator_agent_id": agent["agent_id"],
        }, headers={"X-Agent-Token": agent["token"]})
        assert r.status_code == 201, r.text
        data = r.json()
        assert data["template_id"] == "code-review"
        assert data["system_prompt"] is not None
