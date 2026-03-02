"""
Unit tests for UP-03: Rate Limiting.
Tests the rate limit logic and CRUD integration without requiring a running server.
"""
import pytest
import aiosqlite
import src.db.crud as crud_mod
from src.db.database import init_schema


# NOTE: Per-test DB cleanup is performed explicitly in each async test's
# finally block to avoid autouse async fixtures that interfere with sync tests.


# ─────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────

async def _get_db():
    """Return an isolated in-memory DB connection for the calling test."""
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)
    return db


async def _post_message(db, thread_id: str, author: str, content: str):
    sync = await crud_mod.issue_reply_token(db, thread_id=thread_id)
    return await crud_mod.msg_post(
        db,
        thread_id,
        author,
        content,
        expected_last_seq=sync["current_seq"],
        reply_token=sync["reply_token"],
    )


def _patch_rate_limit(limit: int):
    """Patch module-level rate limit constants. Returns (original_enabled, original_limit)."""
    orig_enabled = crud_mod.RATE_LIMIT_ENABLED
    orig_limit = crud_mod.RATE_LIMIT_MSG_PER_MINUTE
    crud_mod.RATE_LIMIT_ENABLED = limit > 0
    crud_mod.RATE_LIMIT_MSG_PER_MINUTE = limit
    return orig_enabled, orig_limit


def _restore_rate_limit(orig_enabled, orig_limit):
    crud_mod.RATE_LIMIT_ENABLED = orig_enabled
    crud_mod.RATE_LIMIT_MSG_PER_MINUTE = orig_limit


# ─────────────────────────────────────────────
# RateLimitExceeded exception unit tests (sync)
# ─────────────────────────────────────────────

class TestRateLimitExceeded:
    def test_attributes(self):
        exc = crud_mod.RateLimitExceeded(limit=30, window=60, retry_after=60, scope="author_id")
        assert exc.limit == 30
        assert exc.window == 60
        assert exc.retry_after == 60
        assert exc.scope == "author_id"

    def test_str_contains_limit_and_window(self):
        exc = crud_mod.RateLimitExceeded(limit=5, window=60, retry_after=60, scope="author")
        assert "5" in str(exc)
        assert "60" in str(exc)

    def test_scope_author_id(self):
        exc = crud_mod.RateLimitExceeded(limit=10, window=60, retry_after=30, scope="author_id")
        assert exc.scope == "author_id"

    def test_scope_author_fallback(self):
        exc = crud_mod.RateLimitExceeded(limit=10, window=60, retry_after=30, scope="author")
        assert exc.scope == "author"


# ─────────────────────────────────────────────
# CRUD-level rate limit tests (async)
# Each test uses unique authors to avoid cross-test state pollution.
# ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_rate_limit_allows_within_limit():
    """First N messages within the limit must succeed."""
    orig = _patch_rate_limit(3)
    try:
        db = await _get_db()
        thread = await crud_mod.thread_create(db, "rl-test-allow")
        for i in range(3):
            msg = await _post_message(db, thread.id, "rl-allow-user", f"Message {i}")
            assert msg.seq > 0
    finally:
        _restore_rate_limit(*orig)
        try:
            await db.close()
        except Exception:
            pass


@pytest.mark.asyncio
async def test_rate_limit_blocks_on_exceed():
    """The N+1 message must raise RateLimitExceeded."""
    orig = _patch_rate_limit(3)
    try:
        db = await _get_db()
        thread = await crud_mod.thread_create(db, "rl-test-exceed")
        for i in range(3):
            await _post_message(db, thread.id, "rl-exceed-user", f"Msg {i}")
        with pytest.raises(crud_mod.RateLimitExceeded) as exc_info:
            await _post_message(db, thread.id, "rl-exceed-user", "One too many")
        assert exc_info.value.limit == 3
        assert exc_info.value.window == 60
        assert exc_info.value.retry_after > 0
    finally:
        _restore_rate_limit(*orig)
        try:
            await db.close()
        except Exception:
            pass


@pytest.mark.asyncio
async def test_rate_limit_scopes_per_author():
    """Different authors must have independent rate limit counters."""
    orig = _patch_rate_limit(3)
    try:
        db = await _get_db()
        thread = await crud_mod.thread_create(db, "rl-test-scope")
        for i in range(3):
            await _post_message(db, thread.id, "rl-scope-A", f"Msg {i}")
        with pytest.raises(crud_mod.RateLimitExceeded):
            await _post_message(db, thread.id, "rl-scope-A", "Blocked!")
        # Author B must have their own independent counter
        msg = await _post_message(db, thread.id, "rl-scope-B", "Author B works")
        assert msg.seq > 0
    finally:
        _restore_rate_limit(*orig)
        try:
            await db.close()
        except Exception:
            pass


@pytest.mark.asyncio
async def test_rate_limit_normal_single_message():
    """A single message from a fresh author must always pass."""
    orig = _patch_rate_limit(3)
    try:
        db = await _get_db()
        thread = await crud_mod.thread_create(db, "rl-test-single")
        msg = await _post_message(db, thread.id, "rl-single-user", "Normal message")
        assert msg.seq > 0
    finally:
        _restore_rate_limit(*orig)
        try:
            await db.close()
        except Exception:
            pass


@pytest.mark.asyncio
async def test_rate_limit_zero_disables():
    """Setting limit to 0 must allow unlimited messages."""
    orig = _patch_rate_limit(0)
    try:
        db = await _get_db()
        thread = await crud_mod.thread_create(db, "rl-test-disabled")
        for i in range(10):
            msg = await _post_message(db, thread.id, "rl-disabled-user", f"Msg {i}")
            assert msg.seq > 0
    finally:
        _restore_rate_limit(*orig)
        try:
            await db.close()
        except Exception:
            pass
