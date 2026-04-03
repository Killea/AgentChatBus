"""
Unit and integration tests for UP-21: message edit/versioning.

Unit tests use an in-memory SQLite DB via aiosqlite + init_schema.
Integration tests use httpx against the test server (TEST_BASE_URL from _constants).
"""
import pytest
import aiosqlite
import httpx

from agentchatbus.db.database import init_schema
from agentchatbus.db import crud
from tests._constants import TEST_BASE_URL as BASE_URL


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _make_db():
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)
    return db


async def _post(db, thread_id, author, content):
    sync = await crud.issue_reply_token(db, thread_id=thread_id)
    return await crud.msg_post(
        db,
        thread_id=thread_id,
        author=author,
        content=content,
        expected_last_seq=0,
        reply_token=sync["reply_token"],
    )


# ═══════════════════════════════════════════════════════════════════════════════
# UNIT TESTS (in-memory DB)
# ═══════════════════════════════════════════════════════════════════════════════


async def test_msg_edit_updates_content():
    """msg_edit replaces messages.content with the new value."""
    db = await _make_db()
    t = await crud.thread_create(db, "edit-test")
    msg = await _post(db, t.id, "agent-a", "original content")

    await crud.msg_edit(db, msg.id, "updated content", "agent-a")

    updated = await crud.msg_get(db, msg.id)
    assert updated.content == "updated content"
    await db.close()


async def test_msg_edit_creates_history_entry():
    """msg_edit inserts a record in message_edits with old_content."""
    db = await _make_db()
    t = await crud.thread_create(db, "edit-test")
    msg = await _post(db, t.id, "agent-a", "original content")

    await crud.msg_edit(db, msg.id, "new content", "agent-a")

    history = await crud.msg_edit_history(db, msg.id)
    assert len(history) == 1
    assert history[0].old_content == "original content"
    assert history[0].edited_by == "agent-a"
    assert history[0].version == 1
    await db.close()


async def test_msg_edit_increments_version():
    """Each successive edit increments version by 1."""
    db = await _make_db()
    t = await crud.thread_create(db, "edit-test")
    msg = await _post(db, t.id, "agent-a", "v0")

    await crud.msg_edit(db, msg.id, "v1", "agent-a")
    await crud.msg_edit(db, msg.id, "v2", "agent-a")
    await crud.msg_edit(db, msg.id, "v3", "agent-a")

    updated = await crud.msg_get(db, msg.id)
    assert updated.edit_version == 3
    history = await crud.msg_edit_history(db, msg.id)
    assert len(history) == 3
    assert [e.version for e in history] == [1, 2, 3]
    await db.close()


async def test_msg_edit_sets_edited_at():
    """msg_edit sets messages.edited_at to a non-null datetime."""
    db = await _make_db()
    t = await crud.thread_create(db, "edit-test")
    msg = await _post(db, t.id, "agent-a", "hello")

    assert msg.edited_at is None
    assert msg.edit_version == 0

    await crud.msg_edit(db, msg.id, "hello world", "agent-a")

    updated = await crud.msg_get(db, msg.id)
    assert updated.edited_at is not None
    await db.close()


async def test_msg_edit_preserves_old_content():
    """old_content in message_edits matches the pre-edit content exactly."""
    db = await _make_db()
    t = await crud.thread_create(db, "edit-test")
    original = "this is the original message body with some text"
    msg = await _post(db, t.id, "agent-a", original)

    await crud.msg_edit(db, msg.id, "completely different", "agent-a")

    history = await crud.msg_edit_history(db, msg.id)
    assert history[0].old_content == original
    await db.close()


async def test_msg_edit_author_only_permission():
    """PermissionError when edited_by does not match the original author."""
    db = await _make_db()
    t = await crud.thread_create(db, "edit-test")
    msg = await _post(db, t.id, "agent-a", "original")

    with pytest.raises(PermissionError):
        await crud.msg_edit(db, msg.id, "hijacked", "agent-b")
    await db.close()


async def test_msg_edit_system_can_edit_any_message():
    """'system' is allowed to edit any message regardless of author."""
    db = await _make_db()
    t = await crud.thread_create(db, "edit-test")
    msg = await _post(db, t.id, "agent-a", "original")

    edit = await crud.msg_edit(db, msg.id, "corrected by system", "system")

    assert edit.edited_by == "system"
    updated = await crud.msg_get(db, msg.id)
    assert updated.content == "corrected by system"
    await db.close()


async def test_msg_edit_system_role_cannot_be_edited():
    """Messages with role='system' cannot be edited (PermissionError)."""
    db = await _make_db()
    t = await crud.thread_create(db, "edit-test")
    sync = await crud.issue_reply_token(db, thread_id=t.id)
    sys_msg = await crud.msg_post(
        db,
        thread_id=t.id,
        author="system",
        content="system event",
        expected_last_seq=0,
        reply_token=sync["reply_token"],
        role="system",
    )

    with pytest.raises(PermissionError, match="System messages cannot be edited"):
        await crud.msg_edit(db, sys_msg.id, "tampered content", "system")
    await db.close()


