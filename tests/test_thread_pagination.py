"""
Tests for UP-20: Stable cursor pagination for thread_list.

Covers:
- Unit tests (in-memory DB): limit, before cursor, combined, ordering, hard cap, sequential pages
- Integration tests (server on port 39769): REST API pagination, envelope response, 400 on invalid cursor
"""
import asyncio
import os
import uuid
from datetime import datetime, timedelta, timezone

import aiosqlite
import httpx
import pytest

from src.db import crud
from src.db.database import init_schema

BASE_URL = os.getenv("AGENTCHATBUS_TEST_BASE_URL", "http://127.0.0.1:39769")


# ─────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────

def _build_client() -> httpx.Client:
    return httpx.Client(base_url=BASE_URL, timeout=10)


def _require_server_or_skip(client: httpx.Client) -> None:
    try:
        resp = client.get("/api/threads?limit=1")
        if resp.status_code < 500 and isinstance(resp.json(), dict) and "threads" in resp.json():
            return
    except Exception:
        pass
    pytest.skip(f"AgentChatBus server with UP-20 pagination not reachable at {BASE_URL}")


async def _setup_db() -> aiosqlite.Connection:
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)
    return db


async def _insert_thread(
    db: aiosqlite.Connection,
    topic: str,
    created_at: str,
    status: str = "discuss",
) -> str:
    """Insert a thread with a controlled created_at timestamp for pagination tests."""
    tid = str(uuid.uuid4())
    await db.execute(
        "INSERT INTO threads (id, topic, status, created_at) VALUES (?, ?, ?, ?)",
        (tid, topic, status, created_at),
    )
    await db.commit()
    return tid


def _ts(offset_seconds: int = 0) -> str:
    """Return an ISO datetime offset from a fixed base time for predictable ordering."""
    base = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    return (base + timedelta(seconds=offset_seconds)).isoformat()


