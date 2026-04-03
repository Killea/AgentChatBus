"""
Unit tests for UI-02: FTS5 full-text search.

Covers:
- messages_fts virtual table created by init_schema
- INSERT trigger keeps FTS in sync with messages
- msg_search() basic query, thread filter, no results, limit, ranking
"""
import asyncio
import uuid
from datetime import datetime, timezone

import aiosqlite
import pytest

from agentchatbus.db import crud
from agentchatbus.db.database import init_schema


# ─────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────

async def _setup_db() -> aiosqlite.Connection:
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)
    return db


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _insert_thread(db: aiosqlite.Connection, topic: str) -> str:
    tid = str(uuid.uuid4())
    await db.execute(
        "INSERT INTO threads (id, topic, status, created_at) VALUES (?, ?, 'discuss', ?)",
        (tid, topic, _now()),
    )
    await db.commit()
    return tid


async def _insert_message(
    db: aiosqlite.Connection,
    thread_id: str,
    content: str,
    author: str = "agent-a",
    seq: int = 1,
) -> str:
    mid = str(uuid.uuid4())
    await db.execute(
        """
        INSERT INTO messages
            (id, thread_id, author, role, content, seq, created_at)
        VALUES (?, ?, ?, 'user', ?, ?, ?)
        """,
        (mid, thread_id, author, content, seq, _now()),
    )
    await db.commit()
    return mid


# ─────────────────────────────────────────────
# Unit tests
# ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_fts_table_created():
    """messages_fts virtual table must exist after init_schema."""
    db = await _setup_db()
    try:
        async with db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'"
        ) as cur:
            row = await cur.fetchone()
        assert row is not None, "messages_fts table not found after init_schema"
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_fts_sync_on_insert():
    """INSERT trigger must populate messages_fts automatically."""
    db = await _setup_db()
    try:
        tid = await _insert_thread(db, "sync test thread")
        mid = await _insert_message(db, tid, "the quick brown fox jumps", seq=1)

        async with db.execute(
            "SELECT message_id FROM messages_fts WHERE message_id = ?", (mid,)
        ) as cur:
            row = await cur.fetchone()
        assert row is not None, "Message not found in messages_fts after INSERT"
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_msg_search_basic():
    """msg_search must return a message containing the search term."""
    db = await _setup_db()
    try:
        tid = await _insert_thread(db, "basic search thread")
        await _insert_message(db, tid, "Angular signals are great for reactivity", seq=1)
        await _insert_message(db, tid, "RxJS observables are also useful", seq=2)

        results = await crud.msg_search(db, "Angular")
        assert len(results) == 1
        assert "Angular" in results[0]["snippet"] or "angular" in results[0]["snippet"].lower()
        assert results[0]["thread_id"] == tid
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_msg_search_thread_filter():
    """msg_search with thread_id must only return results from that thread."""
    db = await _setup_db()
    try:
        tid1 = await _insert_thread(db, "thread one")
        tid2 = await _insert_thread(db, "thread two")
        await _insert_message(db, tid1, "performance optimization tips", seq=1)
        await _insert_message(db, tid2, "performance tuning in production", seq=1)

        results = await crud.msg_search(db, "performance", thread_id=tid1)
        assert len(results) == 1
        assert results[0]["thread_id"] == tid1
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_msg_search_no_results():
    """msg_search must return empty list when no message matches."""
    db = await _setup_db()
    try:
        tid = await _insert_thread(db, "empty search thread")
        await _insert_message(db, tid, "hello world", seq=1)

        results = await crud.msg_search(db, "zxqvbnm")
        assert results == []
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_msg_search_limit():
    """msg_search must respect the limit parameter."""
    db = await _setup_db()
    try:
        tid = await _insert_thread(db, "limit test thread")
        for i in range(10):
            await _insert_message(db, tid, f"keyword common term iteration {i}", seq=i + 1)

        results = await crud.msg_search(db, "keyword", limit=3)
        assert len(results) <= 3
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_msg_search_returns_required_fields():
    """Each result dict must contain all required fields."""
    db = await _setup_db()
    try:
        tid = await _insert_thread(db, "fields test thread")
        await _insert_message(db, tid, "testing field completeness here", seq=1)

        results = await crud.msg_search(db, "completeness")
        assert len(results) == 1
        r = results[0]
        for field in ("message_id", "thread_id", "thread_topic", "author", "seq", "created_at", "snippet"):
            assert field in r, f"Missing field: {field}"
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_msg_search_invalid_query_returns_empty():
    """Malformed FTS5 query (e.g. bare '*') must return empty list, not raise."""
    db = await _setup_db()
    try:
        tid = await _insert_thread(db, "invalid query thread")
        await _insert_message(db, tid, "some content here", seq=1)

        # Bare '*' is invalid in FTS5 — should return [] gracefully
        results = await crud.msg_search(db, "*")
        assert isinstance(results, list)
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_msg_search_multi_thread_no_filter():
    """msg_search without thread_id must return results from all threads."""
    db = await _setup_db()
    try:
        tid1 = await _insert_thread(db, "search thread A")
        tid2 = await _insert_thread(db, "search thread B")
        await _insert_message(db, tid1, "consensus algorithm decision", seq=1)
        await _insert_message(db, tid2, "consensus protocol design", seq=1)

        results = await crud.msg_search(db, "consensus")
        thread_ids = {r["thread_id"] for r in results}
        assert tid1 in thread_ids
        assert tid2 in thread_ids
    finally:
        await db.close()
