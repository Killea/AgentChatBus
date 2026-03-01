"""
Tests for UP-17: Structured message metadata attachments.

Covers:
- handoff_target / stop_reason stored in metadata (unit, in-memory DB)
- msg.handoff and msg.stop SSE events emitted (unit)
- for_agent filter in msg_wait dispatch (unit)
- metadata preserved in msg_list (unit)
- HTTP integration: POST/GET with metadata, handoff_target and stop_reason fields
"""
import asyncio
import json
import os

import aiosqlite
import httpx
import pytest

from src.db import crud
from src.db.database import init_schema

BASE_URL = os.getenv("AGENTCHATBUS_BASE_URL", "http://127.0.0.1:39766")


# ─────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────

def _build_client() -> httpx.Client:
    return httpx.Client(base_url=BASE_URL, timeout=10)


def _require_server_or_skip(client: httpx.Client) -> None:
    try:
        resp = client.get("/api/threads")
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
async def test_msg_post_with_handoff_target():
    """msg_post stores handoff_target in metadata."""
    db = await _setup_db()
    try:
        thread = await crud.thread_create(db, "handoff-test-thread")
        msg = await crud.msg_post(
            db,
            thread_id=thread.id,
            author="agent-a",
            content="Handing off to you",
            metadata={"handoff_target": "agent-b"},
        )
        assert msg.metadata is not None
        meta = json.loads(msg.metadata)
        assert meta["handoff_target"] == "agent-b"
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_msg_post_with_stop_reason():
    """msg_post stores stop_reason in metadata."""
    db = await _setup_db()
    try:
        thread = await crud.thread_create(db, "stop-reason-test")
        msg = await crud.msg_post(
            db,
            thread_id=thread.id,
            author="agent-a",
            content="I'm done",
            metadata={"stop_reason": "convergence"},
        )
        assert msg.metadata is not None
        meta = json.loads(msg.metadata)
        assert meta["stop_reason"] == "convergence"
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_msg_post_with_both():
    """msg_post stores both handoff_target and stop_reason."""
    db = await _setup_db()
    try:
        thread = await crud.thread_create(db, "both-meta-test")
        msg = await crud.msg_post(
            db,
            thread_id=thread.id,
            author="agent-a",
            content="Done and passing over",
            metadata={"handoff_target": "agent-b", "stop_reason": "complete"},
        )
        meta = json.loads(msg.metadata)
        assert meta["handoff_target"] == "agent-b"
        assert meta["stop_reason"] == "complete"
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_msg_post_backward_compat():
    """msg_post with no metadata still works correctly."""
    db = await _setup_db()
    try:
        thread = await crud.thread_create(db, "no-meta-test")
        msg = await crud.msg_post(
            db,
            thread_id=thread.id,
            author="agent-a",
            content="Plain message",
        )
        assert msg.metadata is None
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_msg_post_handoff_event():
    """msg_post emits msg.handoff SSE event when handoff_target is provided."""
    db = await _setup_db()
    try:
        thread = await crud.thread_create(db, "handoff-event-test")
        await crud.msg_post(
            db,
            thread_id=thread.id,
            author="agent-a",
            content="Passing to agent-b",
            metadata={"handoff_target": "agent-b"},
        )
        async with db.execute(
            "SELECT * FROM events WHERE event_type = 'msg.handoff' ORDER BY id DESC LIMIT 1"
        ) as cur:
            row = await cur.fetchone()
        assert row is not None, "msg.handoff event should have been emitted"
        payload = json.loads(row["payload"])
        assert payload["to_agent"] == "agent-b"
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_msg_post_stop_event():
    """msg_post emits msg.stop SSE event when stop_reason is provided."""
    db = await _setup_db()
    try:
        thread = await crud.thread_create(db, "stop-event-test")
        await crud.msg_post(
            db,
            thread_id=thread.id,
            author="agent-a",
            content="Stopping now",
            metadata={"stop_reason": "impasse"},
        )
        async with db.execute(
            "SELECT * FROM events WHERE event_type = 'msg.stop' ORDER BY id DESC LIMIT 1"
        ) as cur:
            row = await cur.fetchone()
        assert row is not None, "msg.stop event should have been emitted"
        payload = json.loads(row["payload"])
        assert payload["reason"] == "impasse"
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_msg_post_no_handoff_event_when_missing():
    """msg_post does NOT emit msg.handoff when no handoff_target."""
    db = await _setup_db()
    try:
        thread = await crud.thread_create(db, "no-handoff-event-test")
        await crud.msg_post(
            db,
            thread_id=thread.id,
            author="agent-a",
            content="Regular message",
        )
        async with db.execute(
            "SELECT COUNT(*) AS cnt FROM events WHERE event_type = 'msg.handoff'"
        ) as cur:
            row = await cur.fetchone()
        assert row["cnt"] == 0
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_metadata_preserved_in_msg_list():
    """metadata is returned in msg_list results."""
    db = await _setup_db()
    try:
        thread = await crud.thread_create(db, "meta-list-test")
        await crud.msg_post(
            db,
            thread_id=thread.id,
            author="agent-a",
            content="With metadata",
            metadata={"handoff_target": "agent-b", "stop_reason": "complete"},
        )
        msgs = await crud.msg_list(db, thread.id, after_seq=0, include_system_prompt=False)
        assert len(msgs) == 1
        assert msgs[0].metadata is not None
        meta = json.loads(msgs[0].metadata)
        assert meta["handoff_target"] == "agent-b"
        assert meta["stop_reason"] == "complete"
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_msg_wait_for_agent_match():
    """msg_wait for_agent filter returns only matching messages."""
    from src.tools.dispatch import _metadata_targets
    db = await _setup_db()
    try:
        thread = await crud.thread_create(db, "for-agent-match-test")
        # Post a message directed to agent-b
        msg = await crud.msg_post(
            db,
            thread_id=thread.id,
            author="agent-a",
            content="Hey agent-b, your turn",
            metadata={"handoff_target": "agent-b"},
        )
        assert _metadata_targets(msg, "agent-b") is True
        assert _metadata_targets(msg, "agent-c") is False
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_msg_wait_for_agent_no_match():
    """_metadata_targets returns False when handoff_target doesn't match."""
    from src.tools.dispatch import _metadata_targets
    db = await _setup_db()
    try:
        thread = await crud.thread_create(db, "for-agent-nomatch-test")
        msg = await crud.msg_post(
            db,
            thread_id=thread.id,
            author="agent-a",
            content="General message",
        )
        assert _metadata_targets(msg, "agent-b") is False
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_msg_wait_no_filter_backward_compat():
    """Without for_agent, all messages are returned (backward compat)."""
    from src.tools.dispatch import _metadata_targets
    db = await _setup_db()
    try:
        thread = await crud.thread_create(db, "no-filter-test")
        msg = await crud.msg_post(
            db,
            thread_id=thread.id,
            author="agent-a",
            content="General message",
        )
        # Without for_agent filter, message should not be excluded
        msgs = await crud.msg_list(db, thread.id, after_seq=0, include_system_prompt=False)
        assert len(msgs) == 1
    finally:
        await db.close()


