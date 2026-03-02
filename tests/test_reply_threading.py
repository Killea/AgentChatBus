"""
Tests for UP-14: Reply-To Message Threading.

- Unit tests (in-memory SQLite, no server needed)
- Integration tests (real server on TEST_PORT)
"""
import asyncio
import json
import os
import uuid

import aiosqlite
import httpx
import pytest

from src.db import crud
from src.db.database import init_schema

# ---------------------------------------------------------------------------
# Helpers shared between unit and integration tests
# ---------------------------------------------------------------------------

TEST_PORT = int(os.environ.get("AGENTCHATBUS_PORT", "39769"))
BASE_URL = os.environ.get("AGENTCHATBUS_TEST_BASE_URL", f"http://127.0.0.1:{TEST_PORT}")


async def _make_db() -> aiosqlite.Connection:
    """Create an in-memory DB with the full schema initialized."""
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)
    return db


async def _create_thread(db, topic: str = "test-thread") -> str:
    t = await crud.thread_create(db, topic=topic)
    return t.id


async def _post_msg(
    db,
    thread_id: str,
    content: str = "hello",
    author: str = "agent-a",
    reply_to_msg_id: str | None = None,
) -> "crud.Message":
    sync = await crud.issue_reply_token(db, thread_id=thread_id, agent_id=None)
    return await crud.msg_post(
        db,
        thread_id=thread_id,
        author=author,
        content=content,
        expected_last_seq=sync["current_seq"],
        reply_token=sync["reply_token"],
        reply_to_msg_id=reply_to_msg_id,
    )


# ---------------------------------------------------------------------------
# Unit tests (in-memory DB)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_msg_post_no_reply():
    """Message without reply_to → reply_to_msg_id is None."""
    db = await _make_db()
    tid = await _create_thread(db)
    msg = await _post_msg(db, tid, content="first message")
    assert msg.reply_to_msg_id is None
    await db.close()


@pytest.mark.asyncio
async def test_msg_post_with_reply():
    """Reply to a valid parent message → reply_to_msg_id stored."""
    db = await _make_db()
    tid = await _create_thread(db)
    parent = await _post_msg(db, tid, content="parent")
    reply = await _post_msg(db, tid, content="child", reply_to_msg_id=parent.id)
    assert reply.reply_to_msg_id == parent.id
    await db.close()


@pytest.mark.asyncio
async def test_msg_post_reply_nonexistent():
    """Reply to a non-existent message ID → ValueError."""
    db = await _make_db()
    tid = await _create_thread(db)
    fake_id = str(uuid.uuid4())
    with pytest.raises(ValueError, match="does not exist"):
        await _post_msg(db, tid, content="orphan", reply_to_msg_id=fake_id)
    await db.close()


@pytest.mark.asyncio
async def test_msg_post_reply_wrong_thread():
    """Reply to a message from a different thread → ValueError."""
    db = await _make_db()
    tid1 = await _create_thread(db, "thread-1")
    tid2 = await _create_thread(db, "thread-2")
    msg_in_t1 = await _post_msg(db, tid1, content="in thread 1")

    with pytest.raises(ValueError, match="different thread"):
        await _post_msg(db, tid2, content="wrong thread reply", reply_to_msg_id=msg_in_t1.id)
    await db.close()


@pytest.mark.asyncio
async def test_msg_list_includes_reply_to():
    """msg_list() returns messages with reply_to_msg_id populated."""
    db = await _make_db()
    tid = await _create_thread(db)
    parent = await _post_msg(db, tid, content="parent")
    child = await _post_msg(db, tid, content="child", reply_to_msg_id=parent.id)

    msgs = await crud.msg_list(db, tid, after_seq=0, include_system_prompt=False)
    assert len(msgs) == 2
    parent_in_list = next(m for m in msgs if m.id == parent.id)
    child_in_list = next(m for m in msgs if m.id == child.id)
    assert parent_in_list.reply_to_msg_id is None
    assert child_in_list.reply_to_msg_id == parent.id
    await db.close()


@pytest.mark.asyncio
async def test_msg_get_existing():
    """msg_get() returns the correct message."""
    db = await _make_db()
    tid = await _create_thread(db)
    msg = await _post_msg(db, tid, content="fetchable")
    fetched = await crud.msg_get(db, msg.id)
    assert fetched is not None
    assert fetched.id == msg.id
    assert fetched.content == "fetchable"
    await db.close()


@pytest.mark.asyncio
async def test_msg_get_nonexistent():
    """msg_get() returns None for an unknown ID."""
    db = await _make_db()
    await _create_thread(db)
    result = await crud.msg_get(db, str(uuid.uuid4()))
    assert result is None
    await db.close()


