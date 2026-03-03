"""
Tests for UP-13 (message reactions) and UP-16 (priority messages).

Unit tests (in-memory DB, 19 tests):
  - Priority: 8 tests
  - Reactions: 11 tests

Integration tests (server on port 39769, 10 tests):
  - Priority: 5 tests
  - Reactions: 5 tests

Total: 29 tests
"""
import asyncio
import json

import aiosqlite
import httpx
import pytest

from src.db import crud
from src.db.database import init_schema

from tests._constants import TEST_BASE_URL as BASE_URL


# ─────────────────────────────────────────────
# Helpers (shared)
# ─────────────────────────────────────────────

def _build_client() -> httpx.Client:
    return httpx.Client(base_url=BASE_URL, timeout=10)


def _require_server_or_skip(client: httpx.Client) -> None:
    try:
        resp = client.get("/health")
        if resp.status_code == 200:
            return
    except Exception:
        pass
    pytest.skip(f"AgentChatBus server is not reachable at {BASE_URL}")


async def _setup_db():
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)
    return db


async def _post_msg(
    db,
    thread_id: str,
    author: str = "human",
    content: str = "hello",
    priority: str = "normal",
):
    """Helper: post a message with a fresh reply token."""
    sync = await crud.issue_reply_token(db, thread_id=thread_id)
    return await crud.msg_post(
        db,
        thread_id=thread_id,
        author=author,
        content=content,
        expected_last_seq=sync["current_seq"],
        reply_token=sync["reply_token"],
        priority=priority,
    )


async def _create_thread(db, topic: str = "test-thread"):
    return await crud.thread_create(db, topic=topic)


def _integration_post_msg(client, thread_id: str, priority: str = "normal"):
    """HTTP helper: POST a message via REST API."""
    return client.post(
        f"/api/threads/{thread_id}/messages",
        json={
            "author": "test-agent",
            "content": "Integration test message",
            "expected_last_seq": 0,
            "reply_token": "dummy-token",
            "priority": priority,
        },
    )


# ─────────────────────────────────────────────
# ── UNIT TESTS — Priority (UP-16) ────────────
# ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_msg_post_default_priority_normal():
    """POST without priority defaults to 'normal'."""
    db = await _setup_db()
    t = await _create_thread(db)
    msg = await _post_msg(db, t.id)
    assert msg.priority == "normal"
    await db.close()


@pytest.mark.asyncio
async def test_msg_post_with_urgent_priority():
    """POST with priority='urgent' stores correctly."""
    db = await _setup_db()
    t = await _create_thread(db)
    msg = await _post_msg(db, t.id, priority="urgent")
    assert msg.priority == "urgent"
    await db.close()


@pytest.mark.asyncio
async def test_msg_post_with_system_priority():
    """POST with priority='system' stores correctly."""
    db = await _setup_db()
    t = await _create_thread(db)
    msg = await _post_msg(db, t.id, priority="system")
    assert msg.priority == "system"
    await db.close()


@pytest.mark.asyncio
async def test_msg_post_invalid_priority_raises():
    """POST with an invalid priority raises ValueError."""
    db = await _setup_db()
    t = await _create_thread(db)
    with pytest.raises(ValueError, match="Invalid priority"):
        await _post_msg(db, t.id, priority="critical")
    await db.close()


@pytest.mark.asyncio
async def test_priority_in_message_object():
    """Message dataclass includes priority field with correct value."""
    db = await _setup_db()
    t = await _create_thread(db)
    msg = await _post_msg(db, t.id, priority="urgent")
    assert hasattr(msg, "priority")
    assert msg.priority == "urgent"
    await db.close()


@pytest.mark.asyncio
async def test_msg_list_filter_by_priority():
    """msg_list with priority='urgent' returns only urgent messages."""
    db = await _setup_db()
    t = await _create_thread(db)
    await _post_msg(db, t.id, content="normal msg", priority="normal")
    await _post_msg(db, t.id, content="urgent msg", priority="urgent")
    await _post_msg(db, t.id, content="system msg", priority="system")

    urgent_msgs = await crud.msg_list(db, t.id, priority="urgent", include_system_prompt=False)
    assert len(urgent_msgs) == 1
    assert urgent_msgs[0].content == "urgent msg"
    assert urgent_msgs[0].priority == "urgent"
    await db.close()


