"""
CRUD operations for AgentChatBus.
All functions are async and receive the aiosqlite connection from the caller.
"""
import json
import uuid
import secrets
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

import aiosqlite

from src.db.models import Thread, Message, AgentInfo, Event
from src.config import AGENT_HEARTBEAT_TIMEOUT

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_dt(s: str) -> datetime:
    return datetime.fromisoformat(s)


# ─────────────────────────────────────────────
# Sequence counter (global, bus-wide)
# ─────────────────────────────────────────────

async def next_seq(db: aiosqlite.Connection) -> int:
    """Atomically increment and return the next global sequence number."""
    async with db.execute(
        "UPDATE seq_counter SET val = val + 1 WHERE id = 1 RETURNING val"
    ) as cur:
        row = await cur.fetchone()
    await db.commit()
    return row["val"]


# ─────────────────────────────────────────────
# Thread CRUD
# ─────────────────────────────────────────────

async def thread_create(db: aiosqlite.Connection, topic: str, metadata: Optional[dict] = None) -> Thread:
    tid = str(uuid.uuid4())
    now = _now()
    meta_json = json.dumps(metadata) if metadata else None
    await db.execute(
        "INSERT INTO threads (id, topic, status, created_at, metadata) VALUES (?, ?, 'discuss', ?, ?)",
        (tid, topic, now, meta_json),
    )
    await db.commit()
    await _emit_event(db, "thread.new", tid, {"thread_id": tid, "topic": topic})
    logger.info(f"Thread created: {tid} '{topic}'")
    return Thread(id=tid, topic=topic, status="discuss", created_at=_parse_dt(now),
                  closed_at=None, summary=None, metadata=meta_json)


async def thread_get(db: aiosqlite.Connection, thread_id: str) -> Optional[Thread]:
    async with db.execute("SELECT * FROM threads WHERE id = ?", (thread_id,)) as cur:
        row = await cur.fetchone()
    if row is None:
        return None
    return _row_to_thread(row)


async def thread_list(db: aiosqlite.Connection, status: Optional[str] = None) -> list[Thread]:
    if status:
        async with db.execute("SELECT * FROM threads WHERE status = ? ORDER BY created_at DESC", (status,)) as cur:
            rows = await cur.fetchall()
    else:
        async with db.execute("SELECT * FROM threads ORDER BY created_at DESC") as cur:
            rows = await cur.fetchall()
    return [_row_to_thread(r) for r in rows]


async def thread_set_state(db: aiosqlite.Connection, thread_id: str, state: str) -> bool:
    valid = {"discuss", "implement", "review", "done", "closed"}
    if state not in valid:
        raise ValueError(f"Invalid state '{state}'. Must be one of {valid}")
    await db.execute("UPDATE threads SET status = ? WHERE id = ?", (state, thread_id))
    await db.commit()
    await _emit_event(db, "thread.state", thread_id, {"thread_id": thread_id, "state": state})
    return True


async def thread_close(db: aiosqlite.Connection, thread_id: str, summary: Optional[str] = None) -> bool:
    now = _now()
    await db.execute(
        "UPDATE threads SET status = 'closed', closed_at = ?, summary = ? WHERE id = ?",
        (now, summary, thread_id),
    )
    await db.commit()
    await _emit_event(db, "thread.closed", thread_id, {"thread_id": thread_id, "summary": summary})
    return True


def _row_to_thread(row: aiosqlite.Row) -> Thread:
    return Thread(
        id=row["id"],
        topic=row["topic"],
        status=row["status"],
        created_at=_parse_dt(row["created_at"]),
        closed_at=_parse_dt(row["closed_at"]) if row["closed_at"] else None,
        summary=row["summary"],
        metadata=row["metadata"],
    )


# ─────────────────────────────────────────────
# Message CRUD
# ─────────────────────────────────────────────

async def msg_post(
    db: aiosqlite.Connection,
    thread_id: str,
    author: str,
    content: str,
    role: str = "user",
    metadata: Optional[dict] = None,
) -> Message:
    # Resolve author: if it's an agent_id (UUID), convert it to the agent's display name
    actual_author = author
    async with db.execute("SELECT name FROM agents WHERE id = ?", (author,)) as cur:
        row = await cur.fetchone()
        if row:
            actual_author = row["name"]

    mid = str(uuid.uuid4())
    now = _now()
    seq = await next_seq(db)
    meta_json = json.dumps(metadata) if metadata else None
    await db.execute(
        "INSERT INTO messages (id, thread_id, author, role, content, seq, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (mid, thread_id, actual_author, role, content, seq, now, meta_json),
    )
    await db.commit()
    await _emit_event(db, "msg.new", thread_id, {
        "msg_id": mid, "thread_id": thread_id, "author": actual_author,
        "role": role, "seq": seq, "content": content[:200],  # truncate for event payload
    })
    logger.debug(f"Message posted: seq={seq} author={actual_author} thread={thread_id}")
    return Message(id=mid, thread_id=thread_id, author=actual_author, role=role,
                   content=content, seq=seq, created_at=_parse_dt(now), metadata=meta_json)


async def msg_list(
    db: aiosqlite.Connection,
    thread_id: str,
    after_seq: int = 0,
    limit: int = 100,
) -> list[Message]:
    async with db.execute(
        "SELECT * FROM messages WHERE thread_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
        (thread_id, after_seq, limit),
    ) as cur:
        rows = await cur.fetchall()
    return [_row_to_message(r) for r in rows]


