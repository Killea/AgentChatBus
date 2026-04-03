"""
Tests for UP-15: Agent capabilities declaration.

Covers:
- skills[] storage and retrieval (unit, in-memory DB)
- agent_update CRUD (unit)
- capabilities and skills in GET /api/agents (HTTP integration)
- PUT /api/agents/{id} endpoint (HTTP integration)
"""
import json

import aiosqlite
import httpx
import pytest

from agentchatbus.db import crud
from agentchatbus.db.database import init_schema

from tests._constants import TEST_BASE_URL as BASE_URL

SAMPLE_SKILLS = [
    {
        "id": "code-review",
        "name": "Code Review",
        "description": "Reviews code for style, security, and best practices",
        "tags": ["review", "security"],
        "examples": ["Review this PR for security issues"],
    },
    {
        "id": "css-audit",
        "name": "CSS Audit",
        "description": "Audits CSS for token compliance and contrast",
        "tags": ["css", "accessibility"],
    },
]


# ─────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────

def _build_client() -> httpx.Client:
    return httpx.Client(base_url=BASE_URL, timeout=10)


def _require_server_or_skip(client: httpx.Client) -> None:
    try:
        resp = client.get("/api/agents")
        if resp.status_code < 500:
            return
    except Exception:
        pass
    pytest.skip(f"AgentChatBus server is not reachable at {BASE_URL}")


# ─────────────────────────────────────────────
# Unit tests (in-memory DB)
# ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_register_with_skills():
    """Agent registered with skills[] stores them correctly."""
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    agent = await crud.agent_register(
        db, ide="Cursor", model="claude-3-5-sonnet",
        skills=SAMPLE_SKILLS,
    )

    assert agent.skills is not None
    parsed = json.loads(agent.skills)
    assert len(parsed) == 2
    assert parsed[0]["id"] == "code-review"
    assert parsed[1]["id"] == "css-audit"

    await db.close()


@pytest.mark.asyncio
async def test_register_without_skills():
    """Backward-compatible: agent registered without skills has skills=None."""
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    agent = await crud.agent_register(db, ide="CLI", model="GPT-4")

    assert agent.skills is None

    retrieved = await crud.agent_get(db, agent.id)
    assert retrieved is not None
    assert retrieved.skills is None

    await db.close()


@pytest.mark.asyncio
async def test_register_with_capabilities_and_skills():
    """Both capabilities and skills can be set at registration."""
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    agent = await crud.agent_register(
        db, ide="Cursor", model="GPT-4",
        capabilities=["code", "review"],
        skills=[{"id": "code-review", "name": "Code Review"}],
    )

    assert agent.capabilities is not None
    assert json.loads(agent.capabilities) == ["code", "review"]
    assert agent.skills is not None
    assert json.loads(agent.skills)[0]["id"] == "code-review"

    await db.close()


@pytest.mark.asyncio
async def test_agent_get():
    """agent_get returns the correct agent by ID."""
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    agent = await crud.agent_register(
        db, ide="Cursor", model="GPT-4",
        skills=SAMPLE_SKILLS,
    )
    retrieved = await crud.agent_get(db, agent.id)

    assert retrieved is not None
    assert retrieved.id == agent.id
    assert retrieved.skills == agent.skills

    await db.close()


@pytest.mark.asyncio
async def test_agent_get_nonexistent():
    """agent_get returns None for an unknown agent ID."""
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    result = await crud.agent_get(db, "nonexistent-id")
    assert result is None

    await db.close()


@pytest.mark.asyncio
async def test_update_capabilities():
    """agent_update replaces capabilities after registration."""
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    agent = await crud.agent_register(
        db, ide="Cursor", model="GPT-4", capabilities=["code"],
    )
    updated = await crud.agent_update(
        db, agent_id=agent.id, token=agent.token,
        capabilities=["code", "review", "security"],
    )

    assert json.loads(updated.capabilities) == ["code", "review", "security"]
    assert updated.last_activity == "update"

    await db.close()


@pytest.mark.asyncio
async def test_update_skills():
    """agent_update replaces skills after registration."""
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    agent = await crud.agent_register(db, ide="Cursor", model="GPT-4")
    assert agent.skills is None

    updated = await crud.agent_update(
        db, agent_id=agent.id, token=agent.token,
        skills=SAMPLE_SKILLS,
    )

    parsed = json.loads(updated.skills)
    assert len(parsed) == 2
    assert parsed[0]["id"] == "code-review"

    await db.close()


@pytest.mark.asyncio
async def test_update_display_name():
    """agent_update changes display_name and alias_source to 'user'."""
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    agent = await crud.agent_register(db, ide="Cursor", model="GPT-4")
    assert agent.alias_source == "auto"

    updated = await crud.agent_update(
        db, agent_id=agent.id, token=agent.token,
        display_name="Expert Reviewer",
    )

    assert updated.display_name == "Expert Reviewer"
    assert updated.alias_source == "user"

    await db.close()


@pytest.mark.asyncio
async def test_update_partial():
    """agent_update with only skills leaves description and capabilities untouched."""
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    agent = await crud.agent_register(
        db, ide="Cursor", model="GPT-4",
        description="original desc",
        capabilities=["code"],
    )
    updated = await crud.agent_update(
        db, agent_id=agent.id, token=agent.token,
        skills=[{"id": "debug", "name": "Debugging"}],
    )

    assert updated.description == "original desc"
    assert json.loads(updated.capabilities) == ["code"]
    assert json.loads(updated.skills)[0]["id"] == "debug"

    await db.close()


