"""
CRUD operations for AgentChatBus.
All functions are async and receive the aiosqlite connection from the caller.
"""
import json
import uuid
import secrets
import logging
import sqlite3
from datetime import datetime, timezone, timedelta
from typing import Optional

import aiosqlite

from src.db.models import Thread, Message, AgentInfo, Event
from src.config import AGENT_HEARTBEAT_TIMEOUT

logger = logging.getLogger(__name__)

GLOBAL_SYSTEM_PROMPT = """**SYSTEM DIRECTIVE: ACTIVE AGENT COLLABORATION WORKSPACE**

Welcome to this Thread. You are participating in a multi-agent workspace sharing the same underlying codebase and execution environment. You MUST collaborate proactively and keep progress moving.

1. Shared Context: All agents are using the same repository, file system, memory state, and runtime environment.
2. Active Execution: Do not stay passive. Propose concrete next steps, claim work, and execute non-destructive changes promptly.
3. Safe Coordination: Before destructive commands or broad refactors, briefly announce intent and wait for feedback. For normal scoped edits, coordinate quickly and continue.
4. Conflict Avoidance: Announce target files/modules before editing. Avoid simultaneous edits to the same file.
5. Discussion Cadence: Keep the thread active with meaningful updates. If waiting too long, send a short structured update (`status`, `blocker`, `next action`) and optionally `@` a relevant online agent.
6. msg_wait Behavior: Use `msg_wait` for listening, but do not remain silent forever. If repeated timeouts occur, post a useful progress message instead of idle chatter.
7. Message Quality: Avoid noise like "still waiting". Every message should include new information, a decision, or a concrete action request.

Operate like a delivery-focused engineering team: communicate clearly, move work forward, and resolve blockers quickly."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_dt(s: str) -> datetime:
    return datetime.fromisoformat(s)


# ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
# Sequence counter (global, bus-wide)
# ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

async def next_seq(db: aiosqlite.Connection) -> int:
    """Atomically increment and return the next global sequence number.

    NOTE: This function commits internally. In the current single-process,
    single-connection SQLite setup this is safe. If the system is ever
    expanded to multi-connection or multi-process mode, callers (e.g.
    msg_post) should manage transaction boundaries themselves to prevent
    seq leaks (allocated seq with no corresponding message insertion).
    TODO: Consider removing internal commit and delegating transaction
    management to callers if connection model changes.
    """
    async with db.execute(
        "UPDATE seq_counter SET val = val + 1 WHERE id = 1 RETURNING val"
    ) as cur:
        row = await cur.fetchone()
    await db.commit()
    return row["val"]


# ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
# Thread CRUD
# ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

async def thread_create(db: aiosqlite.Connection, topic: str, metadata: Optional[dict] = None, system_prompt: Optional[str] = None) -> Thread:
    # Atomic idempotency: use transaction to prevent race condition on concurrent creates with same topic
    # Strategy: try INSERT first, if UNIQUE constraint fails then SELECT the existing one
    tid = str(uuid.uuid4())
    now = _now()
    meta_json = json.dumps(metadata) if metadata else None
    
    try:
        await db.execute(
            "INSERT INTO threads (id, topic, status, created_at, metadata, system_prompt) VALUES (?, ?, 'discuss', ?, ?, ?)",
            (tid, topic, now, meta_json, system_prompt),
        )
        await db.commit()
        await _emit_event(db, "thread.new", tid, {"thread_id": tid, "topic": topic})
        logger.info(f"Thread created: {tid} '{topic}'")
        return Thread(id=tid, topic=topic, status="discuss", created_at=_parse_dt(now),
                      closed_at=None, summary=None, metadata=meta_json, system_prompt=system_prompt)
    except sqlite3.IntegrityError as e:
        # UNIQUE constraint violation on threads.topic ΓÇö another thread was created concurrently
        # Fetch and return the existing thread for idempotency
        logger.info(f"Thread '{topic}' creation raced (UNIQUE constraint), fetching existing: {e}")
        async with db.execute("SELECT * FROM threads WHERE topic = ? ORDER BY created_at DESC LIMIT 1", (topic,)) as cur:
            row = await cur.fetchone()
            if row:
                logger.info(f"Thread '{topic}' already exists (from race), returning existing thread: {row['id']}")
                return _row_to_thread(row)
        # Fallback if SELECT fails (shouldn't happen, but defensive)
        logger.error(f"UNIQUE constraint failed but couldn't fetch existing thread for topic '{topic}'")
        raise
    except Exception as e:
        # Other unexpected errors should be re-raised
        logger.error(f"Unexpected error creating thread '{topic}': {type(e).__name__}: {e}")
        raise


async def thread_get(db: aiosqlite.Connection, thread_id: str) -> Optional[Thread]:
    async with db.execute("SELECT * FROM threads WHERE id = ?", (thread_id,)) as cur:
        row = await cur.fetchone()
    if row is None:
        return None
    return _row_to_thread(row)


async def thread_list(
    db: aiosqlite.Connection,
    status: Optional[str] = None,
    include_archived: bool = False,
) -> list[Thread]:
    if status:
        async with db.execute(
            "SELECT * FROM threads WHERE status = ? ORDER BY created_at DESC",
            (status,),
        ) as cur:
            rows = await cur.fetchall()
        return [_row_to_thread(r) for r in rows]

    if include_archived:
        async with db.execute("SELECT * FROM threads ORDER BY created_at DESC") as cur:
            rows = await cur.fetchall()
        return [_row_to_thread(r) for r in rows]

    async with db.execute(
        "SELECT * FROM threads WHERE status != 'archived' ORDER BY created_at DESC"
    ) as cur:
        rows = await cur.fetchall()
    return [_row_to_thread(r) for r in rows]


async def thread_set_state(db: aiosqlite.Connection, thread_id: str, state: str) -> bool:
    valid = {"discuss", "implement", "review", "done", "closed", "archived"}
    if state not in valid:
        raise ValueError(f"Invalid state '{state}'. Must be one of {valid}")
    async with db.execute("UPDATE threads SET status = ? WHERE id = ?", (state, thread_id)) as cur:
        updated = cur.rowcount
    await db.commit()
    if updated == 0:
        return False  # thread_id does not exist
    await _emit_event(db, "thread.state", thread_id, {"thread_id": thread_id, "state": state})
    return True


async def thread_archive(db: aiosqlite.Connection, thread_id: str) -> bool:
    ok = await thread_set_state(db, thread_id, "archived")
    if not ok:
        return False
    await _emit_event(db, "thread.archived", thread_id, {"thread_id": thread_id})
    return True


async def thread_unarchive(db: aiosqlite.Connection, thread_id: str) -> bool:
    ok = await thread_set_state(db, thread_id, "discuss")
    if not ok:
        return False
    await _emit_event(db, "thread.unarchived", thread_id, {"thread_id": thread_id})
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


async def thread_delete(db: aiosqlite.Connection, thread_id: str) -> dict | None:
    """Permanently delete a thread and all its messages.

    Returns a dict with audit info (thread_id, topic, message_count) on success,
    or None if the thread does not exist.
    Messages are deleted before the thread to satisfy the FK constraint.
    Both deletes are wrapped in a single transaction with rollback on error.
    """
    async with db.execute("SELECT * FROM threads WHERE id = ?", (thread_id,)) as cur:
        row = await cur.fetchone()
    if row is None:
        return None

    topic = row["topic"]
    async with db.execute(
        "SELECT COUNT(*) AS cnt FROM messages WHERE thread_id = ?", (thread_id,)
    ) as cur:
        msg_count = (await cur.fetchone())["cnt"]

    try:
        await db.execute("DELETE FROM messages WHERE thread_id = ?", (thread_id,))
        await db.execute("DELETE FROM threads WHERE id = ?", (thread_id,))
        await db.commit()
    except Exception:
        await db.rollback()
        raise

    await _emit_event(db, "thread.deleted", thread_id, {
        "thread_id": thread_id, "topic": topic, "message_count": msg_count,
    })
    logger.info(f"Thread deleted: {thread_id} '{topic}' ({msg_count} messages)")
    return {"thread_id": thread_id, "topic": topic, "message_count": msg_count}


async def thread_latest_seq(db: aiosqlite.Connection, thread_id: str) -> int:
    """Return the highest seq number in the thread, or 0 if no messages exist yet."""
    async with db.execute(
        "SELECT MAX(seq) AS max_seq FROM messages WHERE thread_id = ?", (thread_id,)
    ) as cur:
        row = await cur.fetchone()
    return row["max_seq"] or 0


def _row_to_thread(row: aiosqlite.Row) -> Thread:
    system_prompt = row["system_prompt"] if "system_prompt" in row.keys() else None
    return Thread(
        id=row["id"],
        topic=row["topic"],
        status=row["status"],
        created_at=_parse_dt(row["created_at"]),
        closed_at=_parse_dt(row["closed_at"]) if row["closed_at"] else None,
        summary=row["summary"],
        metadata=row["metadata"],
        system_prompt=system_prompt,
    )


# ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
# Message CRUD
# ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

async def msg_post(
    db: aiosqlite.Connection,
    thread_id: str,
    author: str,
    content: str,
    role: str = "user",
    metadata: Optional[dict] = None,
) -> Message:
    actual_author = author
    author_id = None
    author_name = author

    async with db.execute("SELECT id, name FROM agents WHERE id = ?", (author,)) as cur:
        row = await cur.fetchone()
        if row:
            actual_author = row["name"]
            author_id = row["id"]
            author_name = row["name"]

    mid = str(uuid.uuid4())
    now = _now()
    seq = await next_seq(db)
    meta_json = json.dumps(metadata) if metadata else None
    await db.execute(
        "INSERT INTO messages (id, thread_id, author, role, content, seq, created_at, metadata, author_id, author_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (mid, thread_id, actual_author, role, content, seq, now, meta_json, author_id, author_name),
    )
    await db.commit()
    if author_id:
        await agent_msg_post(db, author_id)
    await _emit_event(db, "msg.new", thread_id, {
        "msg_id": mid, "thread_id": thread_id, "author": author_name,
        "author_id": author_id, "role": role, "seq": seq, "content": content[:200],  # truncate for event payload
    })
    logger.debug(f"Message posted: seq={seq} author={author_name} thread={thread_id}")
    return Message(
        id=mid, thread_id=thread_id, author=actual_author, role=role,
        content=content, seq=seq, created_at=_parse_dt(now), metadata=meta_json,
        author_id=author_id, author_name=author_name
    )


async def msg_list(
    db: aiosqlite.Connection,
    thread_id: str,
    after_seq: int = 0,
    limit: int = 100,
    include_system_prompt: bool = True,
) -> list[Message]:
    async with db.execute(
        "SELECT * FROM messages WHERE thread_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
        (thread_id, after_seq, limit),
    ) as cur:
        rows = await cur.fetchall()
        
    msgs = [_row_to_message(r) for r in rows]
    
    if include_system_prompt and after_seq == 0:
        # Check if the thread has a custom system_prompt, else use global fallback.
        # If a custom prompt exists, append it after the built-in guidance.
        async with db.execute("SELECT system_prompt, created_at FROM threads WHERE id = ?", (thread_id,)) as cur:
            t_row = await cur.fetchone()
            
        thread_prompt = t_row["system_prompt"] if (t_row and t_row["system_prompt"]) else None
        if thread_prompt:
            prompt_text = (
                "## Section: System (Built-in)\n\n"
                f"{GLOBAL_SYSTEM_PROMPT}\n\n"
                "## Section: Thread Create (Provided By Creator)\n\n"
                f"{thread_prompt}"
            )
        else:
            prompt_text = GLOBAL_SYSTEM_PROMPT
        created_at_dt = _parse_dt(t_row["created_at"]) if t_row else _parse_dt(_now())
        
        sys_msg = Message(
            id=f"sys-{thread_id}",
            thread_id=thread_id,
            author="system",
            role="system",
            content=prompt_text,
            seq=0,
            created_at=created_at_dt,
            metadata=None,
            author_id="system",
            author_name="System",
        )
        msgs.insert(0, sys_msg)
        
    return msgs


def _row_to_message(row: aiosqlite.Row) -> Message:
    # safe dict-like fallback for new columns on older DB schemas
    author_id = row["author_id"] if "author_id" in row.keys() else None
    author_name = row["author_name"] if "author_name" in row.keys() else None
    if not author_name:
        author_name = row["author"]
        
    return Message(
        id=row["id"],
        thread_id=row["thread_id"],
        author=row["author"],
        role=row["role"],
        content=row["content"],
        seq=row["seq"],
        created_at=_parse_dt(row["created_at"]),
        metadata=row["metadata"],
        author_id=author_id,
        author_name=author_name,
    )


# ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
# ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
# ─────────────────────────────────────────────
# Agent registry
# ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

async def agent_register(
    db: aiosqlite.Connection,
    ide: str,
    model: str,
    description: str = "",
    capabilities: Optional[list] = None,
    display_name: Optional[str] = None,
) -> AgentInfo:
    """
    Register a new agent on the bus.

    The display `name` is auto-generated as ``ide (model)`` ΓÇö e.g. "Cursor (GPT-4)".
    If another agent with that exact base name is already registered, a numeric
    suffix is appended: "Cursor (GPT-4) 2", "Cursor (GPT-4) 3", ΓÇª
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
    clean_display_name = (display_name or "").strip() or name
    alias_source = "user" if (display_name or "").strip() else "auto"
    await db.execute(
        "INSERT INTO agents (id, name, ide, model, description, capabilities, registered_at, last_heartbeat, token, display_name, alias_source, last_activity, last_activity_time) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (aid, name, ide, model, description, caps_json, now, now, token, clean_display_name, alias_source, "registered", now),
    )
    await db.commit()
    await _emit_event(db, "agent.online", None, {"agent_id": aid, "name": name, "ide": ide, "model": model})
    logger.info(f"Agent registered: {aid} '{name}'")
    return AgentInfo(id=aid, name=name, ide=ide, model=model, description=description,
                     capabilities=caps_json, registered_at=_parse_dt(now),
                     last_heartbeat=_parse_dt(now), is_online=True, token=token,
                     display_name=clean_display_name, alias_source=alias_source,
                     last_activity="registered", last_activity_time=_parse_dt(now))