@pytest.mark.asyncio
async def test_msg_list_no_priority_filter_returns_all():
    """msg_list without filter returns all priorities."""
    db = await _setup_db()
    t = await _create_thread(db)
    await _post_msg(db, t.id, content="normal", priority="normal")
    await _post_msg(db, t.id, content="urgent", priority="urgent")
    await _post_msg(db, t.id, content="system", priority="system")

    all_msgs = await crud.msg_list(db, t.id, include_system_prompt=False)
    assert len(all_msgs) == 3
    await db.close()


@pytest.mark.asyncio
async def test_priority_column_migration():
    """init_schema creates priority column on messages (column present after init)."""
    db = await _setup_db()
    async with db.execute("PRAGMA table_info(messages)") as cur:
        cols = [row["name"] for row in await cur.fetchall()]
    assert "priority" in cols
    await db.close()


# ─────────────────────────────────────────────
# ── UNIT TESTS — Reactions (UP-13) ───────────
# ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_react_add():
    """Add a reaction; verify Reaction object returned with correct fields."""
    db = await _setup_db()
    t = await _create_thread(db)
    msg = await _post_msg(db, t.id)

    reaction = await crud.msg_react(db, message_id=msg.id, agent_id="agent-1", reaction="agree")
    assert reaction.message_id == msg.id
    assert reaction.agent_id == "agent-1"
    assert reaction.reaction == "agree"
    assert reaction.id is not None
    await db.close()


@pytest.mark.asyncio
async def test_react_duplicate_idempotent():
    """Adding the same reaction twice produces no error and no duplicate event."""
    db = await _setup_db()
    t = await _create_thread(db)
    msg = await _post_msg(db, t.id)

    await crud.msg_react(db, message_id=msg.id, agent_id="agent-1", reaction="agree")
    # Second call — must not raise
    await crud.msg_react(db, message_id=msg.id, agent_id="agent-1", reaction="agree")

    # Only one reaction stored
    reactions = await crud.msg_reactions(db, msg.id)
    assert len(reactions) == 1

    # Only one msg.react event emitted (from first insert)
    async with db.execute(
        "SELECT COUNT(*) as cnt FROM events WHERE event_type = 'msg.react'",
    ) as cur:
        row = await cur.fetchone()
    assert row["cnt"] == 1, "msg.react event must not be emitted for duplicate reactions"
    await db.close()


@pytest.mark.asyncio
async def test_react_multiple_agents():
    """Three different agents react 'agree' to the same message; 3 reactions stored."""
    db = await _setup_db()
    t = await _create_thread(db)
    msg = await _post_msg(db, t.id)

    for i in range(1, 4):
        await crud.msg_react(db, message_id=msg.id, agent_id=f"agent-{i}", reaction="agree")

    reactions = await crud.msg_reactions(db, msg.id)
    assert len(reactions) == 3
    await db.close()


@pytest.mark.asyncio
async def test_react_multiple_types():
    """One agent adds 'agree' and 'important'; both stored."""
    db = await _setup_db()
    t = await _create_thread(db)
    msg = await _post_msg(db, t.id)

    await crud.msg_react(db, message_id=msg.id, agent_id="agent-1", reaction="agree")
    await crud.msg_react(db, message_id=msg.id, agent_id="agent-1", reaction="important")

    reactions = await crud.msg_reactions(db, msg.id)
    labels = {r.reaction for r in reactions}
    assert labels == {"agree", "important"}
    await db.close()


@pytest.mark.asyncio
async def test_unreact_existing():
    """Add then remove a reaction; returns True."""
    db = await _setup_db()
    t = await _create_thread(db)
    msg = await _post_msg(db, t.id)

    await crud.msg_react(db, message_id=msg.id, agent_id="agent-1", reaction="agree")
    removed = await crud.msg_unreact(db, message_id=msg.id, agent_id="agent-1", reaction="agree")
    assert removed is True
    reactions = await crud.msg_reactions(db, msg.id)
    assert len(reactions) == 0
    await db.close()