# ─────────────────────────────────────────────
# HTTP integration tests (require running server)
# ─────────────────────────────────────────────

@pytest.fixture(scope="module")
def test_thread_id() -> str:
    """Create a test thread for metadata integration tests."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = client.post("/api/threads", json={"topic": "UP-17 Metadata Integration Test"})
        assert r.status_code == 201, r.text
        return r.json()["id"]


def test_api_post_with_metadata(test_thread_id):
    """POST /api/threads/{id}/messages with handoff metadata succeeds."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = client.post(f"/api/threads/{test_thread_id}/messages", json={
            "author": "integration-agent",
            "content": "Handing off to peer",
            "metadata": {"handoff_target": "peer-agent", "stop_reason": "complete"},
        })
        assert r.status_code == 201, r.text
        data = r.json()
        assert "id" in data
        assert "seq" in data


def test_api_messages_include_metadata(test_thread_id):
    """GET /api/threads/{id}/messages includes metadata in response."""
    with _build_client() as client:
        _require_server_or_skip(client)
        # Post a message with metadata
        client.post(f"/api/threads/{test_thread_id}/messages", json={
            "author": "integration-agent",
            "content": "Message with metadata",
            "metadata": {"handoff_target": "target-agent"},
        })
        r = client.get(f"/api/threads/{test_thread_id}/messages")
        assert r.status_code == 200, r.text
        msgs = r.json()
        assert len(msgs) > 0
        # At least one message should have metadata
        meta_msgs = [m for m in msgs if m.get("metadata")]
        assert len(meta_msgs) > 0


def test_api_metadata_handoff_target(test_thread_id):
    """POST then GET verifies handoff_target is preserved."""
    with _build_client() as client:
        _require_server_or_skip(client)
        client.post(f"/api/threads/{test_thread_id}/messages", json={
            "author": "integration-agent",
            "content": "Directed handoff message",
            "metadata": {"handoff_target": "specific-target"},
        })
        r = client.get(f"/api/threads/{test_thread_id}/messages")
        assert r.status_code == 200
        msgs = r.json()
        handoff_msgs = []
        for m in msgs:
            raw_meta = m.get("metadata")
            if raw_meta:
                meta = json.loads(raw_meta) if isinstance(raw_meta, str) else raw_meta
                if meta.get("handoff_target") == "specific-target":
                    handoff_msgs.append(m)
        assert len(handoff_msgs) > 0, "handoff_target message should be in list"


def test_api_metadata_stop_reason(test_thread_id):
    """POST then GET verifies stop_reason is preserved."""
    with _build_client() as client:
        _require_server_or_skip(client)
        client.post(f"/api/threads/{test_thread_id}/messages", json={
            "author": "integration-agent",
            "content": "Convergence reached",
            "metadata": {"stop_reason": "convergence"},
        })
        r = client.get(f"/api/threads/{test_thread_id}/messages")
        assert r.status_code == 200
        msgs = r.json()
        stop_msgs = []
        for m in msgs:
            raw_meta = m.get("metadata")
            if raw_meta:
                meta = json.loads(raw_meta) if isinstance(raw_meta, str) else raw_meta
                if meta.get("stop_reason") == "convergence":
                    stop_msgs.append(m)
        assert len(stop_msgs) > 0, "stop_reason message should be in list"