@pytest.mark.asyncio
async def test_sse_event_msg_reply_emitted():
    """msg.reply SSE event is emitted when reply_to_msg_id is provided."""
    db = await _make_db()
    tid = await _create_thread(db)
    parent = await _post_msg(db, tid, content="parent")
    await _post_msg(db, tid, content="child", reply_to_msg_id=parent.id)

    async with db.execute(
        "SELECT event_type, payload FROM events WHERE event_type = 'msg.reply' ORDER BY id DESC LIMIT 1"
    ) as cur:
        row = await cur.fetchone()
    assert row is not None
    payload = json.loads(row["payload"])
    assert payload["reply_to_msg_id"] == parent.id
    await db.close()


@pytest.mark.asyncio
async def test_sse_event_msg_reply_not_emitted():
    """No msg.reply event when reply_to_msg_id is None."""
    db = await _make_db()
    tid = await _create_thread(db)
    await _post_msg(db, tid, content="standalone")

    async with db.execute(
        "SELECT COUNT(*) AS cnt FROM events WHERE event_type = 'msg.reply'"
    ) as cur:
        row = await cur.fetchone()
    assert row["cnt"] == 0
    await db.close()


@pytest.mark.asyncio
async def test_msg_post_reply_chain():
    """Chain of 3 messages A→B→C stores correct parent IDs."""
    db = await _make_db()
    tid = await _create_thread(db)
    msg_a = await _post_msg(db, tid, content="A")
    msg_b = await _post_msg(db, tid, content="B", reply_to_msg_id=msg_a.id)
    msg_c = await _post_msg(db, tid, content="C", reply_to_msg_id=msg_b.id)

    assert msg_a.reply_to_msg_id is None
    assert msg_b.reply_to_msg_id == msg_a.id
    assert msg_c.reply_to_msg_id == msg_b.id
    await db.close()


@pytest.mark.asyncio
async def test_old_db_compat():
    """_row_to_message() falls back to None when reply_to_msg_id column is absent."""
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    # Minimal schema without reply_to_msg_id column
    await db.execute("""
        CREATE TABLE messages (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL,
            author TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user',
            content TEXT NOT NULL,
            seq INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            metadata TEXT,
            author_id TEXT,
            author_name TEXT
        )
    """)
    await db.execute(
        "INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?)",
        ("m1", "t1", "agent", "user", "hello", 1, "2026-01-01T00:00:00", None, None, "agent"),
    )
    await db.commit()
    async with db.execute("SELECT * FROM messages WHERE id = 'm1'") as cur:
        row = await cur.fetchone()
    msg = crud._row_to_message(row)
    assert msg.reply_to_msg_id is None
    await db.close()


@pytest.mark.asyncio
async def test_dispatch_msg_post_with_reply():
    """handle_msg_post() dispatch includes reply_to_msg_id in the result."""
    from src.tools.dispatch import handle_msg_post

    db = await _make_db()
    tid = await _create_thread(db)
    parent = await _post_msg(db, tid, content="parent")

    # Get a fresh sync context for the child message
    sync = await crud.issue_reply_token(db, thread_id=tid, agent_id=None)
    result_blocks = await handle_msg_post(db, {
        "thread_id": tid,
        "author": "agent-b",
        "content": "child via dispatch",
        "expected_last_seq": sync["current_seq"],
        "reply_token": sync["reply_token"],
        "reply_to_msg_id": parent.id,
    })
    assert len(result_blocks) == 1
    result = json.loads(result_blocks[0].text)
    assert "msg_id" in result
    assert result.get("reply_to_msg_id") == parent.id
    await db.close()


# ---------------------------------------------------------------------------
# Integration tests (real server)
# ---------------------------------------------------------------------------


def _api_create_thread(client: httpx.Client, topic: str = "test-reply-thread") -> dict:
    resp = client.post("/api/threads", json={"topic": topic, "status": "discuss"})
    assert resp.status_code in (200, 201), f"create thread failed: {resp.text}"
    return resp.json()


def _api_post_message(
    client: httpx.Client,
    thread_id: str,
    content: str = "hello",
    author: str = "int-agent",
    reply_to_msg_id: str | None = None,
) -> httpx.Response:
    body = {"author": author, "content": content, "role": "user"}
    if reply_to_msg_id is not None:
        body["reply_to_msg_id"] = reply_to_msg_id
    return client.post(f"/api/threads/{thread_id}/messages", json=body)


@pytest.mark.integration
def test_api_post_reply_valid(server):
    """POST /messages with reply_to_msg_id → 201 + field present in response."""
    with httpx.Client(base_url=BASE_URL, timeout=10) as client:
        t = _api_create_thread(client, "int-reply-valid")
        parent_resp = _api_post_message(client, t["id"], content="parent msg")
        assert parent_resp.status_code in (200, 201)
        parent_id = parent_resp.json()["id"]

        child_resp = _api_post_message(client, t["id"], content="child msg", reply_to_msg_id=parent_id)
        assert child_resp.status_code in (200, 201)
        body = child_resp.json()
        assert body.get("reply_to_msg_id") == parent_id