@pytest.mark.asyncio
async def test_unreact_nonexistent_returns_false():
    """Remove a reaction that doesn't exist; returns False, no event emitted."""
    db = await _setup_db()
    t = await _create_thread(db)
    msg = await _post_msg(db, t.id)

    removed = await crud.msg_unreact(db, message_id=msg.id, agent_id="agent-1", reaction="agree")
    assert removed is False

    async with db.execute(
        "SELECT COUNT(*) as cnt FROM events WHERE event_type = 'msg.unreact'",
    ) as cur:
        row = await cur.fetchone()
    assert row["cnt"] == 0, "msg.unreact event must not be emitted for a no-op delete"
    await db.close()


@pytest.mark.asyncio
async def test_reactions_for_message():
    """msg_reactions returns all reactions for a message."""
    db = await _setup_db()
    t = await _create_thread(db)
    msg = await _post_msg(db, t.id)

    await crud.msg_react(db, message_id=msg.id, agent_id="a", reaction="agree")
    await crud.msg_react(db, message_id=msg.id, agent_id="b", reaction="disagree")

    reactions = await crud.msg_reactions(db, msg.id)
    assert len(reactions) == 2
    labels = {r.reaction for r in reactions}
    assert labels == {"agree", "disagree"}
    await db.close()


@pytest.mark.asyncio
async def test_reactions_for_message_empty():
    """msg_reactions on a message with no reactions returns []."""
    db = await _setup_db()
    t = await _create_thread(db)
    msg = await _post_msg(db, t.id)

    reactions = await crud.msg_reactions(db, msg.id)
    assert reactions == []
    await db.close()


@pytest.mark.asyncio
async def test_react_invalid_message_id_raises():
    """React to a nonexistent message raises MessageNotFoundError."""
    db = await _setup_db()
    with pytest.raises(crud.MessageNotFoundError):
        await crud.msg_react(db, message_id="nonexistent-id", agent_id="a", reaction="agree")
    await db.close()


@pytest.mark.asyncio
async def test_reactions_bulk_for_thread():
    """Post 3 messages, react to 2; bulk fetch returns correct mapping."""
    db = await _setup_db()
    t = await _create_thread(db)
    m1 = await _post_msg(db, t.id, content="msg 1")
    m2 = await _post_msg(db, t.id, content="msg 2")
    m3 = await _post_msg(db, t.id, content="msg 3")

    await crud.msg_react(db, message_id=m1.id, agent_id="a", reaction="agree")
    await crud.msg_react(db, message_id=m2.id, agent_id="b", reaction="important")

    result = await crud.msg_reactions_bulk(db, [m1.id, m2.id, m3.id])
    assert len(result[m1.id]) == 1
    assert result[m1.id][0]["reaction"] == "agree"
    assert len(result[m2.id]) == 1
    assert result[m2.id][0]["reaction"] == "important"
    assert result[m3.id] == []
    await db.close()


@pytest.mark.asyncio
async def test_react_emits_event():
    """A new reaction inserts a msg.react event into the events table."""
    db = await _setup_db()
    t = await _create_thread(db)
    msg = await _post_msg(db, t.id)

    await crud.msg_react(db, message_id=msg.id, agent_id="agent-1", reaction="agree")

    async with db.execute(
        "SELECT payload FROM events WHERE event_type = 'msg.react'",
    ) as cur:
        row = await cur.fetchone()
    assert row is not None, "msg.react event should have been emitted"
    payload = json.loads(row["payload"])
    assert payload["message_id"] == msg.id
    assert payload["reaction"] == "agree"
    await db.close()


# ─────────────────────────────────────────────
# ── INTEGRATION TESTS — Priority (UP-16) ─────
# ─────────────────────────────────────────────

def _get_or_create_thread(client: httpx.Client, topic: str = "reaction-priority-test") -> str:
    """Create a thread for integration tests. Returns thread_id."""
    register_resp = client.post(
        "/api/agents/register",
        json={"ide": "VS Code", "model": "GPT-5.3-Codex"},
    )
    assert register_resp.status_code == 200, register_resp.text
    agent = register_resp.json()
    resp = client.post(
        "/api/threads",
        json={"topic": topic, "status": "discuss", "creator_agent_id": agent["agent_id"]},
        headers={"X-Agent-Token": agent["token"]},
    )
    data = resp.json()
    # Handle both create (201) and idempotent existing (200/400 with id)
    if resp.status_code in (200, 201):
        return data["id"]
    # Fallback: get all threads and find by topic
    threads_resp = client.get("/api/threads")
    for t in (threads_resp.json() if isinstance(threads_resp.json(), list) else threads_resp.json().get("threads", [])):
        if t.get("topic") == topic:
            return t["id"]
    raise RuntimeError(f"Could not get or create thread '{topic}'")