async def _set_agent_activity(
    db: aiosqlite.Connection,
    agent_id: str,
    activity: str,
    *,
    touch_heartbeat: bool = False,
) -> bool:
    now = _now()
    if touch_heartbeat:
        async with db.execute(
            "UPDATE agents SET last_activity = ?, last_activity_time = ?, last_heartbeat = ? WHERE id = ?",
            (activity, now, now, agent_id),
        ) as cur:
            updated = cur.rowcount
    else:
        async with db.execute(
            "UPDATE agents SET last_activity = ?, last_activity_time = ? WHERE id = ?",
            (activity, now, agent_id),
        ) as cur:
            updated = cur.rowcount
    await db.commit()
    return updated > 0


async def agent_resume(db: aiosqlite.Connection, agent_id: str, token: str) -> AgentInfo:
    async with db.execute("SELECT token FROM agents WHERE id = ?", (agent_id,)) as cur:
        row = await cur.fetchone()
    if row is None or row["token"] != token:
        raise ValueError("Invalid agent_id/token")

    await _set_agent_activity(db, agent_id, "resume", touch_heartbeat=True)

    async with db.execute("SELECT * FROM agents WHERE id = ?", (agent_id,)) as cur:
        refreshed = await cur.fetchone()
    if refreshed is None:
        raise ValueError("Agent not found after resume")

    await _emit_event(db, "agent.online", None, {
        "agent_id": refreshed["id"],
        "name": refreshed["name"],
        "ide": refreshed["ide"] if "ide" in refreshed.keys() else "",
        "model": refreshed["model"] if "model" in refreshed.keys() else "",
    })
    return _row_to_agent(refreshed)


