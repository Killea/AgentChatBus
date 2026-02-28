"""
Unit tests for UP-03: Rate Limiting.
Tests the rate limit logic and CRUD integration without requiring a running server.

Design note: DB_PATH is fixed at import time in database.py, so we use unique
author names per test to avoid cross-test state pollution.
"""
import os
import pytest
import src.db.crud as crud_mod
import src.db.database as dbmod

# Use an isolated test DB for all rate-limit unit tests
os.environ["AGENTCHATBUS_DB"] = "data/test_rl_unit.db"

from src.db.crud import RateLimitExceeded


# ─────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────

async def _get_db():
    """Return (or init) the shared DB connection."""
    if dbmod._db is None:
        await dbmod.get_db()
    return dbmod._db


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
        exc = RateLimitExceeded(limit=30, window=60, retry_after=60, scope="author_id")
        assert exc.limit == 30
        assert exc.window == 60
        assert exc.retry_after == 60
        assert exc.scope == "author_id"

    def test_str_contains_limit_and_window(self):
        exc = RateLimitExceeded(limit=5, window=60, retry_after=60, scope="author")
        assert "5" in str(exc)
        assert "60" in str(exc)

    def test_scope_author_id(self):
        exc = RateLimitExceeded(limit=10, window=60, retry_after=30, scope="author_id")
        assert exc.scope == "author_id"

    def test_scope_author_fallback(self):
        exc = RateLimitExceeded(limit=10, window=60, retry_after=30, scope="author")
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
            msg = await crud_mod.msg_post(db, thread.id, "rl-allow-user", f"Message {i}")
            assert msg.seq > 0
    finally:
        _restore_rate_limit(*orig)


@pytest.mark.asyncio
async def test_rate_limit_blocks_on_exceed():
    """The N+1 message must raise RateLimitExceeded."""
    orig = _patch_rate_limit(3)
    try:
        db = await _get_db()
        thread = await crud_mod.thread_create(db, "rl-test-exceed")
        for i in range(3):
            await crud_mod.msg_post(db, thread.id, "rl-exceed-user", f"Msg {i}")
        with pytest.raises(RateLimitExceeded) as exc_info:
            await crud_mod.msg_post(db, thread.id, "rl-exceed-user", "One too many")
        assert exc_info.value.limit == 3
        assert exc_info.value.window == 60
        assert exc_info.value.retry_after > 0
    finally:
        _restore_rate_limit(*orig)


@pytest.mark.asyncio
async def test_rate_limit_scopes_per_author():
    """Different authors must have independent rate limit counters."""
    orig = _patch_rate_limit(3)
    try:
        db = await _get_db()
        thread = await crud_mod.thread_create(db, "rl-test-scope")
        for i in range(3):
            await crud_mod.msg_post(db, thread.id, "rl-scope-A", f"Msg {i}")
        with pytest.raises(RateLimitExceeded):
            await crud_mod.msg_post(db, thread.id, "rl-scope-A", "Blocked!")
        # Author B must have their own independent counter
        msg = await crud_mod.msg_post(db, thread.id, "rl-scope-B", "Author B works")
        assert msg.seq > 0
    finally:
        _restore_rate_limit(*orig)


@pytest.mark.asyncio
async def test_rate_limit_normal_single_message():
    """A single message from a fresh author must always pass."""
    orig = _patch_rate_limit(3)
    try:
        db = await _get_db()
        thread = await crud_mod.thread_create(db, "rl-test-single")
        msg = await crud_mod.msg_post(db, thread.id, "rl-single-user", "Normal message")
        assert msg.seq > 0
    finally:
        _restore_rate_limit(*orig)


@pytest.mark.asyncio
async def test_rate_limit_zero_disables():
    """Setting limit to 0 must allow unlimited messages."""
    orig = _patch_rate_limit(0)
    try:
        db = await _get_db()
        thread = await crud_mod.thread_create(db, "rl-test-disabled")
        for i in range(10):
            msg = await crud_mod.msg_post(db, thread.id, "rl-disabled-user", f"Msg {i}")
            assert msg.seq > 0
    finally:
        _restore_rate_limit(*orig)