@pytest.mark.integration
def test_api_post_reply_invalid_id(server):
    """POST /messages with non-existent reply_to_msg_id → 400."""
    with httpx.Client(base_url=BASE_URL, timeout=10) as client:
        t = _api_create_thread(client, "int-reply-invalid")
        resp = _api_post_message(client, t["id"], content="orphan", reply_to_msg_id=str(uuid.uuid4()))
        assert resp.status_code == 400


@pytest.mark.integration
def test_api_post_reply_wrong_thread(server):
    """POST /messages with reply_to_msg_id from a different thread → 400."""
    with httpx.Client(base_url=BASE_URL, timeout=10) as client:
        t1 = _api_create_thread(client, "int-reply-t1")
        t2 = _api_create_thread(client, "int-reply-t2")
        msg_in_t1 = _api_post_message(client, t1["id"], content="in t1")
        assert msg_in_t1.status_code in (200, 201)
        msg_id_t1 = msg_in_t1.json()["id"]

        resp = _api_post_message(client, t2["id"], content="wrong thread", reply_to_msg_id=msg_id_t1)
        assert resp.status_code == 400


@pytest.mark.integration
def test_api_get_messages_includes_reply(server):
    """GET /messages returns reply_to_msg_id field on all messages."""
    with httpx.Client(base_url=BASE_URL, timeout=10) as client:
        t = _api_create_thread(client, "int-get-reply-field")
        parent_resp = _api_post_message(client, t["id"], content="parent")
        assert parent_resp.status_code in (200, 201)
        parent_id = parent_resp.json()["id"]
        child_resp = _api_post_message(client, t["id"], content="child", reply_to_msg_id=parent_id)
        assert child_resp.status_code in (200, 201)

        msgs_resp = client.get(f"/api/threads/{t['id']}/messages")
        assert msgs_resp.status_code == 200
        msgs = msgs_resp.json()
        assert all("reply_to_msg_id" in m for m in msgs), "reply_to_msg_id missing from some messages"
        child_msg = next((m for m in msgs if m.get("reply_to_msg_id") == parent_id), None)
        assert child_msg is not None


@pytest.mark.integration
def test_api_post_reply_no_field(server):
    """POST /messages without reply_to_msg_id → 201, field is null in response."""
    with httpx.Client(base_url=BASE_URL, timeout=10) as client:
        t = _api_create_thread(client, "int-no-reply-field")
        resp = _api_post_message(client, t["id"], content="standalone")
        assert resp.status_code in (200, 201)
        assert resp.json().get("reply_to_msg_id") is None


@pytest.mark.integration
def test_api_reply_sse_event(server):
    """SSE stream receives msg.reply event when a reply message is posted."""
    import threading

    with httpx.Client(base_url=BASE_URL, timeout=10) as client:
        t = _api_create_thread(client, "int-sse-reply")
        parent_resp = _api_post_message(client, t["id"], content="parent for SSE")
        assert parent_resp.status_code in (200, 201)
        parent_id = parent_resp.json()["id"]

    received_events: list[dict] = []
    received_event_ids: list[int] = []

    def post_reply():
        """Post the reply message in a background thread after a short delay."""
        import time
        time.sleep(0.5)
        with httpx.Client(base_url=BASE_URL, timeout=10) as poster:
            poster.post(
                f"/api/threads/{t['id']}/messages",
                json={"author": "sse-agent", "content": "sse reply", "role": "user", "reply_to_msg_id": parent_id},
            )

    # Start background thread to post the reply after stream is open
    bg = threading.Thread(target=post_reply, daemon=True)
    bg.start()

    # Read SSE stream from the global /events endpoint.
    # Track last event ID so we only process new events from our test.
    # Wait up to 8 seconds for our specific msg.reply event.
    import time
    start = time.time()
    with httpx.Client(base_url=BASE_URL, timeout=10) as client:
        with client.stream("GET", "/events") as stream:
            last_sse_id: int | None = None
            for line in stream.iter_lines():
                line = line.strip()
                # Track SSE event IDs to know when we're past previous events
                if line.startswith("id:"):
                    try:
                        last_sse_id = int(line[3:].strip())
                    except ValueError:
                        pass
                elif line.startswith("data:"):
                    try:
                        event_data = json.loads(line[5:].strip())
                        # Only record events after the parent was posted
                        if last_sse_id is not None:
                            received_event_ids.append(last_sse_id)
                            received_events.append(event_data)
                    except json.JSONDecodeError:
                        pass
                # Stop if we found our specific msg.reply event
                if any(
                    e.get("type") == "msg.reply" and e.get("payload", {}).get("reply_to_msg_id") == parent_id
                    for e in received_events
                ):
                    break
                if time.time() - start > 8:
                    break

    bg.join(timeout=5)
    reply_events = [
        e for e in received_events
        if e.get("type") == "msg.reply" and e.get("payload", {}).get("reply_to_msg_id") == parent_id
    ]
    assert len(reply_events) >= 1, (
        f"No msg.reply event with reply_to_msg_id={parent_id!r} found.\n"
        f"Received {len(received_events)} events: {received_events}"
    )