async def test_msg_edit_same_content_raises_noop():
    """MessageEditNoChangeError is raised when new_content equals current content."""
    db = await _make_db()
    t = await crud.thread_create(db, "edit-test")
    msg = await _post(db, t.id, "agent-a", "same content")

    caught = None
    try:
        await crud.msg_edit(db, msg.id, "same content", "agent-a")
    except crud.MessageEditNoChangeError as exc:
        caught = exc

    assert caught is not None, "MessageEditNoChangeError was not raised"
    assert caught.current_version == 0
    await db.close()


async def test_msg_edit_noop_carries_current_version():
    """MessageEditNoChangeError.current_version reflects post-edit state."""
    db = await _make_db()
    t = await crud.thread_create(db, "edit-test")
    msg = await _post(db, t.id, "agent-a", "v0")

    await crud.msg_edit(db, msg.id, "v1", "agent-a")

    caught = None
    try:
        await crud.msg_edit(db, msg.id, "v1", "agent-a")  # same as current
    except crud.MessageEditNoChangeError as exc:
        caught = exc

    assert caught is not None, "MessageEditNoChangeError was not raised"
    assert caught.current_version == 1
    await db.close()


async def test_msg_edit_nonexistent_message():
    """MessageNotFoundError is raised when message_id does not exist."""
    db = await _make_db()
    await init_schema(db)

    caught = None
    try:
        await crud.msg_edit(db, "nonexistent-id", "content", "agent-a")
    except crud.MessageNotFoundError as exc:
        caught = exc

    assert caught is not None, "MessageNotFoundError was not raised"
    await db.close()


async def test_msg_edit_updates_fts_index():
    """After edit, msg_search returns results for the new content, not the old."""
    db = await _make_db()
    t = await crud.thread_create(db, "edit-fts-test")
    unique_old = "xkzqftsold"
    unique_new = "xkzqftsnew"
    msg = await _post(db, t.id, "agent-a", f"some text with {unique_old} keyword")

    await crud.msg_edit(db, msg.id, f"some text with {unique_new} keyword", "agent-a")

    old_results = await crud.msg_search(db, unique_old)
    new_results = await crud.msg_search(db, unique_new)

    assert len(old_results) == 0, "FTS should no longer match old content"
    assert len(new_results) == 1, "FTS should match new content"
    await db.close()


async def test_msg_edit_history_returns_all_versions():
    """msg_edit_history returns one entry per edit performed."""
    db = await _make_db()
    t = await crud.thread_create(db, "edit-test")
    msg = await _post(db, t.id, "agent-a", "v0")

    await crud.msg_edit(db, msg.id, "v1", "agent-a")
    await crud.msg_edit(db, msg.id, "v2", "agent-a")

    history = await crud.msg_edit_history(db, msg.id)
    assert len(history) == 2
    assert history[0].old_content == "v0"
    assert history[1].old_content == "v1"
    await db.close()


async def test_msg_edit_history_empty_for_unedited_message():
    """msg_edit_history returns [] when no edits have been applied."""
    db = await _make_db()
    t = await crud.thread_create(db, "edit-test")
    msg = await _post(db, t.id, "agent-a", "untouched")

    history = await crud.msg_edit_history(db, msg.id)
    assert history == []
    await db.close()


async def test_msg_edit_history_ordered_by_version():
    """msg_edit_history entries are ordered by version ascending."""
    db = await _make_db()
    t = await crud.thread_create(db, "edit-test")
    msg = await _post(db, t.id, "agent-a", "v0")

    await crud.msg_edit(db, msg.id, "v1", "agent-a")
    await crud.msg_edit(db, msg.id, "v2", "agent-a")
    await crud.msg_edit(db, msg.id, "v3", "agent-a")

    history = await crud.msg_edit_history(db, msg.id)
    versions = [e.version for e in history]
    assert versions == sorted(versions)
    await db.close()


async def test_msg_list_includes_edit_fields():
    """msg_list response includes edited_at (None) and edit_version (0) for new messages."""
    db = await _make_db()
    t = await crud.thread_create(db, "edit-test")
    await _post(db, t.id, "agent-a", "some message")

    msgs = await crud.msg_list(db, t.id)
    real_msgs = [m for m in msgs if not m.id.startswith("sys-")]
    assert len(real_msgs) >= 1
    for m in real_msgs:
        assert hasattr(m, "edited_at")
        assert hasattr(m, "edit_version")
        assert m.edit_version == 0
    await db.close()


async def test_msg_list_reflects_edit_fields_after_edit():
    """msg_list shows non-null edited_at and incremented edit_version after an edit."""
    db = await _make_db()
    t = await crud.thread_create(db, "edit-test")
    msg = await _post(db, t.id, "agent-a", "before edit")

    await crud.msg_edit(db, msg.id, "after edit", "agent-a")

    msgs = await crud.msg_list(db, t.id)
    target = next((m for m in msgs if m.id == msg.id), None)
    assert target is not None
    assert target.content == "after edit"
    assert target.edited_at is not None
    assert target.edit_version == 1
    await db.close()


