"""
Unit tests for UP-02: Conversation Timeout.
Tests thread_timeout_sweep() without requiring a running server.

Design note: DB_PATH is fixed at import time, so we use unique thread topics
to avoid cross-test state pollution.
"""
import os
import asyncio
import pytest
from datetime import datetime, timezone, timedelta
import src.db.crud as crud_mod
import src.db.database as dbmod

os.environ["AGENTCHATBUS_DB"] = "data/test_timeout_unit.db"


from contextlib import asynccontextmanager


@asynccontextmanager
async def db_context():
    # Always close any existing connection and open a new one for isolation
    try:
        await dbmod.close_db()
    except Exception:
        pass
    db = await dbmod.get_db()
    try:
        # Clean up any existing test data
        await db.execute("DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE topic LIKE 'timeout-%')")
        await db.execute("DELETE FROM threads WHERE topic LIKE 'timeout-%'")
        await db.commit()
        yield db
    finally:
        try:
            await dbmod.close_db()
        except Exception:
            pass


# ─────────────────────────────────────────────
# Helper: back-date a thread's last message or creation time
# ─────────────────────────────────────────────

async def _backdate_thread(db, thread_id: str, minutes_ago: int) -> None:
    """Force a thread's creation time into the past for timeout testing."""
    old_time = (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat()
    await db.execute("UPDATE threads SET created_at = ? WHERE id = ?", (old_time, thread_id))
    await db.commit()


async def _backdate_message(db, thread_id: str, minutes_ago: int) -> None:
    """Force all messages in a thread into the past."""
    old_time = (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat()
    await db.execute("UPDATE messages SET created_at = ? WHERE thread_id = ?", (old_time, thread_id))
    await db.commit()


async def _get_thread_status(db, thread_id: str) -> str:
    async with db.execute("SELECT status FROM threads WHERE id = ?", (thread_id,)) as cur:
        row = await cur.fetchone()
    return row["status"] if row else "not_found"


async def _get_db():
    # Always close any existing connection and open a new one for isolation
    try:
        await dbmod.close_db()
    except Exception:
        pass
    db = await dbmod.get_db()
    return dbmod._db


# ─────────────────────────────────────────────
# Tests
# ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_timeout_sweep_disabled_returns_empty():
    """thread_timeout_sweep with 0 minutes must return [] immediately."""
    async with db_context() as db:
        result = await crud_mod.thread_timeout_sweep(db, timeout_minutes=0)
        assert result == []


@pytest.mark.asyncio
async def test_timeout_sweep_closes_stale_empty_thread():
    """A thread with no messages, created long ago, must be auto-closed."""
    async with db_context() as db:
        thread = await crud_mod.thread_create(db, "timeout-stale-empty-thread")
        await _backdate_thread(db, thread.id, minutes_ago=61)

        closed = await crud_mod.thread_timeout_sweep(db, timeout_minutes=60)
        assert thread.id in closed
        assert await _get_thread_status(db, thread.id) == "closed"


@pytest.mark.asyncio
async def test_timeout_sweep_closes_stale_thread_with_old_messages():
    """A thread whose last message is older than timeout must be closed."""
    async with db_context() as db:
        thread = await crud_mod.thread_create(db, "timeout-stale-with-msg")
        await crud_mod.msg_post(db, thread.id, "agent", "Old message")
        await _backdate_message(db, thread.id, minutes_ago=61)
        await _backdate_thread(db, thread.id, minutes_ago=61)

        closed = await crud_mod.thread_timeout_sweep(db, timeout_minutes=60)
        assert thread.id in closed
        assert await _get_thread_status(db, thread.id) == "closed"


@pytest.mark.asyncio
async def test_timeout_sweep_keeps_active_thread():
    """A recently-active thread must NOT be closed by the sweep."""
    async with db_context() as db:
        thread = await crud_mod.thread_create(db, "timeout-active-thread")
        await crud_mod.msg_post(db, thread.id, "agent", "Recent message")
        # No backdating — thread is fresh

        closed = await crud_mod.thread_timeout_sweep(db, timeout_minutes=60)
        assert thread.id not in closed
        assert await _get_thread_status(db, thread.id) == "discuss"


@pytest.mark.asyncio
async def test_timeout_sweep_skips_already_closed():
    """An already-closed thread must not appear in sweep results."""
    async with db_context() as db:
        thread = await crud_mod.thread_create(db, "timeout-already-closed")
        # Manually close the thread
        await db.execute("UPDATE threads SET status = 'closed' WHERE id = ?", (thread.id,))
        await db.commit()
        await _backdate_thread(db, thread.id, minutes_ago=61)

        closed = await crud_mod.thread_timeout_sweep(db, timeout_minutes=60)
        assert thread.id not in closed


@pytest.mark.asyncio
async def test_timeout_sweep_independent_of_other_threads():
    """Only stale threads should be closed; active ones must survive."""
    async with db_context() as db:
        stale = await crud_mod.thread_create(db, "timeout-mix-stale")
        active = await crud_mod.thread_create(db, "timeout-mix-active")

        await _backdate_thread(db, stale.id, minutes_ago=61)
        await crud_mod.msg_post(db, active.id, "agent", "Fresh message")

        closed = await crud_mod.thread_timeout_sweep(db, timeout_minutes=60)
        assert stale.id in closed
        assert active.id not in closed
        assert await _get_thread_status(db, stale.id) == "closed"
        assert await _get_thread_status(db, active.id) == "discuss"


@pytest.mark.asyncio
async def test_timeout_sweep_returns_list_of_ids():
    """Sweep must return a list of closed thread IDs (strings)."""
    async with db_context() as db:
        thread = await crud_mod.thread_create(db, "timeout-id-list-test")
        await _backdate_thread(db, thread.id, minutes_ago=120)

        closed = await crud_mod.thread_timeout_sweep(db, timeout_minutes=60)
        assert isinstance(closed, list)
        assert all(isinstance(tid, str) for tid in closed)
        assert thread.id in closed