# ─────────────────────────────────────────────
# Unit tests (in-memory DB)
# ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_default_returns_all():
    """No limit/before returns all threads (backward compat)."""
    db = await _setup_db()
    try:
        for i in range(5):
            await _insert_thread(db, f"Thread {i}", _ts(i))
        threads = await crud.thread_list(db)
        assert len(threads) == 5
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_limit_zero_returns_all():
    """`limit=0` explicitly returns all threads."""
    db = await _setup_db()
    try:
        for i in range(5):
            await _insert_thread(db, f"Thread {i}", _ts(i))
        threads = await crud.thread_list(db, limit=0)
        assert len(threads) == 5
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_limit_returns_correct_count():
    """`limit=3` with 10 threads returns exactly 3."""
    db = await _setup_db()
    try:
        for i in range(10):
            await _insert_thread(db, f"Thread {i}", _ts(i))
        threads = await crud.thread_list(db, limit=3)
        assert len(threads) == 3
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_limit_larger_than_total():
    """`limit=100` with 5 threads returns all 5."""
    db = await _setup_db()
    try:
        for i in range(5):
            await _insert_thread(db, f"Thread {i}", _ts(i))
        threads = await crud.thread_list(db, limit=100)
        assert len(threads) == 5
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_order_desc_by_created_at():
    """Results are ordered newest-first (DESC created_at)."""
    db = await _setup_db()
    try:
        for i in range(5):
            await _insert_thread(db, f"Thread {i}", _ts(i * 10))
        threads = await crud.thread_list(db)
        dates = [t.created_at for t in threads]
        assert dates == sorted(dates, reverse=True), "Threads must be ordered DESC by created_at"
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_before_cursor():
    """`before` cursor returns only threads older than the given timestamp."""
    db = await _setup_db()
    try:
        # Create threads at t=0, t=10, t=20, t=30, t=40 seconds
        ids = []
        for i in range(5):
            tid = await _insert_thread(db, f"Thread {i}", _ts(i * 10))
            ids.append(tid)

        # Use the timestamp of the 3rd thread (i=2, t=20) as cursor
        cursor = _ts(2 * 10)
        threads = await crud.thread_list(db, before=cursor)

        # Should return threads with created_at < cursor (i=0 and i=1)
        returned_topics = {t.topic for t in threads}
        assert returned_topics == {"Thread 0", "Thread 1"}
        for t in threads:
            assert t.created_at.isoformat() < cursor
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_before_and_limit_combined():
    """`before` + `limit` together returns correct subset."""
    db = await _setup_db()
    try:
        for i in range(10):
            await _insert_thread(db, f"Thread {i}", _ts(i * 10))

        # cursor at t=70 (index 7), so threads at t=0..60 (7 items) qualify
        # limit=3 returns the 3 newest among those: t=60, t=50, t=40
        cursor = _ts(7 * 10)
        threads = await crud.thread_list(db, before=cursor, limit=3)

        assert len(threads) == 3
        for t in threads:
            assert t.created_at.isoformat() < cursor
        # Results should be newest-first within the filtered set
        dates = [t.created_at for t in threads]
        assert dates == sorted(dates, reverse=True)
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_with_status_filter():
    """`status` filter combined with `limit` returns only matching threads."""
    db = await _setup_db()
    try:
        for i in range(4):
            await _insert_thread(db, f"Discuss {i}", _ts(i), status="discuss")
        for i in range(3):
            await _insert_thread(db, f"Done {i}", _ts(i + 10), status="done")

        threads = await crud.thread_list(db, status="discuss", limit=2)
        assert len(threads) == 2
        for t in threads:
            assert t.status == "discuss"
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_with_include_archived():
    """`include_archived=True` with `limit` includes archived threads."""
    db = await _setup_db()
    try:
        for i in range(3):
            await _insert_thread(db, f"Active {i}", _ts(i), status="discuss")
        for i in range(2):
            await _insert_thread(db, f"Archived {i}", _ts(i + 10), status="archived")

        threads_with = await crud.thread_list(db, include_archived=True, limit=10)
        threads_without = await crud.thread_list(db, include_archived=False, limit=10)

        assert len(threads_with) == 5
        assert len(threads_without) == 3
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_hard_cap_200():
    """`limit=999` is capped at 200 server-side."""
    db = await _setup_db()
    try:
        for i in range(10):
            await _insert_thread(db, f"Thread {i}", _ts(i))
        threads = await crud.thread_list(db, limit=999)
        # 10 threads exist — all returned, but the effective limit applied was 200
        assert len(threads) == 10  # less than cap, all returned
        # Verify cap logic: with 250 threads only 200 should come back
        for i in range(10, 250):
            await _insert_thread(db, f"Thread {i}", _ts(i))
        threads = await crud.thread_list(db, limit=999)
        assert len(threads) == 200
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_sequential_pages_no_overlap():
    """Walking through pages of limit=3 covers all threads without duplicates."""
    db = await _setup_db()
    try:
        total = 9
        for i in range(total):
            await _insert_thread(db, f"Thread {i}", _ts(i * 10))

        seen_ids: set[str] = set()
        cursor: str | None = None
        pages = 0

        while True:
            threads = await crud.thread_list(db, limit=3, before=cursor)
            if not threads:
                break
            for t in threads:
                assert t.id not in seen_ids, f"Duplicate thread {t.id} on page {pages + 1}"
                seen_ids.add(t.id)
            pages += 1
            # Compute next cursor: created_at of the last (oldest) item on this page
            cursor = threads[-1].created_at.isoformat()

        assert len(seen_ids) == total
        assert pages == 3  # 9 threads / 3 per page = 3 pages
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_before_no_results():
    """`before` older than all threads returns an empty list."""
    db = await _setup_db()
    try:
        for i in range(5):
            await _insert_thread(db, f"Thread {i}", _ts(i))
        very_old = datetime(2000, 1, 1, tzinfo=timezone.utc).isoformat()
        threads = await crud.thread_list(db, before=very_old)
        assert threads == []
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_thread_count_basic():
    """`thread_count()` returns total ignoring pagination."""
    db = await _setup_db()
    try:
        for i in range(7):
            await _insert_thread(db, f"Thread {i}", _ts(i), status="discuss")
        await _insert_thread(db, "Archived", _ts(100), status="archived")

        assert await crud.thread_count(db) == 7  # default excludes archived
        assert await crud.thread_count(db, include_archived=True) == 8
        assert await crud.thread_count(db, status="discuss") == 7
        assert await crud.thread_count(db, status="archived") == 1
    finally:
        await db.close()


# ─────────────────────────────────────────────
# Integration tests (server required — port 39769)
# ─────────────────────────────────────────────

