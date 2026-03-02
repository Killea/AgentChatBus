"""
Tests for UP-22: Bus metrics endpoint.

Covers:
- get_bus_metrics() CRUD function (unit, in-memory DB)
  - empty DB baseline
  - thread counts by status
  - message total
  - message rate windows (1m / 5m / 15m) with controlled timestamps
  - inter-message latency (avg_latency_ms) — present / null cases
  - stop_reason distribution (UP-17 metadata field)
  - agent counts: total and online/offline
- HTTP integration: GET /api/metrics (require running server)
  - 200 response
  - schema key presence
  - uptime_seconds > 0
  - threads.total reflects thread creation
  - messages.total reflects message posting
  - stop_reasons dict has canonical keys
- Backward compatibility: GET /health unchanged
"""
import json
import os
import uuid
from datetime import datetime, timezone, timedelta

import aiosqlite
import httpx
import pytest

from src.db import crud
from src.db.database import init_schema

BASE_URL = os.getenv("AGENTCHATBUS_TEST_BASE_URL", "http://127.0.0.1:39766")

# ─────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────

def _build_client() -> httpx.Client:
    return httpx.Client(base_url=BASE_URL, timeout=10)


def _require_server_or_skip(client: httpx.Client) -> None:
    try:
        resp = client.get("/health")
        if resp.status_code < 500:
            return
    except Exception:
        pass
    pytest.skip(f"AgentChatBus server is not reachable at {BASE_URL}")


async def _setup_db() -> aiosqlite.Connection:
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)
    return db