# ═══════════════════════════════════════════════════════════════════════════════
# INTEGRATION TESTS (REST API against test server)
# ═══════════════════════════════════════════════════════════════════════════════


def _build_client() -> httpx.Client:
    return httpx.Client(base_url=BASE_URL, timeout=10)


def _require_server_or_skip(client: httpx.Client) -> None:
    try:
        resp = client.get("/health")
        if resp.status_code == 200:
            return
    except Exception:
        pass
    pytest.skip(f"AgentChatBus server not reachable at {BASE_URL}")


def _create_thread_and_message(client: httpx.Client, topic_suffix: str) -> tuple[str, str]:
    """Create a thread + post one message, return (thread_id, msg_id, agent_id)."""
    agent_resp = client.post("/api/agents/register", json={
        "name": "test-edit-agent",
        "ide": "pytest",
        "model": "test",
        "description": "integration test agent for edit",
    })
    agent_data = agent_resp.json()
    agent_id = agent_data["agent_id"]
    agent_token = agent_data["token"]

    thread_resp = client.post("/api/threads", json={
        "topic": f"edit-test-{topic_suffix}",
        "creator_agent_id": agent_id,
    }, headers={"X-Agent-Token": agent_token})
    thread_id = thread_resp.json()["id"]

    sync_resp = client.post(f"/api/threads/{thread_id}/sync-context", json={"agent_id": agent_id})
    sync = sync_resp.json()

    msg_resp = client.post(f"/api/threads/{thread_id}/messages", json={
        "author": agent_id,
        "content": "original message for edit test",
        "expected_last_seq": sync["current_seq"],
        "reply_token": sync["reply_token"],
    }, headers={"X-Agent-Token": agent_token})
    msg_data = msg_resp.json()
    msg_id = msg_data["id"]
    # msg.author is the display name resolved by the server, not the UUID
    author_name = msg_data.get("author", agent_id)
    return thread_id, msg_id, author_name


def test_api_edit_message_200():
    """PUT /api/messages/{id} returns 200 with version and edited_at."""
    with _build_client() as client:
        _require_server_or_skip(client)
        _, msg_id, agent_id = _create_thread_and_message(client, "200")

        resp = client.put(f"/api/messages/{msg_id}", json={
            "content": "updated content via REST",
            "edited_by": agent_id,
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["msg_id"] == msg_id
        assert body["version"] == 1
        assert "edited_at" in body


def test_api_edit_message_403_wrong_author():
    """PUT /api/messages/{id} returns 403 when edited_by is not the original author."""
    with _build_client() as client:
        _require_server_or_skip(client)
        _, msg_id, _ = _create_thread_and_message(client, "403")

        resp = client.put(f"/api/messages/{msg_id}", json={
            "content": "hijack attempt",
            "edited_by": "wrong-agent-id",
        })
        assert resp.status_code == 403


def test_api_edit_message_404_not_found():
    """PUT /api/messages/{id} returns 404 for a non-existent message."""
    with _build_client() as client:
        _require_server_or_skip(client)

        resp = client.put("/api/messages/nonexistent-msg-id", json={
            "content": "does not matter",
            "edited_by": "agent-x",
        })
        assert resp.status_code == 404


def test_api_edit_message_no_change_returns_200():
    """PUT with identical content returns 200 with no_change=true."""
    with _build_client() as client:
        _require_server_or_skip(client)
        _, msg_id, agent_id = _create_thread_and_message(client, "noop")

        resp = client.put(f"/api/messages/{msg_id}", json={
            "content": "original message for edit test",
            "edited_by": agent_id,
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body.get("no_change") is True
        assert "version" in body


def test_api_edit_history_200():
    """GET /api/messages/{id}/history returns edit history after edits."""
    with _build_client() as client:
        _require_server_or_skip(client)
        _, msg_id, agent_id = _create_thread_and_message(client, "history")

        client.put(f"/api/messages/{msg_id}", json={
            "content": "first edit",
            "edited_by": agent_id,
        })
        client.put(f"/api/messages/{msg_id}", json={
            "content": "second edit",
            "edited_by": agent_id,
        })

        resp = client.get(f"/api/messages/{msg_id}/history")
        assert resp.status_code == 200
        body = resp.json()
        assert body["message_id"] == msg_id
        assert body["edit_version"] == 2
        assert len(body["edits"]) == 2
        assert body["edits"][0]["version"] == 1
        assert body["edits"][1]["version"] == 2


def test_api_messages_include_edit_fields():
    """GET /api/threads/{id}/messages includes edited_at and edit_version."""
    with _build_client() as client:
        _require_server_or_skip(client)
        thread_id, msg_id, agent_id = _create_thread_and_message(client, "fields")

        resp = client.get(f"/api/threads/{thread_id}/messages")
        assert resp.status_code == 200
        msgs = resp.json()
        real = [m for m in msgs if m.get("id") == msg_id]
        assert len(real) == 1
        assert "edited_at" in real[0]
        assert "edit_version" in real[0]
        assert real[0]["edit_version"] == 0
        assert real[0]["edited_at"] is None