@pytest.mark.integration
def test_api_threads_default_backward_compat():
    """GET /api/threads without params returns envelope with all threads."""
    with _build_client() as client:
        _require_server_or_skip(client)
        resp = client.get("/api/threads")
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, dict)
        assert "threads" in data
        assert "total" in data
        assert "has_more" in data
        assert "next_cursor" in data
        assert isinstance(data["threads"], list)
        assert data["has_more"] is False
        assert data["next_cursor"] is None


@pytest.mark.integration
def test_api_threads_with_limit():
    """GET /api/threads?limit=2 returns at most 2 threads."""
    with _build_client() as client:
        _require_server_or_skip(client)
        # Ensure enough threads exist
        for i in range(3):
            client.post("/api/threads", json={"topic": f"Pagination test limit {uuid.uuid4()}"})

        resp = client.get("/api/threads?limit=2")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["threads"]) <= 2


@pytest.mark.integration
def test_api_threads_with_before():
    """GET /api/threads?before=<ISO> returns only threads older than cursor."""
    with _build_client() as client:
        _require_server_or_skip(client)

        # Create a thread and use its created_at as the cursor
        resp_create = client.post("/api/threads", json={"topic": f"Ref thread {uuid.uuid4()}"})
        assert resp_create.status_code == 201
        ref_created_at = resp_create.json()["created_at"]

        # Create a newer thread after the reference
        client.post("/api/threads", json={"topic": f"Newer thread {uuid.uuid4()}"})

        resp = client.get(f"/api/threads?before={ref_created_at}")
        assert resp.status_code == 200
        data = resp.json()
        for t in data["threads"]:
            assert t["created_at"] < ref_created_at


@pytest.mark.integration
def test_api_threads_pagination_walk():
    """Create 5 threads, paginate 2-by-2 starting from newest, cover all without overlap."""
    with _build_client() as client:
        _require_server_or_skip(client)

        # Create 5 threads and track their IDs directly
        created_ids: set[str] = set()
        for _ in range(5):
            r = client.post("/api/threads", json={"topic": f"Walk thread {uuid.uuid4()}"})
            assert r.status_code == 201
            created_ids.add(r.json()["id"])

        # Walk all pages with limit=2, tracking every seen ID
        seen_ids: set[str] = set()
        cursor: str | None = None

        for _ in range(50):  # safety cap — prevents infinite loop
            url = "/api/threads?limit=2"
            if cursor:
                url += f"&before={cursor}"
            resp = client.get(url)
            assert resp.status_code == 200
            page_data = resp.json()
            page_threads = page_data["threads"]
            if not page_threads:
                break
            for t in page_threads:
                assert t["id"] not in seen_ids, f"Duplicate thread {t['id']}"
                seen_ids.add(t["id"])
            if not page_data["has_more"]:
                break
            cursor = page_data["next_cursor"]

        # All 5 newly created threads must appear somewhere in the full walk
        assert created_ids.issubset(seen_ids), (
            f"Missing threads: {created_ids - seen_ids}"
        )


@pytest.mark.integration
def test_api_threads_limit_cap():
    """GET /api/threads?limit=999 is capped at 200 server-side."""
    with _build_client() as client:
        _require_server_or_skip(client)
        resp = client.get("/api/threads?limit=999")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["threads"]) <= 200


@pytest.mark.integration
def test_api_threads_status_with_limit():
    """GET /api/threads?status=discuss&limit=2 filters and limits."""
    with _build_client() as client:
        _require_server_or_skip(client)
        for _ in range(3):
            client.post("/api/threads", json={"topic": f"Status limit test {uuid.uuid4()}"})

        resp = client.get("/api/threads?status=discuss&limit=2")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["threads"]) <= 2
        for t in data["threads"]:
            assert t["status"] == "discuss"


@pytest.mark.integration
def test_api_threads_invalid_before_400():
    """GET /api/threads?before=not-a-date returns HTTP 400."""
    with _build_client() as client:
        _require_server_or_skip(client)
        resp = client.get("/api/threads?before=not-a-valid-date")
        assert resp.status_code == 400
        data = resp.json()
        assert "detail" in data
        assert "before" in data["detail"].lower() or "cursor" in data["detail"].lower()
