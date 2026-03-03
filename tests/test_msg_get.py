"""
Tests for UP-24 — msg_get MCP tool.

Unit tests (in-memory DB, 4 tests):
  - msg_get: 4 tests

Total: 4 tests
"""
import aiosqlite
import pytest

from src.db import crud
from src.db.database import init_schema


# ─────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────

async def _make_db():
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)
    return db


async def _post(db, thread_id: str, author: str, content: str, reply_to_msg_id: str | None = None):
    sync = await crud.issue_reply_token(db, thread_id=thread_id)
    return await crud.msg_post(
        db,
        thread_id=thread_id,
        author=author,
        content=content,
        expected_last_seq=sync["current_seq"],
        reply_token=sync["reply_token"],
        reply_to_msg_id=reply_to_msg_id,
    )


# ─────────────────────────────────────────────
# Unit tests
# ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_msg_get_returns_message():
    """msg_get returns full message fields for a valid ID."""
    db = await _make_db()
    thread = await crud.thread_create(db, "get-test")
    msg = await _post(db, thread.id, "agent-a", "hello world")

    result = await crud.msg_get(db, msg.id)

    assert result is not None
    assert result.id == msg.id
    assert result.thread_id == thread.id
    assert result.author == "agent-a"
    assert result.content == "hello world"
    assert result.seq == msg.seq
    assert result.role == "user"
    assert result.priority == "normal"
    assert result.reply_to_msg_id is None
    await db.close()


@pytest.mark.asyncio
async def test_msg_get_not_found():
    """msg_get returns None for a non-existent message ID."""
    db = await _make_db()
    await init_schema(db)

    result = await crud.msg_get(db, "msg-does-not-exist")

    assert result is None
    await db.close()


@pytest.mark.asyncio
async def test_msg_get_includes_reactions():
    """msg_get returns message; reactions can be fetched via msg_reactions for the same ID."""
    db = await _make_db()
    thread = await crud.thread_create(db, "reaction-get-test")
    agent = await crud.agent_register(db, ide="Cursor", model="GPT-4")
    msg = await _post(db, thread.id, agent.id, "important message")

    await crud.msg_react(db, msg.id, agent.id, "agree")

    result = await crud.msg_get(db, msg.id)
    assert result is not None
    assert result.id == msg.id

    reactions = await crud.msg_reactions(db, msg.id)
    assert len(reactions) == 1
    assert reactions[0].reaction == "agree"
    assert reactions[0].agent_id == agent.id
    await db.close()


@pytest.mark.asyncio
async def test_msg_get_with_reply_to():
    """msg_get preserves reply_to_msg_id when set at post time."""
    db = await _make_db()
    thread = await crud.thread_create(db, "reply-get-test")
    parent = await _post(db, thread.id, "agent-a", "original message")
    reply = await _post(db, thread.id, "agent-b", "reply message", reply_to_msg_id=parent.id)

    result = await crud.msg_get(db, reply.id)

    assert result is not None
    assert result.reply_to_msg_id == parent.id
    await db.close()