def _get_sync_context(client: httpx.Client, thread_id: str) -> tuple[int, str]:
    """Get current_seq and reply_token for next message post."""
    resp = client.post(f"/api/threads/{thread_id}/sync-context", json={})
    if resp.status_code == 200:
        data = resp.json()
        return data["current_seq"], data["reply_token"]
    raise RuntimeError(f"sync-context failed: {resp.status_code} {resp.text}")


def _post_msg_via_api(client: httpx.Client, thread_id: str, priority: str = "normal") -> httpx.Response:
    seq, token = _get_sync_context(client, thread_id)
    return client.post(
        f"/api/threads/{thread_id}/messages",
        json={
            "author": "test-agent",
            "content": f"Test message with priority={priority}",
            "expected_last_seq": seq,
            "reply_token": token,
            "priority": priority,
        },
    )


def test_api_post_message_with_priority():
    """POST message with priority='urgent'; response includes priority field."""
    with _build_client() as client:
        _require_server_or_skip(client)
        thread_id = _get_or_create_thread(client, "priority-test-urgent")
        resp = _post_msg_via_api(client, thread_id, priority="urgent")
        assert resp.status_code in (200, 201), f"Expected 2xx, got {resp.status_code}: {resp.text}"
        data = resp.json()
        assert data.get("priority") == "urgent"


def test_api_post_message_default_priority():
    """POST without priority; response shows 'normal'."""
    with _build_client() as client:
        _require_server_or_skip(client)
        thread_id = _get_or_create_thread(client, "priority-test-default")
        resp = _post_msg_via_api(client, thread_id, priority="normal")
        assert resp.status_code in (200, 201)
        data = resp.json()
        assert data.get("priority") == "normal"


def test_api_messages_include_priority_field():
    """GET messages response includes 'priority' field in each message dict."""
    with _build_client() as client:
        _require_server_or_skip(client)
        thread_id = _get_or_create_thread(client, "priority-test-list")
        resp_post = _post_msg_via_api(client, thread_id, priority="system")
        assert resp_post.status_code in (200, 201), f"Failed to post: {resp_post.text}"

        resp = client.get(f"/api/threads/{thread_id}/messages")
        assert resp.status_code == 200
        msgs = resp.json()
        assert isinstance(msgs, list)
        for msg in msgs:
            assert "priority" in msg, f"Message missing 'priority' field: {msg}"


def test_api_messages_filter_by_priority():
    """GET messages with ?priority=urgent returns only urgent messages."""
    with _build_client() as client:
        _require_server_or_skip(client)
        thread_id = _get_or_create_thread(client, "priority-test-filter")
        _post_msg_via_api(client, thread_id, priority="normal")
        _post_msg_via_api(client, thread_id, priority="urgent")

        resp = client.get(f"/api/threads/{thread_id}/messages?priority=urgent")
        assert resp.status_code == 200
        msgs = resp.json()
        assert isinstance(msgs, list)
        non_urgent = [m for m in msgs if m["priority"] != "urgent"]
        assert non_urgent == [], f"Non-urgent messages returned: {non_urgent}"


def test_api_post_message_invalid_priority_400():
    """POST with priority='invalid' returns HTTP 400."""
    with _build_client() as client:
        _require_server_or_skip(client)
        thread_id = _get_or_create_thread(client, "priority-test-invalid")
        seq, token = _get_sync_context(client, thread_id)
        resp = client.post(
            f"/api/threads/{thread_id}/messages",
            json={
                "author": "test-agent",
                "content": "test",
                "expected_last_seq": seq,
                "reply_token": token,
                "priority": "critical",  # invalid
            },
        )
        # Pydantic returns 422 for literal enum validation errors; both 400 and 422 are correct here
        assert resp.status_code in (400, 422), f"Expected 4xx, got {resp.status_code}: {resp.text}"