async def agent_heartbeat(db: aiosqlite.Connection, agent_id: str, token: str) -> bool:
    async with db.execute("SELECT token FROM agents WHERE id = ?", (agent_id,)) as cur:
        row = await cur.fetchone()
    if row is None or row["token"] != token:
        return False
    return await _set_agent_activity(db, agent_id, "heartbeat", touch_heartbeat=True)


async def agent_msg_wait(db: aiosqlite.Connection, agent_id: str, token: str) -> bool:
    async with db.execute("SELECT token FROM agents WHERE id = ?", (agent_id,)) as cur:
        row = await cur.fetchone()
    if row is None or row["token"] != token:
        return False
    return await _set_agent_activity(db, agent_id, "msg_wait", touch_heartbeat=False)


async def agent_msg_post(db: aiosqlite.Connection, agent_id: str) -> bool:
    return await _set_agent_activity(db, agent_id, "msg_post", touch_heartbeat=False)


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
    display_name = row["display_name"] if "display_name" in row.keys() else None
    alias_source = row["alias_source"] if "alias_source" in row.keys() else None
    if not display_name:
        display_name = row["name"]
        if not alias_source:
            alias_source = "auto"

    last_activity = row["last_activity"] if "last_activity" in row.keys() else None
    last_activity_raw = row["last_activity_time"] if "last_activity_time" in row.keys() else None
    last_activity_time = _parse_dt(last_activity_raw) if last_activity_raw else None

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
        display_name=display_name,
        alias_source=alias_source,
        last_activity=last_activity,
        last_activity_time=last_activity_time,
    )


# ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
# Event fan-out (for SSE)
# ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

async def _emit_event(db: aiosqlite.Connection, event_type: str, thread_id: Optional[str], payload: dict) -> None:
    await db.execute(
        "INSERT INTO events (event_type, thread_id, payload, created_at) VALUES (?, ?, ?, ?)",
        (event_type, thread_id, json.dumps(payload), _now()),
    )
    await db.commit()
async def thread_timeout_sweep(db: aiosqlite.Connection, timeout_minutes: int) -> list[str]:
    """
    Close open threads whose last message is older than timeout_minutes.
    Returns the list of thread IDs that were closed.

    A thread is considered inactive if:
    - Its status is 'discuss' (not already closed/archived)
    - Its most recent message (or its creation time if no messages) is older than timeout_minutes

    Emits a 'thread.timeout' event for each closed thread.
    """
    if timeout_minutes <= 0:
        return []

    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=timeout_minutes)).isoformat()
    now = _now()

    # Find threads that are open and whose last activity is before the cutoff.
    # We use a LEFT JOIN so threads with no messages are also considered
    # (they time out from creation time).
    async with db.execute("""
        SELECT t.id, t.topic,
               COALESCE(MAX(m.created_at), t.created_at) AS last_activity
        FROM threads t
        LEFT JOIN messages m ON m.thread_id = t.id
        WHERE t.status = 'discuss'
        GROUP BY t.id
        HAVING last_activity < ?
    """, (cutoff,)) as cur:
        rows = await cur.fetchall()

    closed_ids: list[str] = []
    for row in rows:
        thread_id = row["id"]
        topic = row["topic"]
        last_activity = row["last_activity"]
        await db.execute(
            "UPDATE threads SET status = 'closed', closed_at = ? WHERE id = ?",
            (now, thread_id),
        )
        await _emit_event(db, "thread.timeout", thread_id, {
            "thread_id": thread_id,
            "topic": topic,
            "last_activity": last_activity,
            "timeout_minutes": timeout_minutes,
            "closed_at": now,
        })
        closed_ids.append(thread_id)
        logger.info(f"Thread {thread_id[:8]}... ('{topic}') auto-closed after {timeout_minutes}min inactivity.")

    if closed_ids:
        await db.commit()
        logger.info(f"Timeout sweep closed {len(closed_ids)} thread(s).")

    return closed_ids

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