@pytest.mark.asyncio
async def test_update_invalid_token():
    """agent_update raises ValueError on wrong token."""
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    agent = await crud.agent_register(db, ide="Cursor", model="GPT-4")

    with pytest.raises(ValueError, match="Invalid token"):
        await crud.agent_update(
            db, agent_id=agent.id, token="wrong-token",
            skills=[{"id": "x", "name": "X"}],
        )

    await db.close()


@pytest.mark.asyncio
async def test_update_nonexistent_agent():
    """agent_update raises ValueError for unknown agent_id."""
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    with pytest.raises(ValueError, match="not found"):
        await crud.agent_update(
            db, agent_id="no-such-id", token="any-token",
        )

    await db.close()


# ─────────────────────────────────────────────
# HTTP integration tests (require running server)
# ─────────────────────────────────────────────

@pytest.fixture(scope="module")
def registered_agent() -> dict:
    """Register a test agent with capabilities and skills, return its credentials."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = client.post("/api/agents/register", json={
            "ide": "TestIDE-UP15",
            "model": "test-model",
            "description": "UP-15 integration test agent",
            "capabilities": ["test", "up15"],
            "skills": [{"id": "up15-skill", "name": "UP-15 Test Skill"}],
        })
        assert r.status_code == 200, r.text
        return r.json()


def test_api_register_returns_capabilities(registered_agent):
    """POST /api/agents/register returns capabilities in response."""
    assert "capabilities" in registered_agent
    assert registered_agent["capabilities"] == ["test", "up15"]


def test_api_register_returns_skills(registered_agent):
    """POST /api/agents/register returns skills in response."""
    assert "skills" in registered_agent
    assert len(registered_agent["skills"]) == 1
    assert registered_agent["skills"][0]["id"] == "up15-skill"


def test_api_register_returns_emoji(registered_agent):
    """POST /api/agents/register returns backend-generated emoji."""
    assert "emoji" in registered_agent
    assert isinstance(registered_agent["emoji"], str)
    assert registered_agent["emoji"]


def test_api_agents_includes_capabilities(registered_agent):
    """GET /api/agents includes capabilities for every agent."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = client.get("/api/agents")
        assert r.status_code == 200
        agents = r.json()
        agent_id = registered_agent["agent_id"]
        matched = next((a for a in agents if a["id"] == agent_id), None)
        assert matched is not None, "Registered agent not found in list"
        assert "capabilities" in matched
        assert matched["capabilities"] == ["test", "up15"]


def test_api_agents_includes_skills(registered_agent):
    """GET /api/agents includes skills for every agent."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = client.get("/api/agents")
        assert r.status_code == 200
        agents = r.json()
        agent_id = registered_agent["agent_id"]
        matched = next((a for a in agents if a["id"] == agent_id), None)
        assert matched is not None
        assert "skills" in matched
        assert len(matched["skills"]) == 1
        assert matched["skills"][0]["id"] == "up15-skill"


def test_api_agents_includes_emoji(registered_agent):
    """GET /api/agents includes emoji and it matches register payload for same agent."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = client.get("/api/agents")
        assert r.status_code == 200
        agents = r.json()
        agent_id = registered_agent["agent_id"]
        matched = next((a for a in agents if a["id"] == agent_id), None)
        assert matched is not None
        assert "emoji" in matched
        assert matched["emoji"] == registered_agent["emoji"]


def test_api_agent_get_by_id(registered_agent):
    """GET /api/agents/{id} returns single agent with capabilities and skills."""
    with _build_client() as client:
        _require_server_or_skip(client)
        agent_id = registered_agent["agent_id"]
        r = client.get(f"/api/agents/{agent_id}")
        assert r.status_code == 200
        data = r.json()
        assert data["id"] == agent_id
        assert data["capabilities"] == ["test", "up15"]
        assert data["skills"][0]["id"] == "up15-skill"
        assert data["emoji"] == registered_agent["emoji"]
        assert "registered_at" in data


def test_api_agent_get_404():
    """GET /api/agents/{id} returns 404 for unknown agent."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = client.get("/api/agents/nonexistent-agent-id-xyz")
        assert r.status_code == 404


def test_api_agent_update(registered_agent):
    """PUT /api/agents/{id} updates skills and returns updated agent."""
    with _build_client() as client:
        _require_server_or_skip(client)
        agent_id = registered_agent["agent_id"]
        token = registered_agent["token"]
        new_skills = [
            {"id": "up15-skill", "name": "UP-15 Test Skill"},
            {"id": "new-skill", "name": "New Skill Added via Update"},
        ]
        r = client.put(f"/api/agents/{agent_id}", json={
            "token": token,
            "skills": new_skills,
        })
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["ok"] is True
        assert len(data["skills"]) == 2
        assert data["skills"][1]["id"] == "new-skill"


def test_api_agent_update_wrong_token(registered_agent):
    """PUT /api/agents/{id} returns 401 on wrong token."""
    with _build_client() as client:
        _require_server_or_skip(client)
        agent_id = registered_agent["agent_id"]
        r = client.put(f"/api/agents/{agent_id}", json={
            "token": "completely-wrong-token",
            "description": "hacked",
        })
        assert r.status_code == 401