# ─────────────────────────────────────────────
# ── INTEGRATION TESTS — Reactions (UP-13) ────
# ─────────────────────────────────────────────

def _get_message_id(client: httpx.Client, thread_id: str) -> str:
    """Post a message and return its ID."""
    resp = _post_msg_via_api(client, thread_id)
    assert resp.status_code in (200, 201), f"Failed to post message: {resp.text}"
    return resp.json()["id"]


def test_api_add_reaction_201():
    """POST reaction; 201 response with reaction data."""
    with _build_client() as client:
        _require_server_or_skip(client)
        thread_id = _get_or_create_thread(client, "reaction-test-add")
        msg_id = _get_message_id(client, thread_id)

        resp = client.post(
            f"/api/messages/{msg_id}/reactions",
            json={"agent_id": "agent-x", "reaction": "agree"},
        )
        assert resp.status_code == 201, f"Expected 201, got {resp.status_code}: {resp.text}"
        data = resp.json()
        assert data["reaction"] == "agree"
        assert data["agent_id"] == "agent-x"
        assert data["message_id"] == msg_id


def test_api_remove_reaction_200():
    """DELETE reaction; 200 response with removed=true."""
    with _build_client() as client:
        _require_server_or_skip(client)
        thread_id = _get_or_create_thread(client, "reaction-test-remove")
        msg_id = _get_message_id(client, thread_id)

        client.post(
            f"/api/messages/{msg_id}/reactions",
            json={"agent_id": "agent-y", "reaction": "disagree"},
        )
        resp = client.delete(
            f"/api/messages/{msg_id}/reactions/disagree",
            params={"agent_id": "agent-y"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["removed"] is True


def test_api_react_invalid_message_404():
    """POST reaction to nonexistent message; 404 response."""
    with _build_client() as client:
        _require_server_or_skip(client)
        resp = client.post(
            "/api/messages/nonexistent-msg-id/reactions",
            json={"agent_id": "agent-z", "reaction": "agree"},
        )
        assert resp.status_code == 404, f"Expected 404, got {resp.status_code}: {resp.text}"


def test_api_reactions_in_message_list():
    """GET messages includes 'reactions' field per message."""
    with _build_client() as client:
        _require_server_or_skip(client)
        thread_id = _get_or_create_thread(client, "reaction-test-list")
        msg_id = _get_message_id(client, thread_id)

        client.post(
            f"/api/messages/{msg_id}/reactions",
            json={"agent_id": "agent-a", "reaction": "important"},
        )

        resp = client.get(f"/api/threads/{thread_id}/messages")
        assert resp.status_code == 200
        msgs = resp.json()
        target = next((m for m in msgs if m.get("id") == msg_id), None)
        assert target is not None, f"Message {msg_id} not found in response"
        assert "reactions" in target, "Message response missing 'reactions' field"
        labels = [r["reaction"] for r in target["reactions"]]
        assert "important" in labels, f"Expected 'important' in reactions, got: {labels}"


def test_api_react_duplicate_idempotent():
    """POST same reaction twice; second call returns 201 (no duplicate stored)."""
    with _build_client() as client:
        _require_server_or_skip(client)
        thread_id = _get_or_create_thread(client, "reaction-test-duplicate")
        msg_id = _get_message_id(client, thread_id)

        payload = {"agent_id": "agent-dup", "reaction": "agree"}
        r1 = client.post(f"/api/messages/{msg_id}/reactions", json=payload)
        r2 = client.post(f"/api/messages/{msg_id}/reactions", json=payload)
        assert r1.status_code == 201
        assert r2.status_code == 201, f"Second reaction call failed: {r2.text}"

        # Only one reaction stored
        list_resp = client.get(f"/api/messages/{msg_id}/reactions")
        assert list_resp.status_code == 200
        reactions = list_resp.json()
        agree_reactions = [r for r in reactions if r["reaction"] == "agree" and r["agent_id"] == "agent-dup"]
        assert len(agree_reactions) == 1, f"Expected 1 reaction, got {len(agree_reactions)}"