async def _insert_message_with_timestamp(
    db: aiosqlite.Connection,
    thread_id: str,
    created_at: str,
    seq: int,
    metadata: dict | None = None,
) -> None:
    """Directly insert a message with a controlled timestamp for rate/latency tests."""
    msg_id = str(uuid.uuid4())
    meta_json = json.dumps(metadata) if metadata else None
    await db.execute(
        """
        INSERT INTO messages (id, thread_id, author, role, content, seq, created_at, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (msg_id, thread_id, "test-agent", "user", "test content", seq, created_at, meta_json),
    )
    await db.commit()


# ─────────────────────────────────────────────
# Unit tests — in-memory DB
# ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_metrics_empty_db():
    """Fresh DB returns all-zero counts and null avg_latency_ms."""
    db = await _setup_db()
    try:
        m = await crud.get_bus_metrics(db)
        assert m["threads"]["total"] == 0
        assert m["threads"]["by_status"] == {}
        assert m["messages"]["total"] == 0
        assert m["messages"]["rate"]["last_1m"] == 0
        assert m["messages"]["rate"]["last_5m"] == 0
        assert m["messages"]["rate"]["last_15m"] == 0
        assert m["messages"]["avg_latency_ms"] is None
        assert m["agents"]["total"] == 0
        assert m["agents"]["online"] == 0
        # stop_reasons should have all canonical keys at 0
        for reason in ("convergence", "timeout", "complete", "error", "impasse"):
            assert m["messages"]["stop_reasons"][reason] == 0
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_metrics_thread_counts_by_status():
    """Thread counts reflect actual status distribution."""
    db = await _setup_db()
    try:
        await crud.thread_create(db, "Thread discuss 1")
        await crud.thread_create(db, "Thread discuss 2")
        t_close = await crud.thread_create(db, "Thread to close")
        await crud.thread_close(db, t_close.id, summary="done")

        m = await crud.get_bus_metrics(db)
        assert m["threads"]["total"] == 3
        assert m["threads"]["by_status"]["discuss"] == 2
        assert m["threads"]["by_status"]["closed"] == 1
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_metrics_message_total():
    """messages.total reflects all posted messages."""
    db = await _setup_db()
    try:
        thread = await crud.thread_create(db, "Msg Total Thread")
        now = datetime.now(timezone.utc)
        await _insert_message_with_timestamp(db, thread.id, now.isoformat(), seq=10)
        await _insert_message_with_timestamp(db, thread.id, now.isoformat(), seq=11)

        m = await crud.get_bus_metrics(db)
        assert m["messages"]["total"] >= 2
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_metrics_message_rate_windows():
    """Rate windows correctly count messages by recency."""
    db = await _setup_db()
    try:
        thread = await crud.thread_create(db, "Rate Window Thread")
        now = datetime.now(timezone.utc)

        # 30 seconds ago → in all windows
        await _insert_message_with_timestamp(
            db, thread.id, (now - timedelta(seconds=30)).isoformat(), seq=100
        )
        # 3 minutes ago → in 5m and 15m, NOT 1m
        await _insert_message_with_timestamp(
            db, thread.id, (now - timedelta(minutes=3)).isoformat(), seq=101
        )
        # 10 minutes ago → in 15m only
        await _insert_message_with_timestamp(
            db, thread.id, (now - timedelta(minutes=10)).isoformat(), seq=102
        )
        # 20 minutes ago → in none of the windows
        await _insert_message_with_timestamp(
            db, thread.id, (now - timedelta(minutes=20)).isoformat(), seq=103
        )

        m = await crud.get_bus_metrics(db)
        assert m["messages"]["rate"]["last_1m"] >= 1   # the 30s message
        assert m["messages"]["rate"]["last_5m"] >= 2   # 30s + 3m
        assert m["messages"]["rate"]["last_15m"] >= 3  # 30s + 3m + 10m
        # The 20m message must NOT appear in last_15m
        assert m["messages"]["rate"]["last_15m"] < m["messages"]["total"]
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_metrics_avg_latency_with_messages():
    """avg_latency_ms is a positive number when a thread has multiple recent messages."""
    db = await _setup_db()
    try:
        thread = await crud.thread_create(db, "Latency Thread")
        now = datetime.now(timezone.utc)

        # Three messages 5 seconds apart, all within the last 15 minutes
        for i in range(3):
            await _insert_message_with_timestamp(
                db,
                thread.id,
                (now - timedelta(seconds=(10 - i * 5))).isoformat(),
                seq=200 + i,
            )

        m = await crud.get_bus_metrics(db)
        assert m["messages"]["avg_latency_ms"] is not None
        assert m["messages"]["avg_latency_ms"] > 0
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_metrics_avg_latency_single_message():
    """avg_latency_ms is null when no thread has more than one message in the window."""
    db = await _setup_db()
    try:
        thread = await crud.thread_create(db, "Single Msg Thread")
        now = datetime.now(timezone.utc)
        await _insert_message_with_timestamp(
            db, thread.id, (now - timedelta(seconds=30)).isoformat(), seq=300
        )

        m = await crud.get_bus_metrics(db)
        assert m["messages"]["avg_latency_ms"] is None
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_metrics_stop_reason_distribution():
    """stop_reasons counts messages by their UP-17 stop_reason metadata value."""
    db = await _setup_db()
    try:
        thread = await crud.thread_create(db, "Stop Reason Thread")
        now = datetime.now(timezone.utc)

        await _insert_message_with_timestamp(
            db, thread.id, now.isoformat(), seq=400,
            metadata={"stop_reason": "convergence"},
        )
        await _insert_message_with_timestamp(
            db, thread.id, now.isoformat(), seq=401,
            metadata={"stop_reason": "convergence"},
        )
        await _insert_message_with_timestamp(
            db, thread.id, now.isoformat(), seq=402,
            metadata={"stop_reason": "timeout"},
        )
        # Message with no stop_reason — should not affect counts
        await _insert_message_with_timestamp(
            db, thread.id, now.isoformat(), seq=403,
        )

        m = await crud.get_bus_metrics(db)
        assert m["messages"]["stop_reasons"]["convergence"] == 2
        assert m["messages"]["stop_reasons"]["timeout"] == 1
        assert m["messages"]["stop_reasons"]["complete"] == 0
        assert m["messages"]["stop_reasons"]["error"] == 0
        assert m["messages"]["stop_reasons"]["impasse"] == 0
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_metrics_stop_reason_empty():
    """stop_reasons returns all-zero dict when no messages carry a stop_reason."""
    db = await _setup_db()
    try:
        thread = await crud.thread_create(db, "No Stop Reason Thread")
        now = datetime.now(timezone.utc)
        # Plain message with no metadata — must not affect stop_reason counts
        await _insert_message_with_timestamp(db, thread.id, now.isoformat(), seq=500)

        m = await crud.get_bus_metrics(db)
        for reason in ("convergence", "timeout", "complete", "error", "impasse"):
            assert m["messages"]["stop_reasons"][reason] == 0
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_metrics_agent_counts_total():
    """agents.total reflects registered agents count."""
    db = await _setup_db()
    try:
        m_before = await crud.get_bus_metrics(db)
        initial = m_before["agents"]["total"]

        await crud.agent_register(db, ide="IDE-A", model="model-x")
        await crud.agent_register(db, ide="IDE-B", model="model-y")

        m = await crud.get_bus_metrics(db)
        assert m["agents"]["total"] == initial + 2
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_metrics_agent_online_offline():
    """agents.online counts only agents with a recent heartbeat."""
    db = await _setup_db()
    try:
        # Register a fresh agent (heartbeat = now → online)
        fresh = await crud.agent_register(db, ide="IDE-Fresh", model="model-fresh")

        # Register a stale agent by manipulating last_heartbeat directly
        stale = await crud.agent_register(db, ide="IDE-Stale", model="model-stale")
        stale_ts = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        await db.execute(
            "UPDATE agents SET last_heartbeat = ? WHERE id = ?",
            (stale_ts, stale.id),
        )
        await db.commit()

        m = await crud.get_bus_metrics(db)
        # Fresh agent must count as online; stale must not
        assert m["agents"]["online"] >= 1
        assert m["agents"]["online"] < m["agents"]["total"]
        assert fresh.id is not None  # ensure fresh agent was created
    finally:
        await db.close()


# ─────────────────────────────────────────────
# Integration tests — require running server
# ─────────────────────────────────────────────

def test_api_metrics_returns_200():
    """GET /api/metrics responds with HTTP 200."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = client.get("/api/metrics")
        assert r.status_code == 200, r.text


def test_api_metrics_schema_keys():
    """Response contains all expected top-level and nested keys."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = client.get("/api/metrics")
        assert r.status_code == 200, r.text
        data = r.json()

        assert "status" in data
        assert data["status"] == "ok"
        assert "uptime_seconds" in data
        assert "started_at" in data
        assert "schema_version" in data

        assert "threads" in data
        assert "total" in data["threads"]
        assert "by_status" in data["threads"]

        assert "messages" in data
        assert "total" in data["messages"]
        assert "rate" in data["messages"]
        assert "last_1m" in data["messages"]["rate"]
        assert "last_5m" in data["messages"]["rate"]
        assert "last_15m" in data["messages"]["rate"]
        assert "avg_latency_ms" in data["messages"]
        assert "stop_reasons" in data["messages"]

        assert "agents" in data
        assert "total" in data["agents"]
        assert "online" in data["agents"]


def test_api_metrics_uptime_positive():
    """uptime_seconds is a positive number (server has been running)."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = client.get("/api/metrics")
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["uptime_seconds"] > 0


def test_api_metrics_threads_reflect_creation():
    """Creating a thread via API increases threads.total in metrics."""
    with _build_client() as client:
        _require_server_or_skip(client)

        before = client.get("/api/metrics").json()
        total_before = before["threads"]["total"]

        topic = f"Metrics Integration Thread {uuid.uuid4().hex[:8]}"
        r = client.post("/api/threads", json={"topic": topic})
        assert r.status_code == 201, r.text

        after = client.get("/api/metrics").json()
        assert after["threads"]["total"] == total_before + 1


def test_api_metrics_messages_reflect_post():
    """Posting a message via API increases messages.total in metrics."""
    with _build_client() as client:
        _require_server_or_skip(client)

        # Create thread
        topic = f"Metrics Msg Thread {uuid.uuid4().hex[:8]}"
        thread_r = client.post("/api/threads", json={"topic": topic})
        assert thread_r.status_code == 201, thread_r.text
        thread_id = thread_r.json()["id"]

        before = client.get("/api/metrics").json()
        total_before = before["messages"]["total"]

        msg_r = client.post(
            f"/api/threads/{thread_id}/messages",
            json={"author": "integration-test", "content": "Hello metrics"},
        )
        assert msg_r.status_code in (200, 201), msg_r.text

        after = client.get("/api/metrics").json()
        assert after["messages"]["total"] == total_before + 1


def test_api_metrics_stop_reasons_present():
    """messages.stop_reasons contains all five canonical reason keys."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = client.get("/api/metrics")
        assert r.status_code == 200, r.text
        stop_reasons = r.json()["messages"]["stop_reasons"]

        for reason in ("convergence", "timeout", "complete", "error", "impasse"):
            assert reason in stop_reasons, f"Missing stop_reason key: {reason}"
            assert isinstance(stop_reasons[reason], int)


def test_api_health_unchanged():
    """GET /health still returns the original minimal response (backward compat)."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = client.get("/health")
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["status"] == "ok"
        assert data["service"] == "AgentChatBus"
        # Must NOT contain metrics keys
        assert "uptime_seconds" not in data
        assert "threads" not in data