def _row_to_message(row: aiosqlite.Row) -> Message:
    return Message(
        id=row["id"],
        thread_id=row["thread_id"],
        author=row["author"],
        role=row["role"],
        content=row["content"],
        seq=row["seq"],
        created_at=_parse_dt(row["created_at"]),
        metadata=row["metadata"],
    )


# ─────────────────────────────────────────────
# Agent registry
# ─────────────────────────────────────────────

async def agent_register(
    db: aiosqlite.Connection,
    ide: str,
    model: str,
    description: str = "",
    capabilities: Optional[list] = None,
) -> AgentInfo:
    """
    Register a new agent on the bus.

    The display `name` is auto-generated as ``ide (model)`` — e.g. "Cursor (GPT-4)".
    If another agent with that exact base name is already registered, a numeric
    suffix is appended: "Cursor (GPT-4) 2", "Cursor (GPT-4) 3", …
    This lets identical IDE+model pairs co-exist without confusion.
    """
    ide   = ide.strip()   or "Unknown IDE"
    model = model.strip() or "Unknown Model"
    base_name = f"{ide} ({model})"

    # Find next available suffix
    async with db.execute(
        "SELECT name FROM agents WHERE name = ? OR name LIKE ?",
        (base_name, f"{base_name} %"),
    ) as cur:
        existing = {r["name"] for r in await cur.fetchall()}

    if base_name not in existing:
        name = base_name
    else:
        n = 2
        while f"{base_name} {n}" in existing:
            n += 1
        name = f"{base_name} {n}"

    aid = str(uuid.uuid4())
    token = secrets.token_hex(32)
    now = _now()
    caps_json = json.dumps(capabilities) if capabilities else None
    await db.execute(
        "INSERT INTO agents (id, name, ide, model, description, capabilities, registered_at, last_heartbeat, token) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (aid, name, ide, model, description, caps_json, now, now, token),
    )
    await db.commit()
    await _emit_event(db, "agent.online", None, {"agent_id": aid, "name": name, "ide": ide, "model": model})
    logger.info(f"Agent registered: {aid} '{name}'")
    return AgentInfo(id=aid, name=name, ide=ide, model=model, description=description,
                     capabilities=caps_json, registered_at=_parse_dt(now),
                     last_heartbeat=_parse_dt(now), is_online=True, token=token)


async def agent_heartbeat(db: aiosqlite.Connection, agent_id: str, token: str) -> bool:
    async with db.execute("SELECT token FROM agents WHERE id = ?", (agent_id,)) as cur:
        row = await cur.fetchone()
    if row is None or row["token"] != token:
        return False
    now = _now()
    await db.execute("UPDATE agents SET last_heartbeat = ? WHERE id = ?", (now, agent_id))
    await db.commit()
    return True


async def agent_unregister(db: aiosqlite.Connection, agent_id: str, token: str) -> bool:
    async with db.execute("SELECT token FROM agents WHERE id = ?", (agent_id,)) as cur:
        row = await cur.fetchone()
    if row is None or row["token"] != token:
        return False
    await db.execute("DELETE FROM agents WHERE id = ?", (agent_id,))
    await db.commit()
    await _emit_event(db, "agent.offline", None, {"agent_id": agent_id})
    return True


async def agent_list(db: aiosqlite.Connection) -> list[AgentInfo]:
    async with db.execute("SELECT * FROM agents ORDER BY registered_at") as cur:
        rows = await cur.fetchall()
    return [_row_to_agent(r) for r in rows]


def _row_to_agent(row: aiosqlite.Row) -> AgentInfo:
    last_hb = _parse_dt(row["last_heartbeat"])
    elapsed = (datetime.now(timezone.utc) - last_hb).total_seconds()
    return AgentInfo(
        id=row["id"],
        name=row["name"],
        ide=row["ide"] if "ide" in row.keys() else "",
        model=row["model"] if "model" in row.keys() else "",
        description=row["description"] or "",
        capabilities=row["capabilities"],
        registered_at=_parse_dt(row["registered_at"]),
        last_heartbeat=last_hb,
        is_online=elapsed < AGENT_HEARTBEAT_TIMEOUT,
        token=row["token"],
    )


# ─────────────────────────────────────────────
# Event fan-out (for SSE)
# ─────────────────────────────────────────────

async def _emit_event(db: aiosqlite.Connection, event_type: str, thread_id: Optional[str], payload: dict) -> None:
    await db.execute(
        "INSERT INTO events (event_type, thread_id, payload, created_at) VALUES (?, ?, ?, ?)",
        (event_type, thread_id, json.dumps(payload), _now()),
    )
    await db.commit()


async def events_since(db: aiosqlite.Connection, after_id: int = 0, limit: int = 50) -> list[Event]:
    """Fetch events newer than `after_id` for the SSE pump to deliver."""
    async with db.execute(
        "SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?",
        (after_id, limit),
    ) as cur:
        rows = await cur.fetchall()
    return [Event(
        id=row["id"],
        event_type=row["event_type"],
        thread_id=row["thread_id"],
        payload=row["payload"],
        created_at=_parse_dt(row["created_at"]),
    ) for row in rows]


async def events_delete_old(db: aiosqlite.Connection, max_age_seconds: int = 600) -> None:
    """Prune delivered events older than max_age_seconds to keep the table small."""
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=max_age_seconds)).isoformat()
    async with db.execute("DELETE FROM events WHERE created_at < ?", (cutoff,)) as cur:
        deleted = cur.rowcount
    await db.commit()
    if deleted > 0:
        logger.debug(f"Pruned {deleted} old events.")
