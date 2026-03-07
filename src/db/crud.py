"""
CRUD operations for AgentChatBus.
All functions are async and receive the aiosqlite connection from the caller.
"""
import json
import uuid
import secrets
import logging
import sqlite3
import random
from datetime import datetime, timezone, timedelta
from typing import Optional

import aiosqlite

from src.db.models import Thread, Message, AgentInfo, Event, ThreadTemplate, ThreadSettings, Reaction, MessageEdit
from src.config import (
    AGENT_HEARTBEAT_TIMEOUT,
    RATE_LIMIT_MSG_PER_MINUTE,
    RATE_LIMIT_ENABLED,
    CONTENT_FILTER_ENABLED,
    REPLY_TOKEN_LEASE_SECONDS,
    SEQ_TOLERANCE,
    SEQ_MISMATCH_MAX_MESSAGES,
)
from src.content_filter import check_content, ContentFilterError

logger = logging.getLogger(__name__)


def _quote_ident(name: str) -> str:
    """Quote SQL identifiers from trusted schema metadata.

    Allows only ASCII letters/digits/underscore and non-digit first char.
    """
    if not name:
        raise ValueError("Empty identifier")
    if not (name[0].isalpha() or name[0] == "_"):
        raise ValueError(f"Invalid identifier start: {name}")
    if not all(ch.isalnum() or ch == "_" for ch in name):
        raise ValueError(f"Invalid identifier: {name}")
    return f'"{name}"'


async def _delete_fk_dependents_for_thread(
    db: aiosqlite.Connection,
    thread_id: str,
    *,
    referenced_table: str,
) -> None:
    """Delete rows in tables that FK-reference `referenced_table`.

    This keeps thread_delete resilient when new FK-linked tables are added.
    """
    async with db.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ) as cur:
        table_rows = await cur.fetchall()

    targets: list[tuple[str, str]] = []
    for tr in table_rows:
        table_name = tr["name"]
        if table_name == referenced_table:
            continue
        try:
            pragma_sql = f"PRAGMA foreign_key_list({_quote_ident(table_name)})"
            async with db.execute(pragma_sql) as cur:
                fk_rows = await cur.fetchall()
        except Exception:
            continue

        for fk in fk_rows:
            if fk["table"] == referenced_table:
                targets.append((table_name, fk["from"]))

    # De-duplicate while preserving stable order.
    seen: set[tuple[str, str]] = set()
    deduped: list[tuple[str, str]] = []
    for item in targets:
        if item in seen:
            continue
        seen.add(item)
        deduped.append(item)

    for table_name, fk_col in deduped:
        qt = _quote_ident(table_name)
        qc = _quote_ident(fk_col)
        if referenced_table == "messages":
            await db.execute(
                f"DELETE FROM {qt} WHERE {qc} IN (SELECT id FROM messages WHERE thread_id = ?)",
                (thread_id,),
            )
        elif referenced_table == "threads":
            await db.execute(
                f"DELETE FROM {qt} WHERE {qc} = ?",
                (thread_id,),
            )


def _row_get(row: sqlite3.Row, key: str, default=None):
    """Safely get a column from a sqlite3.Row, returning default if column doesn't exist.
    
    This is needed for migration compatibility when new columns are added.
    """
    try:
        return row[key] if row[key] is not None else default
    except (KeyError, IndexError):
        return default


class RateLimitExceeded(Exception):
    """Raised when an author exceeds the configured message rate limit."""

    def __init__(self, limit: int, window: int, retry_after: int, scope: str) -> None:
        self.limit = limit
        self.window = window
        self.retry_after = retry_after
        self.scope = scope
        super().__init__(f"Rate limit exceeded: {limit} messages/{window}s")


class MissingSyncFieldsError(Exception):
    """Raised when strict sync fields are absent from msg_post."""

    def __init__(self, missing_fields: list[str]) -> None:
        self.missing_fields = missing_fields
        super().__init__(f"Missing required sync fields: {', '.join(missing_fields)}")


class SeqMismatchError(Exception):
    """Raised when too many unseen messages exist since expected seq."""

    def __init__(self, expected_last_seq: int, current_seq: int, new_messages: list[dict]) -> None:
        self.expected_last_seq = expected_last_seq
        self.current_seq = current_seq
        self.new_messages = new_messages
        super().__init__(
            f"SEQ_MISMATCH: expected_last_seq={expected_last_seq}, current_seq={current_seq}"
        )


class ReplyTokenInvalidError(Exception):
    def __init__(self, token: str) -> None:
        self.token = token
        super().__init__("TOKEN_INVALID")


class ReplyTokenExpiredError(Exception):
    def __init__(self, token: str, expires_at: str) -> None:
        self.token = token
        self.expires_at = expires_at
        super().__init__("TOKEN_EXPIRED")


class ReplyTokenReplayError(Exception):
    def __init__(self, token: str, consumed_at: Optional[str]) -> None:
        self.token = token
        self.consumed_at = consumed_at
        super().__init__("TOKEN_REPLAY")


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

async def thread_create(
    db: aiosqlite.Connection,
    topic: str,
    metadata: Optional[dict] = None,
    system_prompt: Optional[str] = None,
    template: Optional[str] = None,
    creator_admin_id: Optional[str] = None,
    creator_admin_name: Optional[str] = None,
) -> Thread:
    # Resolve template defaults (UP-18): apply before caller overrides
    template_id: Optional[str] = None
    if template:
        tmpl = await template_get(db, template)
        if tmpl is None:
            raise ValueError(f"Thread template '{template}' not found.")
        template_id = tmpl.id
        if system_prompt is None and tmpl.system_prompt:
            system_prompt = tmpl.system_prompt
        if metadata is None and tmpl.default_metadata:
            try:
                metadata = json.loads(tmpl.default_metadata)
            except (json.JSONDecodeError, TypeError):
                pass

    # Atomic idempotency: use transaction to prevent race condition on concurrent creates with same topic
    # Strategy: try INSERT first, if UNIQUE constraint fails then SELECT the existing one
    tid = str(uuid.uuid4())
    now = _now()
    meta_json = json.dumps(metadata) if metadata else None

    try:
        await db.execute(
            "INSERT INTO threads (id, topic, status, created_at, metadata, system_prompt, template_id) VALUES (?, ?, 'discuss', ?, ?, ?, ?)",
            (tid, topic, now, meta_json, system_prompt, template_id),
        )

        # Persist thread settings at creation time so creator-admin is recorded
        # immediately in the database instead of being backfilled later.
        await db.execute(
            """
            INSERT INTO thread_settings (
                thread_id,
                auto_administrator_enabled,
                timeout_seconds,
                switch_timeout_seconds,
                last_activity_time,
                creator_admin_id,
                creator_admin_name,
                creator_assignment_time,
                created_at,
                updated_at
            )
            VALUES (?, 1, 60, 60, ?, ?, ?, ?, ?, ?)
            """,
            (
                tid,
                now,
                creator_admin_id,
                creator_admin_name,
                now if creator_admin_id else None,
                now,
                now,
            ),
        )

        await db.commit()
        await _emit_event(db, "thread.new", tid, {"thread_id": tid, "topic": topic})
        logger.info(f"Thread created: {tid} '{topic}'")
        return Thread(id=tid, topic=topic, status="discuss", created_at=_parse_dt(now),
                      closed_at=None, summary=None, metadata=meta_json, system_prompt=system_prompt,
                      template_id=template_id)
    except sqlite3.IntegrityError as e:
        # UNIQUE constraint violation on threads.topic — another thread was created concurrently
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


async def thread_get_by_topic(db: aiosqlite.Connection, topic: str) -> Optional[Thread]:
    async with db.execute("SELECT * FROM threads WHERE topic = ?", (topic,)) as cur:
        row = await cur.fetchone()
    if row is None:
        return None
    return _row_to_thread(row)


async def thread_list(
    db: aiosqlite.Connection,
    status: Optional[str] = None,
    include_archived: bool = False,
    limit: int = 0,
    before: Optional[str] = None,
) -> list[Thread]:
    """List threads with optional cursor pagination.

    Args:
        db: Database connection.
        status: Filter by lifecycle status. If set, overrides include_archived.
        include_archived: When True and status is None, include archived threads.
        limit: Maximum number of threads to return. 0 means no limit (all threads).
               Hard cap: 200.
        before: Keyset cursor — ISO datetime string. Returns threads whose
                created_at is strictly less than this value (exclusive upper bound).
                Pass the `next_cursor` from a previous response to page forward.
    """
    effective_limit = min(limit, 200) if limit > 0 else 0

    clauses: list[str] = []
    params: list[object] = []

    if status:
        clauses.append("status = ?")
        params.append(status)
    elif not include_archived:
        clauses.append("status != 'archived'")

    if before:
        clauses.append("created_at < ?")
        params.append(before)

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    sql = f"SELECT * FROM threads {where} ORDER BY created_at DESC"

    if effective_limit > 0:
        sql += " LIMIT ?"
        params.append(effective_limit)

    async with db.execute(sql, params) as cur:
        rows = await cur.fetchall()
    return [_row_to_thread(r) for r in rows]


async def thread_count(
    db: aiosqlite.Connection,
    status: Optional[str] = None,
    include_archived: bool = False,
) -> int:
    """Return total thread count matching the given filters (without pagination).

    Args:
        db: Database connection.
        status: Filter by lifecycle status. If set, overrides include_archived.
        include_archived: When True and status is None, include archived threads.
    """
    clauses: list[str] = []
    params: list[object] = []

    if status:
        clauses.append("status = ?")
        params.append(status)
    elif not include_archived:
        clauses.append("status != 'archived'")

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    sql = f"SELECT COUNT(*) FROM threads {where}"

    async with db.execute(sql, params) as cur:
        row = await cur.fetchone()
    return row[0] if row else 0


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
    
    All dependent records are deleted first to satisfy FK constraints.
    The cleanup discovers FK-linked tables dynamically so new schema additions
    do not silently break thread deletion behavior.
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
        # Delete dependent records first (satisfy FK constraints)
        await db.execute("DELETE FROM events WHERE thread_id = ?", (thread_id,))
        # Remove rows in tables FK-linked to messages before deleting messages.
        await _delete_fk_dependents_for_thread(db, thread_id, referenced_table="messages")
        await db.execute("DELETE FROM messages WHERE thread_id = ?", (thread_id,))
        # Remove rows in tables FK-linked directly to threads.
        await _delete_fk_dependents_for_thread(db, thread_id, referenced_table="threads")
        # Defensive explicit cleanup for non-FK-linked rows.
        await db.execute("DELETE FROM reply_tokens WHERE thread_id = ?", (thread_id,))
        await db.execute("DELETE FROM thread_settings WHERE thread_id = ?", (thread_id,))
        # Finally delete the thread itself
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


async def issue_reply_token(
    db: aiosqlite.Connection,
    thread_id: str,
    agent_id: Optional[str] = None,
    source: str = "msg_wait",
) -> dict:
    """Issue a reply token bound to a thread (and optionally an agent).

    NOTE: Reply tokens are single-use (consumed on successful msg_post) but do not expire.
    """
    token = secrets.token_urlsafe(24)
    issued_at = _now()
    # Kept for backwards-compatibility with existing schema/clients.
    # Tokens are treated as non-expiring, so we set expires_at far in the future.
    expires_at = "9999-12-31T23:59:59+00:00"
    await db.execute(
        "INSERT INTO reply_tokens (token, thread_id, agent_id, issued_at, expires_at, consumed_at, status, source, fast_returned_at) "
        "VALUES (?, ?, ?, ?, ?, NULL, 'issued', ?, NULL)",
        (token, thread_id, agent_id, issued_at, expires_at, source),
    )
    await db.commit()
    current_seq = await thread_latest_seq(db, thread_id)
    return {
        "reply_token": token,
        "current_seq": current_seq,
        "reply_window": {
            "expires_at": expires_at,
            "max_new_messages": SEQ_TOLERANCE,
        },
    }

async def reply_tokens_invalidate_for_agent(
    db: aiosqlite.Connection,
    thread_id: str,
    agent_id: str,
) -> None:
    now = _now()
    await db.execute(
        "UPDATE reply_tokens SET status = 'consumed', consumed_at = ? "
        "WHERE thread_id = ? AND agent_id = ? AND status = 'issued'",
        (now, thread_id, agent_id),
    )
    await db.commit()


async def reply_tokens_invalidate_for_agent_except(
    db: aiosqlite.Connection,
    thread_id: str,
    agent_id: str,
    keep_token: str,
) -> None:
    now = _now()
    await db.execute(
        "UPDATE reply_tokens SET status = 'consumed', consumed_at = ? "
        "WHERE thread_id = ? AND agent_id = ? AND status = 'issued' AND token != ?",
        (now, thread_id, agent_id, keep_token),
    )
    await db.commit()


async def reply_tokens_invalidate_for_agent_source(
    db: aiosqlite.Connection,
    thread_id: str,
    agent_id: str,
    source: str,
) -> None:
    now = _now()
    await db.execute(
        "UPDATE reply_tokens SET status = 'consumed', consumed_at = ? "
        "WHERE thread_id = ? AND agent_id = ? AND source = ? AND status = 'issued'",
        (now, thread_id, agent_id, source),
    )
    await db.commit()


async def reply_token_get_latest_issued(
    db: aiosqlite.Connection,
    thread_id: str,
    agent_id: str,
) -> Optional[dict]:
    async with db.execute(
        "SELECT token, expires_at FROM reply_tokens "
        "WHERE thread_id = ? AND agent_id = ? AND status = 'issued' "
        "ORDER BY issued_at DESC LIMIT 1",
        (thread_id, agent_id),
    ) as cur:
        row = await cur.fetchone()
    if not row:
        return None
    return {
        "reply_token": row["token"],
        "expires_at": row["expires_at"],
    }


async def _ensure_msg_wait_refresh_requests_table(db: aiosqlite.Connection) -> None:
    await db.execute(
        """
        CREATE TABLE IF NOT EXISTS msg_wait_refresh_requests (
            thread_id     TEXT NOT NULL,
            agent_id      TEXT NOT NULL,
            requested_at  TEXT NOT NULL,
            reason        TEXT,
            PRIMARY KEY (thread_id, agent_id)
        )
        """
    )
    await db.commit()


async def msg_wait_refresh_request_set(
    db: aiosqlite.Connection,
    thread_id: str,
    agent_id: str,
    reason: str | None = None,
) -> None:
    await _ensure_msg_wait_refresh_requests_table(db)
    now = _now()
    await db.execute(
        """
        INSERT INTO msg_wait_refresh_requests (thread_id, agent_id, requested_at, reason)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(thread_id, agent_id)
        DO UPDATE SET requested_at = excluded.requested_at,
                      reason = excluded.reason
        """,
        (thread_id, agent_id, now, reason),
    )
    await db.commit()


async def msg_wait_refresh_request_get(
    db: aiosqlite.Connection,
    thread_id: str,
    agent_id: str,
) -> Optional[dict]:
    await _ensure_msg_wait_refresh_requests_table(db)
    async with db.execute(
        "SELECT thread_id, agent_id, requested_at, reason FROM msg_wait_refresh_requests WHERE thread_id = ? AND agent_id = ?",
        (thread_id, agent_id),
    ) as cur:
        row = await cur.fetchone()
    if not row:
        return None
    return {
        "thread_id": row["thread_id"],
        "agent_id": row["agent_id"],
        "requested_at": row["requested_at"],
        "reason": row["reason"],
    }


async def msg_wait_refresh_request_clear(
    db: aiosqlite.Connection,
    thread_id: str,
    agent_id: str,
) -> None:
    await _ensure_msg_wait_refresh_requests_table(db)
    await db.execute(
        "DELETE FROM msg_wait_refresh_requests WHERE thread_id = ? AND agent_id = ?",
        (thread_id, agent_id),
    )
    await db.commit()


async def reply_token_find_pending_bus_connect(
    db: aiosqlite.Connection,
    thread_id: str,
    agent_id: str,
) -> Optional[str]:
    """Return newest pending bus_connect token that has not used fast-return yet."""
    async with db.execute(
        "SELECT token FROM reply_tokens "
        "WHERE thread_id = ? AND agent_id = ? AND status = 'issued' "
        "AND source = 'bus_connect' AND fast_returned_at IS NULL "
        "ORDER BY issued_at DESC LIMIT 1",
        (thread_id, agent_id),
    ) as cur:
        row = await cur.fetchone()
    if not row:
        return None
    return row["token"]


async def reply_token_mark_fast_returned(
    db: aiosqlite.Connection,
    token: str,
) -> bool:
    now = _now()
    async with db.execute(
        "UPDATE reply_tokens SET fast_returned_at = ? "
        "WHERE token = ? AND status = 'issued' AND fast_returned_at IS NULL",
        (now, token),
    ) as cur:
        updated = cur.rowcount
    await db.commit()
    return bool(updated)



# ─────────────────────────────────────────────────────────────────────────────
# Thread wait states (cross-process shared)
# ─────────────────────────────────────────────────────────────────────────────

async def thread_wait_enter(
    db: aiosqlite.Connection,
    thread_id: str,
    agent_id: str,
    timeout_ms: int,
) -> None:
    now = _now()
    await db.execute(
        """
        INSERT INTO thread_wait_states (thread_id, agent_id, entered_at, updated_at, timeout_ms)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(thread_id, agent_id)
        DO UPDATE SET entered_at = excluded.entered_at,
                      updated_at = excluded.updated_at,
                      timeout_ms = excluded.timeout_ms
        """,
        (thread_id, agent_id, now, now, timeout_ms),
    )
    await db.commit()


async def thread_wait_exit(
    db: aiosqlite.Connection,
    thread_id: str,
    agent_id: str,
) -> None:
    await db.execute(
        "DELETE FROM thread_wait_states WHERE thread_id = ? AND agent_id = ?",
        (thread_id, agent_id),
    )
    await db.commit()


async def thread_wait_clear_thread(db: aiosqlite.Connection, thread_id: str) -> None:
    await db.execute("DELETE FROM thread_wait_states WHERE thread_id = ?", (thread_id,))
    await db.commit()


async def thread_wait_remove_agent(db: aiosqlite.Connection, agent_id: str) -> list[str]:
    async with db.execute(
        "SELECT DISTINCT thread_id FROM thread_wait_states WHERE agent_id = ?",
        (agent_id,),
    ) as cur:
        rows = await cur.fetchall()
    thread_ids = [r["thread_id"] for r in rows]
    await db.execute("DELETE FROM thread_wait_states WHERE agent_id = ?", (agent_id,))
    await db.commit()
    return thread_ids


async def thread_wait_states_grouped(db: aiosqlite.Connection) -> dict[str, dict[str, dict]]:
    async with db.execute(
        "SELECT thread_id, agent_id, entered_at, timeout_ms FROM thread_wait_states"
    ) as cur:
        rows = await cur.fetchall()
    grouped: dict[str, dict[str, dict]] = {}
    for row in rows:
        thread_id = row["thread_id"]
        agent_id = row["agent_id"]
        grouped.setdefault(thread_id, {})[agent_id] = {
            "entered_at": _parse_dt(row["entered_at"]),
            "timeout_ms": int(row["timeout_ms"]),
        }
    return grouped


# ─────────────────────────────────────────────────────────────────────────────
# Thread Settings CRUD
# ─────────────────────────────────────────────────────────────────────────────

async def thread_settings_get_or_create(
    db: aiosqlite.Connection,
    thread_id: str,
) -> ThreadSettings:
    """Get thread settings or create with defaults if not exists."""
    async with db.execute(
        "SELECT * FROM thread_settings WHERE thread_id = ?",
        (thread_id,),
    ) as cur:
        row = await cur.fetchone()
    
    if row:
        return ThreadSettings(
            id=row["id"],
            thread_id=row["thread_id"],
            auto_administrator_enabled=bool(row["auto_administrator_enabled"]),
            timeout_seconds=row["timeout_seconds"],
            switch_timeout_seconds=_row_get(row, "switch_timeout_seconds", 60),
            last_activity_time=_parse_dt(row["last_activity_time"]),
            auto_assigned_admin_id=row["auto_assigned_admin_id"],
            auto_assigned_admin_name=row["auto_assigned_admin_name"],
            admin_assignment_time=_parse_dt(row["admin_assignment_time"]) if row["admin_assignment_time"] else None,
            creator_admin_id=_row_get(row, "creator_admin_id"),
            creator_admin_name=_row_get(row, "creator_admin_name"),
            creator_assignment_time=_parse_dt(_row_get(row, "creator_assignment_time")) if _row_get(row, "creator_assignment_time") else None,
            created_at=_parse_dt(row["created_at"]),
            updated_at=_parse_dt(row["updated_at"]),
        )
    
    # Create new settings with defaults
    now = _now()
    await db.execute(
        """
        INSERT INTO thread_settings 
        (thread_id, auto_administrator_enabled, timeout_seconds, switch_timeout_seconds, last_activity_time, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (thread_id, True, 60, 60, now, now, now),
    )
    await db.commit()
    
    # Fetch and return the newly created settings
    async with db.execute(
        "SELECT * FROM thread_settings WHERE thread_id = ?",
        (thread_id,),
    ) as cur:
        row = await cur.fetchone()
    
    return ThreadSettings(
        id=row["id"],
        thread_id=row["thread_id"],
        auto_administrator_enabled=bool(row["auto_administrator_enabled"]),
        timeout_seconds=row["timeout_seconds"],
        switch_timeout_seconds=_row_get(row, "switch_timeout_seconds", 60),
        last_activity_time=_parse_dt(row["last_activity_time"]),
        auto_assigned_admin_id=row["auto_assigned_admin_id"],
        auto_assigned_admin_name=row["auto_assigned_admin_name"],
        admin_assignment_time=_parse_dt(row["admin_assignment_time"]) if row["admin_assignment_time"] else None,
        creator_admin_id=_row_get(row, "creator_admin_id"),
        creator_admin_name=_row_get(row, "creator_admin_name"),
        creator_assignment_time=_parse_dt(_row_get(row, "creator_assignment_time")) if _row_get(row, "creator_assignment_time") else None,
        created_at=_parse_dt(row["created_at"]),
        updated_at=_parse_dt(row["updated_at"]),
    )


async def thread_settings_update(
    db: aiosqlite.Connection,
    thread_id: str,
    auto_administrator_enabled: Optional[bool] = None,
    auto_coordinator_enabled: Optional[bool] = None,
    timeout_seconds: Optional[int] = None,
    switch_timeout_seconds: Optional[int] = None,
) -> ThreadSettings:
    """Update thread settings for coordination and timeouts."""
    # Backward compatibility: accept legacy field name.
    if auto_administrator_enabled is None and auto_coordinator_enabled is not None:
        auto_administrator_enabled = auto_coordinator_enabled

    # Validate timeout_seconds if provided
    if timeout_seconds is not None:
        if timeout_seconds < 30:
            raise ValueError("timeout_seconds must be at least 30")

    if switch_timeout_seconds is not None:
        if switch_timeout_seconds < 30:
            raise ValueError("switch_timeout_seconds must be at least 30")
    
    # Prepare update statement
    updates = []
    values = []
    
    if auto_administrator_enabled is not None:
        updates.append("auto_administrator_enabled = ?")
        values.append(1 if auto_administrator_enabled else 0)
    
    if timeout_seconds is not None:
        updates.append("timeout_seconds = ?")
        values.append(timeout_seconds)

    if switch_timeout_seconds is not None:
        updates.append("switch_timeout_seconds = ?")
        values.append(switch_timeout_seconds)
    
    updates.append("updated_at = ?")
    values.append(_now())
    values.append(thread_id)
    
    if updates:
        await db.execute(
            f"UPDATE thread_settings SET {', '.join(updates)} WHERE thread_id = ?",
            values,
        )
        await db.commit()
    
    # Return updated settings
    return await thread_settings_get_or_create(db, thread_id)


async def thread_settings_update_activity(
    db: aiosqlite.Connection,
    thread_id: str,
) -> None:
    """Update last_activity_time and clear auto-assigned admin (activity detected)."""
    now = _now()
    await db.execute(
        """
        UPDATE thread_settings 
        SET last_activity_time = ?, 
            auto_assigned_admin_id = NULL,
            auto_assigned_admin_name = NULL,
            admin_assignment_time = NULL,
            updated_at = ?
        WHERE thread_id = ?
        """,
        (now, now, thread_id),
    )
    await db.commit()


async def thread_settings_assign_admin(
    db: aiosqlite.Connection,
    thread_id: str,
    admin_id: str,
    admin_name: str,
) -> ThreadSettings:
    """Assign an admin to the thread (automatic coordinator selection)."""
    now = _now()
    await db.execute(
        """
        UPDATE thread_settings 
        SET auto_assigned_admin_id = ?,
            auto_assigned_admin_name = ?,
            admin_assignment_time = ?,
            updated_at = ?
        WHERE thread_id = ?
          AND auto_administrator_enabled = 1
        """,
        (admin_id, admin_name, now, now, thread_id),
    )
    await db.commit()
    return await thread_settings_get_or_create(db, thread_id)


async def thread_settings_set_creator_admin(
    db: aiosqlite.Connection,
    thread_id: str,
    creator_id: str,
    creator_name: str,
) -> ThreadSettings:
    """Set the thread creator as the default admin.
    
    This is called when a thread is created by an agent via MCP.
    The creator has priority over auto-assigned admins.
    """
    now = _now()
    await db.execute(
        """
        UPDATE thread_settings 
        SET creator_admin_id = ?,
            creator_admin_name = ?,
            creator_assignment_time = ?,
            updated_at = ?
        WHERE thread_id = ?
          AND auto_administrator_enabled = 1
        """,
        (creator_id, creator_name, now, now, thread_id),
    )
    await db.commit()
    return await thread_settings_get_or_create(db, thread_id)


async def thread_settings_switch_admin(
    db: aiosqlite.Connection,
    thread_id: str,
    admin_id: str,
    admin_name: str,
) -> ThreadSettings:
    """Switch thread admin based on explicit human confirmation.

    This operation clears creator-admin priority and sets the selected admin as
    the active auto-assigned admin.
    """
    now = _now()
    await db.execute(
        """
        UPDATE thread_settings
        SET creator_admin_id = NULL,
            creator_admin_name = NULL,
            creator_assignment_time = NULL,
            auto_assigned_admin_id = ?,
            auto_assigned_admin_name = ?,
            admin_assignment_time = ?,
            updated_at = ?
        WHERE thread_id = ?
          AND auto_administrator_enabled = 1
        """,
        (admin_id, admin_name, now, now, thread_id),
    )
    await db.commit()
    return await thread_settings_get_or_create(db, thread_id)


async def thread_settings_get_timeouts(
    db: aiosqlite.Connection,
) -> list[ThreadSettings]:
    """Get all thread settings where timeout has been exceeded (and no admin assigned yet).
    
    This query calculates elapsed time in seconds and compares against timeout_seconds.
    Returns threads where: (now - last_activity_time) >= timeout_seconds
    """
    now = _now()
    async with db.execute(
        """
        SELECT * FROM thread_settings 
        WHERE auto_administrator_enabled = 1
        AND auto_assigned_admin_id IS NULL
        AND (strftime('%s', ?) - strftime('%s', last_activity_time)) >= timeout_seconds
        """,
        (now,),
    ) as cur:
        rows = await cur.fetchall()
    
    result = []
    for row in rows:
        result.append(ThreadSettings(
            id=row["id"],
            thread_id=row["thread_id"],
            auto_administrator_enabled=bool(row["auto_administrator_enabled"]),
            timeout_seconds=row["timeout_seconds"],
            last_activity_time=_parse_dt(row["last_activity_time"]),
            auto_assigned_admin_id=row["auto_assigned_admin_id"],
            auto_assigned_admin_name=row["auto_assigned_admin_name"],
            admin_assignment_time=_parse_dt(row["admin_assignment_time"]) if row["admin_assignment_time"] else None,
            creator_admin_id=_row_get(row, "creator_admin_id"),
            creator_admin_name=_row_get(row, "creator_admin_name"),
            creator_assignment_time=_parse_dt(_row_get(row, "creator_assignment_time")) if _row_get(row, "creator_assignment_time") else None,
            created_at=_parse_dt(row["created_at"]),
            updated_at=_parse_dt(row["updated_at"]),
        ))
    return result


async def _get_new_messages_since(
    db: aiosqlite.Connection,
    thread_id: str,
    expected_last_seq: int,
    limit: int = SEQ_MISMATCH_MAX_MESSAGES,
) -> list[dict]:
    msgs = await msg_list(
        db,
        thread_id=thread_id,
        after_seq=expected_last_seq,
        limit=limit,
        include_system_prompt=False,
    )
    visible_msgs: list[Message] = []
    return [
        {
            "msg_id": m.id,
            "seq": m.seq,
            "author": m.author,
            "author_id": m.author_id,
            "author_name": m.author_name,
            "role": m.role,
            "content": m.content,
            "created_at": m.created_at.isoformat(),
            "metadata": m.metadata,
            "reply_to_msg_id": m.reply_to_msg_id,
            "priority": m.priority,
        }
        for m in msgs
    ]


def _row_to_thread(row: aiosqlite.Row) -> Thread:
    keys = row.keys()
    system_prompt = row["system_prompt"] if "system_prompt" in keys else None
    template_id = row["template_id"] if "template_id" in keys else None
    updated_at_raw = row["updated_at"] if "updated_at" in keys else None
    return Thread(
        id=row["id"],
        topic=row["topic"],
        status=row["status"],
        created_at=_parse_dt(row["created_at"]),
        updated_at=_parse_dt(updated_at_raw) if updated_at_raw else None,
        closed_at=_parse_dt(row["closed_at"]) if row["closed_at"] else None,
        summary=row["summary"],
        metadata=row["metadata"],
        system_prompt=system_prompt,
        template_id=template_id,
    )


def _row_to_template(row: aiosqlite.Row) -> ThreadTemplate:
    return ThreadTemplate(
        id=row["id"],
        name=row["name"],
        description=row["description"],
        system_prompt=row["system_prompt"],
        default_metadata=row["default_metadata"],
        created_at=_parse_dt(row["created_at"]),
        is_builtin=bool(row["is_builtin"]),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Thread Template CRUD (UP-18)
# ─────────────────────────────────────────────────────────────────────────────

async def template_list(db: aiosqlite.Connection) -> list[ThreadTemplate]:
    """List all thread templates (built-in + custom), ordered by is_builtin DESC then name."""
    async with db.execute(
        "SELECT * FROM thread_templates ORDER BY is_builtin DESC, name ASC"
    ) as cur:
        rows = await cur.fetchall()
    return [_row_to_template(r) for r in rows]


async def template_get(db: aiosqlite.Connection, template_id: str) -> Optional[ThreadTemplate]:
    """Fetch a template by ID. Returns None if not found."""
    async with db.execute(
        "SELECT * FROM thread_templates WHERE id = ?", (template_id,)
    ) as cur:
        row = await cur.fetchone()
    return _row_to_template(row) if row else None


async def template_create(
    db: aiosqlite.Connection,
    id: str,
    name: str,
    description: Optional[str] = None,
    system_prompt: Optional[str] = None,
    default_metadata: Optional[dict] = None,
) -> ThreadTemplate:
    """Create a custom (non-builtin) thread template. Raises ValueError on duplicate ID."""
    now = _now()
    meta_json = json.dumps(default_metadata) if default_metadata else None
    try:
        await db.execute(
            """
            INSERT INTO thread_templates (id, name, description, system_prompt, default_metadata, created_at, is_builtin)
            VALUES (?, ?, ?, ?, ?, ?, 0)
            """,
            (id, name, description, system_prompt, meta_json, now),
        )
        await db.commit()
    except sqlite3.IntegrityError:
        raise ValueError(f"Template with id '{id}' already exists.")
    logger.info(f"Template created: {id} '{name}'")
    return ThreadTemplate(
        id=id,
        name=name,
        description=description,
        system_prompt=system_prompt,
        default_metadata=meta_json,
        created_at=_parse_dt(now),
        is_builtin=False,
    )


async def template_delete(db: aiosqlite.Connection, template_id: str) -> None:
    """Delete a custom template. Raises ValueError if template is built-in or not found."""
    async with db.execute(
        "SELECT id, is_builtin FROM thread_templates WHERE id = ?", (template_id,)
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        raise ValueError(f"Template '{template_id}' not found.")
    if row["is_builtin"]:
        raise ValueError(f"Template '{template_id}' is built-in and cannot be deleted.")
    await db.execute("DELETE FROM thread_templates WHERE id = ?", (template_id,))
    await db.commit()
    logger.info(f"Template deleted: {template_id}")


# ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
# Message CRUD
# ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

_VALID_PRIORITIES = {"normal", "urgent", "system"}


async def msg_get(db: aiosqlite.Connection, message_id: str) -> Optional[Message]:
    """Fetch a single message by ID. Returns None if not found."""
    async with db.execute("SELECT * FROM messages WHERE id = ?", (message_id,)) as cur:
        row = await cur.fetchone()
    return _row_to_message(row) if row else None


async def msg_post(
    db: aiosqlite.Connection,
    thread_id: str,
    author: str,
    content: str,
    expected_last_seq: int,
    reply_token: str,
    role: str = "user",
    metadata: Optional[dict] = None,
    priority: str = "normal",
    reply_to_msg_id: Optional[str] = None,
) -> Message:
    # Validate priority (UP-16)
    if priority not in _VALID_PRIORITIES:
        raise ValueError(f"Invalid priority '{priority}'. Must be one of: {', '.join(sorted(_VALID_PRIORITIES))}")

    # Validate reply_to_msg_id (UP-14): must exist and belong to the same thread
    if reply_to_msg_id is not None:
        async with db.execute(
            "SELECT thread_id FROM messages WHERE id = ?", (reply_to_msg_id,)
        ) as cur:
            parent_row = await cur.fetchone()
        if parent_row is None:
            raise ValueError(f"reply_to_msg_id '{reply_to_msg_id}' does not exist.")
        if parent_row["thread_id"] != thread_id:
            raise ValueError(
                f"reply_to_msg_id '{reply_to_msg_id}' belongs to a different thread."
            )

    # Content filter: block known secret patterns before any DB interaction
    if CONTENT_FILTER_ENABLED:
        blocked, pattern_name = check_content(content)
        if blocked:
            raise ContentFilterError(pattern_name)

    actual_author = author
    author_id = None
    author_name = author

    async with db.execute("SELECT id, name FROM agents WHERE id = ?", (author,)) as cur:
        row = await cur.fetchone()
        if row:
            actual_author = row["name"]
            author_id = row["id"]
            author_name = row["name"]

    # Rate limiting: enforce per-author message rate before any DB write
    if RATE_LIMIT_ENABLED:
        window_seconds = 60
        cutoff = (datetime.now(timezone.utc) - timedelta(seconds=window_seconds)).isoformat()
        if author_id:
            async with db.execute(
                "SELECT COUNT(*) AS cnt FROM messages WHERE author_id = ? AND created_at > ?",
                (author_id, cutoff),
            ) as cur:
                row = await cur.fetchone()
            count = row["cnt"]
            scope = "author_id"
        else:
            async with db.execute(
                "SELECT COUNT(*) AS cnt FROM messages WHERE author = ? AND created_at > ?",
                (actual_author, cutoff),
            ) as cur:
                row = await cur.fetchone()
            count = row["cnt"]
            scope = "author"
        if count >= RATE_LIMIT_MSG_PER_MINUTE:
            raise RateLimitExceeded(
                limit=RATE_LIMIT_MSG_PER_MINUTE,
                window=window_seconds,
                retry_after=window_seconds,
                scope=scope,
            )

    missing_fields: list[str] = []
    if expected_last_seq is None:
        missing_fields.append("expected_last_seq")
    if not reply_token:
        missing_fields.append("reply_token")
    if missing_fields:
        raise MissingSyncFieldsError(missing_fields)

    async with db.execute(
        "SELECT token, thread_id, agent_id, expires_at, consumed_at, status, source, fast_returned_at "
        "FROM reply_tokens WHERE token = ?",
        (reply_token,),
    ) as cur:
        token_row = await cur.fetchone()

    if token_row is None:
        raise ReplyTokenInvalidError(reply_token)
    if token_row["thread_id"] != thread_id:
        raise ReplyTokenInvalidError(reply_token)
    if token_row["status"] == "consumed":
        raise ReplyTokenReplayError(reply_token, token_row["consumed_at"])

    # Token expiration is intentionally not enforced. For legacy DBs that already
    # have tokens marked as 'expired', treat them the same as 'issued'.

    token_agent_id = token_row["agent_id"]
    if token_agent_id and author_id and token_agent_id != author_id:
        raise ReplyTokenInvalidError(reply_token)

    current_seq = await thread_latest_seq(db, thread_id)
    new_messages_count = current_seq - expected_last_seq
    if new_messages_count > SEQ_TOLERANCE:
        new_messages = await _get_new_messages_since(db, thread_id, expected_last_seq)
        raise SeqMismatchError(expected_last_seq, current_seq, new_messages)

    mid = str(uuid.uuid4())
    now = _now()
    seq = await next_seq(db)
    meta_json = json.dumps(metadata) if metadata else None
    await db.execute(
        "INSERT INTO messages (id, thread_id, author, role, content, seq, created_at, metadata, author_id, author_name, priority, reply_to_msg_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (mid, thread_id, actual_author, role, content, seq, now, meta_json, author_id, author_name, priority, reply_to_msg_id),
    )
    await db.execute(
        "UPDATE threads SET updated_at = ? WHERE id = ?", (now, thread_id)
    )
    async with db.execute(
        "UPDATE reply_tokens SET status = 'consumed', consumed_at = ? "
        "WHERE token = ? AND status = 'issued'",
        (now, reply_token),
    ) as cur:
        consumed = cur.rowcount
    if consumed == 0:
        await db.rollback()
        async with db.execute(
            "SELECT consumed_at FROM reply_tokens WHERE token = ?",
            (reply_token,),
        ) as cur:
            row = await cur.fetchone()
        consumed_at = row["consumed_at"] if row else None
        raise ReplyTokenReplayError(reply_token, consumed_at)

    await db.commit()
    if author_id:
        await agent_msg_post(db, author_id)
    
    # Update thread activity for timeout tracking
    await thread_settings_update_activity(db, thread_id)
    
    await _emit_event(db, "msg.new", thread_id, {
        "msg_id": mid, "thread_id": thread_id, "author": author_name,
        "author_id": author_id, "role": role, "seq": seq, "content": content[:200],  # truncate for event payload
    })
    _VALID_STOP_REASONS = {"convergence", "timeout", "error", "complete", "impasse"}

    if metadata:
        handoff_target = metadata.get("handoff_target")
        if handoff_target:
            await _emit_event(db, "msg.handoff", thread_id, {
                "msg_id": mid, "thread_id": thread_id,
                "from_agent": author_name, "to_agent": handoff_target,
            })
        stop_reason = metadata.get("stop_reason")
        if stop_reason:
            if stop_reason not in _VALID_STOP_REASONS:
                raise ValueError(f"Invalid stop_reason '{stop_reason}'. Must be one of: {', '.join(sorted(_VALID_STOP_REASONS))}")
            await _emit_event(db, "msg.stop", thread_id, {
                "msg_id": mid, "thread_id": thread_id,
                "agent": author_name, "reason": stop_reason,
            })
    # SSE event for reply-to threading (UP-14)
    if reply_to_msg_id is not None:
        await _emit_event(db, "msg.reply", thread_id, {
            "msg_id": mid, "reply_to_msg_id": reply_to_msg_id,
            "thread_id": thread_id, "author": author_name, "seq": seq,
        })

    logger.debug(f"Message posted: seq={seq} author={author_name} thread={thread_id} priority={priority} reply_to={reply_to_msg_id}")
    return Message(
        id=mid, thread_id=thread_id, author=actual_author, role=role,
        content=content, seq=seq, created_at=_parse_dt(now), metadata=meta_json,
        author_id=author_id, author_name=author_name, priority=priority,
        reply_to_msg_id=reply_to_msg_id,
    )


async def msg_list(
    db: aiosqlite.Connection,
    thread_id: str,
    after_seq: int = 0,
    limit: int = 100,
    include_system_prompt: bool = True,
    priority: Optional[str] = None,
) -> list[Message]:
    if priority is not None:
        async with db.execute(
            "SELECT * FROM messages WHERE thread_id = ? AND seq > ? AND priority = ? ORDER BY seq ASC LIMIT ?",
            (thread_id, after_seq, priority, limit),
        ) as cur:
            rows = await cur.fetchall()
    else:
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


async def _msg_create_system(
    db: aiosqlite.Connection,
    thread_id: str,
    content: str,
    metadata: Optional[dict] = None,
    clear_auto_admin: bool = True,
) -> Message:
    """Internal: Create a system message without reply token validation.
    
    Used by internal coordination logic and background tasks.
    """
    mid = str(uuid.uuid4())
    now = _now()
    seq = await next_seq(db)
    meta_json = json.dumps(metadata) if metadata else None
    
    await db.execute(
        "INSERT INTO messages (id, thread_id, author, role, content, seq, created_at, metadata, author_id, author_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (mid, thread_id, "system", "system", content, seq, now, meta_json, "system", "System"),
    )
    await db.execute(
        "UPDATE threads SET updated_at = ? WHERE id = ?", (now, thread_id)
    )
    
    # Mark system message as consumed in reply_tokens (if using strict mode)
    # For system messages, we don't consume user tokens
    
    await db.commit()
    
    # Update thread activity for timeout tracking.
    # Some system flows (e.g. human-confirmed admin switch) must preserve admin assignment.
    if clear_auto_admin:
        await thread_settings_update_activity(db, thread_id)
    else:
        now2 = _now()
        await db.execute(
            """
            UPDATE thread_settings
            SET last_activity_time = ?,
                updated_at = ?
            WHERE thread_id = ?
            """,
            (now2, now2, thread_id),
        )
        await db.commit()
    
    await _emit_event(db, "msg.new", thread_id, {
        "msg_id": mid, "thread_id": thread_id, "author": "System",
        "author_id": "system", "role": "system", "seq": seq, "content": content[:200],
    })
    
    logger.debug(f"System message created: seq={seq} thread={thread_id}")
    return Message(
        id=mid, thread_id=thread_id, author="system", role="system",
        content=content, seq=seq, created_at=_parse_dt(now), metadata=meta_json,
        author_id="system", author_name="System"
    )

def _row_to_message(row: aiosqlite.Row) -> Message:
    # safe dict-like fallback for new columns on older DB schemas
    keys = row.keys()
    author_id = row["author_id"] if "author_id" in keys else None
    author_name = row["author_name"] if "author_name" in keys else None
    if not author_name:
        author_name = row["author"]
    priority = row["priority"] if "priority" in keys else "normal"
    reply_to_msg_id = row["reply_to_msg_id"] if "reply_to_msg_id" in keys else None
    edited_at_raw = row["edited_at"] if "edited_at" in keys else None
    edit_version = row["edit_version"] if "edit_version" in keys else 0

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
        priority=priority,
        reply_to_msg_id=reply_to_msg_id,
        edited_at=_parse_dt(edited_at_raw) if edited_at_raw else None,
        edit_version=edit_version if edit_version is not None else 0,
    )


def _row_to_reaction(row: aiosqlite.Row) -> Reaction:
    return Reaction(
        id=row["id"],
        message_id=row["message_id"],
        agent_id=row["agent_id"],
        agent_name=row["agent_name"],
        reaction=row["reaction"],
        created_at=_parse_dt(row["created_at"]),
    )


# ─────────────────────────────────────────────
# Reactions (UP-13)
# ─────────────────────────────────────────────

class MessageNotFoundError(Exception):
    def __init__(self, message_id: str) -> None:
        self.message_id = message_id
        super().__init__(f"Message '{message_id}' not found")


async def msg_react(
    db: aiosqlite.Connection,
    message_id: str,
    agent_id: Optional[str],
    reaction: str,
) -> Reaction:
    """Add a reaction to a message. Idempotent — duplicate reactions are silently ignored."""
    if not reaction or not reaction.strip():
        raise ValueError("Reaction must be a non-empty string")

    # Verify message exists
    async with db.execute("SELECT id FROM messages WHERE id = ?", (message_id,)) as cur:
        msg_row = await cur.fetchone()
    if msg_row is None:
        raise MessageNotFoundError(message_id)

    # Resolve agent name
    agent_name: Optional[str] = None
    if agent_id:
        async with db.execute("SELECT name FROM agents WHERE id = ?", (agent_id,)) as cur:
            agent_row = await cur.fetchone()
        if agent_row:
            agent_name = agent_row["name"]

    rid = str(uuid.uuid4())
    now = _now()

    async with db.execute(
        "INSERT OR IGNORE INTO reactions (id, message_id, agent_id, agent_name, reaction, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (rid, message_id, agent_id, agent_name, reaction, now),
    ) as cur:
        inserted = cur.rowcount

    await db.commit()

    # Emit SSE event only when a new row was actually inserted (not a duplicate)
    if inserted > 0:
        await _emit_event(db, "msg.react", None, {
            "reaction_id": rid, "message_id": message_id,
            "agent_id": agent_id, "agent_name": agent_name, "reaction": reaction,
        })
        logger.debug(f"Reaction added: message={message_id} agent={agent_id} reaction={reaction}")
    else:
        logger.debug(f"Reaction already exists (ignored): message={message_id} agent={agent_id} reaction={reaction}")

    # Fetch the actual stored row (may differ from rid if it was a duplicate)
    async with db.execute(
        "SELECT * FROM reactions WHERE message_id = ? AND agent_id IS ? AND reaction = ?",
        (message_id, agent_id, reaction),
    ) as cur:
        row = await cur.fetchone()
    return _row_to_reaction(row)


async def msg_unreact(
    db: aiosqlite.Connection,
    message_id: str,
    agent_id: Optional[str],
    reaction: str,
) -> bool:
    """Remove a reaction. Returns True if deleted, False if it did not exist."""
    async with db.execute(
        "DELETE FROM reactions WHERE message_id = ? AND agent_id IS ? AND reaction = ?",
        (message_id, agent_id, reaction),
    ) as cur:
        deleted = cur.rowcount

    await db.commit()

    if deleted > 0:
        await _emit_event(db, "msg.unreact", None, {
            "message_id": message_id, "agent_id": agent_id, "reaction": reaction,
        })
        logger.debug(f"Reaction removed: message={message_id} agent={agent_id} reaction={reaction}")
        return True

    logger.debug(f"Reaction not found (no-op): message={message_id} agent={agent_id} reaction={reaction}")
    return False


async def msg_reactions(
    db: aiosqlite.Connection,
    message_id: str,
) -> list[Reaction]:
    """Return all reactions for a given message, ordered by created_at."""
    async with db.execute(
        "SELECT * FROM reactions WHERE message_id = ? ORDER BY created_at ASC",
        (message_id,),
    ) as cur:
        rows = await cur.fetchall()
    return [_row_to_reaction(r) for r in rows]


async def msg_reactions_bulk(
    db: aiosqlite.Connection,
    message_ids: list[str],
) -> dict[str, list[dict]]:
    """Batch-fetch reactions for a list of message IDs.

    Returns a dict mapping message_id -> list of reaction dicts.
    Single SQL query with IN (...) to avoid N+1 calls from msg_list.
    """
    if not message_ids:
        return {}

    placeholders = ",".join("?" * len(message_ids))
    async with db.execute(
        f"SELECT * FROM reactions WHERE message_id IN ({placeholders}) ORDER BY created_at ASC",
        message_ids,
    ) as cur:
        rows = await cur.fetchall()

    result: dict[str, list[dict]] = {mid: [] for mid in message_ids}
    for row in rows:
        mid = row["message_id"]
        result[mid].append({
            "id": row["id"],
            "agent_id": row["agent_id"],
            "agent_name": row["agent_name"],
            "reaction": row["reaction"],
            "created_at": row["created_at"],
        })
    return result


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
    skills: Optional[list] = None,
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
    skills_json = json.dumps(skills) if skills else None
    clean_display_name = (display_name or "").strip() or name
    alias_source = "user" if (display_name or "").strip() else "auto"
    await db.execute(
        "INSERT INTO agents (id, name, ide, model, description, capabilities, skills, registered_at, last_heartbeat, token, display_name, alias_source, last_activity, last_activity_time) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (aid, name, ide, model, description, caps_json, skills_json, now, now, token, clean_display_name, alias_source, "registered", now),
    )
    await db.commit()
    await _emit_event(db, "agent.online", None, {"agent_id": aid, "name": name, "ide": ide, "model": model})
    logger.info(f"Agent registered: {aid} '{name}'")
    return AgentInfo(id=aid, name=name, ide=ide, model=model, description=description,
                     capabilities=caps_json, registered_at=_parse_dt(now),
                     last_heartbeat=_parse_dt(now), is_online=True, token=token,
                     display_name=clean_display_name, alias_source=alias_source,
                     last_activity="registered", last_activity_time=_parse_dt(now),
                     skills=skills_json)


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


async def agent_msg_wait(db: aiosqlite.Connection, agent_id: str, token: str, wait_seconds: float = None, fast_return_allowed: bool = None, reason: str = None, after_seq: int = None, current_latest_seq: int = None) -> bool:
    async with db.execute("SELECT name, token FROM agents WHERE id = ?", (agent_id,)) as cur:
        row = await cur.fetchone()
    if row is None or row["token"] != token:
        return False
        
    # Temporary diagnostics for msg_wait behavior. Safe to delete after
    # wait/fast-return debugging is complete.
    if wait_seconds is not None:
        try:
            fast_return_str = f", fast_return_allowed: {fast_return_allowed if fast_return_allowed is not None else 'unknown'}"
            reason_str = f", reason: {reason}" if reason else ""
            seq_str = f", after_seq: {after_seq}, latest_seq: {current_latest_seq}" if after_seq is not None else ""
            log_line = f"[{_now()}] msg_wait - agent_id: {agent_id}, name: {row['name']}, wait_seconds: {wait_seconds}{fast_return_str}{reason_str}{seq_str}\n"
            with open("msg_wait.log", "a", encoding="utf-8") as f:
                f.write(log_line)
        except Exception as e:
            logger.error(f"Failed to write msg_wait log: {e}")

    try:
        # Best-effort: if this call comes from MCP SSE request context, bind the
        # current transport session to this agent so UI can classify transport
        # as SSE (not stdio) while the agent is long-polling msg_wait.
        import src.mcp_server as _mcp_server
        _mcp_server.set_connection_agent(agent_id, token)
    except Exception:
        pass
    # When an agent is performing a long-poll `msg_wait`, treat that as an
    # indication the agent is actively connected — update the heartbeat so the
    # `/api/agents` endpoint reports `is_online` correctly while the agent is
    # waiting. Previously this left `last_heartbeat` untouched, causing clients
    # that only long-poll (without sending explicit heartbeats) to appear
    # offline.
    return await _set_agent_activity(db, agent_id, "msg_wait", touch_heartbeat=True)


async def agent_msg_received(db: aiosqlite.Connection, agent_id: str) -> bool:
    """Mark that agent has received a message from msg_wait and is now processing.
    This transitions the agent from Listening → Working on the frontend.
    """
    return await _set_agent_activity(db, agent_id, "msg_received", touch_heartbeat=False)


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


async def thread_agents_list(db: aiosqlite.Connection, thread_id: str) -> list[AgentInfo]:
    """List agents related to a thread.

    Sources:
    - message authors in the thread (messages.author_id)
    - thread admin assignments (creator/auto-assigned) from thread_settings
    """
    participant_ids: set[str] = set()

    async with db.execute(
        """
        SELECT DISTINCT author_id
        FROM messages
        WHERE thread_id = ?
          AND author_id IS NOT NULL
          AND author_id != ''
        """,
        (thread_id,),
    ) as cur:
        rows = await cur.fetchall()
    for row in rows:
        aid = row["author_id"]
        if aid:
            participant_ids.add(aid)

    async with db.execute(
        """
        SELECT creator_admin_id, auto_assigned_admin_id
        FROM thread_settings
        WHERE thread_id = ?
        """,
        (thread_id,),
    ) as cur:
        settings_row = await cur.fetchone()
    if settings_row is not None:
        creator_admin_id = _row_get(settings_row, "creator_admin_id")
        auto_assigned_admin_id = _row_get(settings_row, "auto_assigned_admin_id")
        if creator_admin_id:
            participant_ids.add(creator_admin_id)
        if auto_assigned_admin_id:
            participant_ids.add(auto_assigned_admin_id)

    if not participant_ids:
        return []

    placeholders = ",".join("?" for _ in participant_ids)
    params = [*participant_ids]
    async with db.execute(
        f"SELECT * FROM agents WHERE id IN ({placeholders}) ORDER BY registered_at",
        params,
    ) as cur:
        agent_rows = await cur.fetchall()
    return [_row_to_agent(r) for r in agent_rows]


async def agent_get(db: aiosqlite.Connection, agent_id: str) -> Optional[AgentInfo]:
    """Return a single agent by ID, or None if not found."""
    async with db.execute("SELECT * FROM agents WHERE id = ?", (agent_id,)) as cur:
        row = await cur.fetchone()
    return _row_to_agent(row) if row else None


async def agent_verify_token(db: aiosqlite.Connection, agent_id: str, token: str) -> bool:
    """Read-only token check — does not update last_seen or heartbeat."""
    async with db.execute("SELECT token FROM agents WHERE id = ?", (agent_id,)) as cur:
        row = await cur.fetchone()
    return row is not None and row["token"] == token


async def agent_update(
    db: aiosqlite.Connection,
    agent_id: str,
    token: str,
    description: Optional[str] = None,
    capabilities: Optional[list] = None,
    skills: Optional[list] = None,
    display_name: Optional[str] = None,
) -> AgentInfo:
    """
    Update mutable agent metadata after registration.

    Only the fields explicitly provided (not None) are modified.
    Requires a valid token to prevent unauthorised updates.
    """
    async with db.execute("SELECT token FROM agents WHERE id = ?", (agent_id,)) as cur:
        row = await cur.fetchone()
    if row is None:
        raise ValueError(f"Agent not found: {agent_id}")
    if row["token"] != token:
        raise ValueError("Invalid token for agent_update")

    now = _now()
    set_clauses: list[str] = ["last_activity = ?", "last_activity_time = ?"]
    params: list = ["update", now]

    if description is not None:
        set_clauses.append("description = ?")
        params.append(description)
    if capabilities is not None:
        set_clauses.append("capabilities = ?")
        params.append(json.dumps(capabilities))
    if skills is not None:
        set_clauses.append("skills = ?")
        params.append(json.dumps(skills))
    if display_name is not None:
        clean = display_name.strip()
        set_clauses.append("display_name = ?")
        params.append(clean)
        set_clauses.append("alias_source = ?")
        params.append("user" if clean else "auto")

    params.append(agent_id)
    await db.execute(
        f"UPDATE agents SET {', '.join(set_clauses)} WHERE id = ?",
        params,
    )
    await db.commit()

    async with db.execute("SELECT * FROM agents WHERE id = ?", (agent_id,)) as cur:
        updated = await cur.fetchone()
    if updated is None:
        raise ValueError("Agent not found after update")
    logger.info(f"Agent updated: {agent_id}")
    return _row_to_agent(updated)


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

    # Consider either the last heartbeat OR the most recent activity timestamp
    # as signals of being "online". This helps in cases where `last_heartbeat`
    # wasn't updated but the agent performed a recent activity (e.g. msg_wait
    # recorded last_activity_time). Use whichever is freshest.
    now = datetime.now(timezone.utc)
    activity_elapsed = (now - last_activity_time).total_seconds() if last_activity_time else None
    is_online = False
    if elapsed is not None and elapsed < AGENT_HEARTBEAT_TIMEOUT:
        is_online = True
    elif activity_elapsed is not None and activity_elapsed < AGENT_HEARTBEAT_TIMEOUT:
        is_online = True

    return AgentInfo(
        id=row["id"],
        name=row["name"],
        ide=row["ide"] if "ide" in row.keys() else "",
        model=row["model"] if "model" in row.keys() else "",
        description=row["description"] or "",
        capabilities=row["capabilities"],
        registered_at=_parse_dt(row["registered_at"]),
        last_heartbeat=last_hb,
        is_online=is_online,
        token=row["token"],
        display_name=display_name,
        alias_source=alias_source,
        last_activity=last_activity,
        last_activity_time=last_activity_time,
        skills=row["skills"] if "skills" in row.keys() else None,
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


# ─────────────────────────────────────────────
# Export
# ─────────────────────────────────────────────

async def thread_export_markdown(db: aiosqlite.Connection, thread_id: str) -> Optional[str]:
    """Build a Markdown transcript for *thread_id*.

    Returns the raw Markdown string, or None if the thread does not exist.
    System-prompt messages are excluded from the transcript.
    """
    thread = await thread_get(db, thread_id)
    if thread is None:
        return None

    msgs = await msg_list(db, thread_id, after_seq=0, limit=10000, include_system_prompt=False)

    created_label = thread.created_at.strftime("%Y-%m-%d %H:%M UTC")
    exported_label = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    lines: list[str] = [
        f"# {thread.topic}",
        "",
        f"> **Status:** {thread.status} | **Created:** {created_label}",
        f"> **Messages:** {len(msgs)} | **Exported:** {exported_label}",
        "",
        "---",
        "",
    ]

    for m in msgs:
        author = m.author_name or m.author
        timestamp = m.created_at.strftime("%Y-%m-%d %H:%M UTC")
        lines.append(f"### {author} — {timestamp}")
        lines.append("")
        lines.append(m.content)
        lines.append("")
        lines.append("---")
        lines.append("")

    return "\n".join(lines)


# ──────────────────────────────────────────────────────────────────────────────
# UP-22: Bus-level observability metrics
# ──────────────────────────────────────────────────────────────────────────────

async def get_bus_metrics(db: aiosqlite.Connection) -> dict:
    """Return a snapshot of bus-level observability metrics.

    All queries are read-only aggregates over existing tables — no schema
    changes required.  The result is a plain dict suitable for JSON serialisation.

    Fields
    ------
    threads.total          : total thread count across all statuses
    threads.by_status      : count per status value
    messages.total         : total message count (all threads)
    messages.rate          : message count in the last 1 / 5 / 15 minutes
    messages.avg_latency_ms: average inter-message interval (ms) in threads that
                             had at least two messages in the last 15 minutes.
                             null when no such threads exist.
    messages.stop_reasons  : count per stop_reason value from UP-17 metadata.
                             Only messages that carry a non-null stop_reason are
                             counted; the five canonical reasons are always
                             present (with 0 as default).
    agents.total           : total registered agent count
    agents.online          : agents whose last_heartbeat is within the
                             AGENT_HEARTBEAT_TIMEOUT window
    """
    now = datetime.now(timezone.utc)

    # ── Thread counts ──────────────────────────────────────────────────────────
    threads_by_status: dict[str, int] = {}
    async with db.execute("SELECT status, COUNT(*) AS cnt FROM threads GROUP BY status") as cur:
        async for row in cur:
            threads_by_status[row["status"]] = row["cnt"]
    threads_total = sum(threads_by_status.values())

    # ── Message total ──────────────────────────────────────────────────────────
    async with db.execute("SELECT COUNT(*) AS cnt FROM messages") as cur:
        row = await cur.fetchone()
    messages_total = row["cnt"] if row else 0

    # ── Message rates (1m / 5m / 15m) ─────────────────────────────────────────
    cutoffs = {
        "last_1m":  (now - timedelta(minutes=1)).isoformat(),
        "last_5m":  (now - timedelta(minutes=5)).isoformat(),
        "last_15m": (now - timedelta(minutes=15)).isoformat(),
    }
    message_rate: dict[str, int] = {}
    for key, cutoff in cutoffs.items():
        async with db.execute(
            "SELECT COUNT(*) AS cnt FROM messages WHERE created_at >= ?", (cutoff,)
        ) as cur:
            row = await cur.fetchone()
        message_rate[key] = row["cnt"] if row else 0

    # ── Inter-message latency (avg ms, threads active in last 15 min) ─────────
    # Uses LAG() window function (SQLite >= 3.25.0) to compute time gaps
    # between consecutive messages within each thread, then averages them.
    cutoff_15m = cutoffs["last_15m"]
    avg_latency_ms: Optional[float] = None
    try:
        lag_sql = """
            WITH gaps AS (
                SELECT
                    (julianday(created_at) - julianday(
                        LAG(created_at) OVER (PARTITION BY thread_id ORDER BY seq)
                    )) * 86400000.0 AS gap_ms
                FROM messages
                WHERE thread_id IN (
                    SELECT DISTINCT thread_id FROM messages WHERE created_at >= ?
                )
            )
            SELECT AVG(gap_ms) AS avg_gap FROM gaps WHERE gap_ms IS NOT NULL
        """
        async with db.execute(lag_sql, (cutoff_15m,)) as cur:
            row = await cur.fetchone()
        if row and row["avg_gap"] is not None:
            avg_latency_ms = round(row["avg_gap"], 1)
    except Exception:
        avg_latency_ms = None

    # ── stop_reason distribution (UP-17) ──────────────────────────────────────
    canonical_reasons = ("convergence", "timeout", "complete", "error", "impasse")
    stop_reasons: dict[str, int] = {r: 0 for r in canonical_reasons}
    async with db.execute(
        """
        SELECT json_extract(metadata, '$.stop_reason') AS reason, COUNT(*) AS cnt
        FROM messages
        WHERE json_extract(metadata, '$.stop_reason') IS NOT NULL
        GROUP BY reason
        """
    ) as cur:
        async for row in cur:
            reason = row["reason"]
            stop_reasons[reason] = stop_reasons.get(reason, 0) + row["cnt"]

    # ── Agent counts ───────────────────────────────────────────────────────────
    agents_total = 0
    agents_online = 0
    heartbeat_cutoff = (
        now - timedelta(seconds=AGENT_HEARTBEAT_TIMEOUT)
    ).isoformat()
    async with db.execute("SELECT COUNT(*) AS cnt FROM agents") as cur:
        row = await cur.fetchone()
    agents_total = row["cnt"] if row else 0
    async with db.execute(
        "SELECT COUNT(*) AS cnt FROM agents WHERE last_heartbeat >= ?",
        (heartbeat_cutoff,),
    ) as cur:
        row = await cur.fetchone()
    agents_online = row["cnt"] if row else 0

    return {
        "threads": {
            "total": threads_total,
            "by_status": threads_by_status,
        },
        "messages": {
            "total": messages_total,
            "rate": message_rate,
            "avg_latency_ms": avg_latency_ms,
            "stop_reasons": stop_reasons,
        },
        "agents": {
            "total": agents_total,
            "online": agents_online,
        },
    }


# ── FTS5 full-text search (UI-02) ────────────────────────────────────────────

async def msg_search(
    db: aiosqlite.Connection,
    query: str,
    thread_id: Optional[str] = None,
    limit: int = 50,
) -> list[dict]:
    """Full-text search across message content via FTS5.

    Returns a list of dicts with keys:
      message_id, thread_id, thread_topic, author, seq, created_at, snippet
    ordered by FTS5 relevance rank (best match first).

    Args:
        db: async database connection
        query: FTS5 MATCH expression (e.g. "hello world", "angular*")
        thread_id: optional — restrict search to a single thread
        limit: max results (capped at 200)
    """
    limit = min(limit, 200)

    if thread_id is not None:
        sql = """
            SELECT
                f.message_id,
                f.thread_id,
                t.topic       AS thread_topic,
                f.author,
                m.seq,
                m.created_at,
                m.metadata,
                snippet(messages_fts, 3, '<mark>', '</mark>', '…', 20) AS snippet
            FROM messages_fts f
            JOIN messages m ON m.id = f.message_id
            JOIN threads  t ON t.id = f.thread_id
            WHERE messages_fts MATCH ?
              AND f.thread_id = ?
            ORDER BY rank
            LIMIT ?
        """
        params = (query, thread_id, limit)
    else:
        sql = """
            SELECT
                f.message_id,
                f.thread_id,
                t.topic       AS thread_topic,
                f.author,
                m.seq,
                m.created_at,
                m.metadata,
                snippet(messages_fts, 3, '<mark>', '</mark>', '…', 20) AS snippet
            FROM messages_fts f
            JOIN messages m ON m.id = f.message_id
            JOIN threads  t ON t.id = f.thread_id
            WHERE messages_fts MATCH ?
            ORDER BY rank
            LIMIT ?
        """
        params = (query, limit)

    try:
        async with db.execute(sql, params) as cur:
            rows = await cur.fetchall()
    except Exception as e:
        # FTS5 MATCH syntax errors (e.g. bare "*") raise sqlite3.OperationalError
        logger.warning(f"msg_search FTS5 query failed: query={query!r} error={e}")
        return []

    return [
        {
            "message_id":   row["message_id"],
            "thread_id":    row["thread_id"],
            "thread_topic": row["thread_topic"],
            "author":       row["author"],
            "seq":          row["seq"],
            "created_at":   row["created_at"],
            "snippet":      row["snippet"],
            "metadata":     row["metadata"],
        }
        for row in rows
    ]


# ── Message edit / versioning (UP-21) ────────────────────────────────────────


class MessageEditNoChangeError(Exception):
    """Raised when msg_edit is called with content identical to the current content."""
    def __init__(self, current_version: int) -> None:
        self.current_version = current_version
        super().__init__(f"Content unchanged (current version: {current_version})")


def _row_to_message_edit(row: aiosqlite.Row) -> MessageEdit:
    return MessageEdit(
        id=row["id"],
        message_id=row["message_id"],
        old_content=row["old_content"],
        edited_by=row["edited_by"],
        version=row["version"],
        created_at=_parse_dt(row["created_at"]),
    )


async def msg_edit(
    db: aiosqlite.Connection,
    message_id: str,
    new_content: str,
    edited_by: str,
) -> MessageEdit:
    """Edit the content of a message, preserving full version history.

    Only the original author or 'system' can edit a message.

    If new_content is identical to the current content, raises
    MessageEditNoChangeError (caller should return 200 with no_change=True).

    Returns the newly created MessageEdit record.
    """
    msg = await msg_get(db, message_id)
    if msg is None:
        raise MessageNotFoundError(message_id)

    if msg.role == "system":
        raise PermissionError("System messages cannot be edited")

    allowed_editor_ids = {msg.author}
    if msg.author_id:
        allowed_editor_ids.add(msg.author_id)

    if edited_by not in allowed_editor_ids and edited_by != "system":
        raise PermissionError(
            f"Only the original author ('{msg.author_id or msg.author}') or 'system' can edit this message"
        )

    if msg.content == new_content:
        raise MessageEditNoChangeError(msg.edit_version)

    if CONTENT_FILTER_ENABLED:
        check_content(new_content)

    new_version = msg.edit_version + 1
    edit_id = str(uuid.uuid4())
    now = _now()

    await db.execute(
        """
        INSERT INTO message_edits (id, message_id, old_content, edited_by, version, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (edit_id, message_id, msg.content, edited_by, new_version, now),
    )

    await db.execute(
        """
        UPDATE messages
        SET content = ?, edited_at = ?, edit_version = ?
        WHERE id = ?
        """,
        (new_content, now, new_version, message_id),
    )
    await db.commit()

    await _emit_event(db, "msg.edit", msg.thread_id, {
        "msg_id": message_id,
        "thread_id": msg.thread_id,
        "edited_by": edited_by,
        "version": new_version,
        "content": new_content[:200],
    })

    return MessageEdit(
        id=edit_id,
        message_id=message_id,
        old_content=msg.content,
        edited_by=edited_by,
        version=new_version,
        created_at=_parse_dt(now),
    )


async def msg_edit_history(
    db: aiosqlite.Connection,
    message_id: str,
) -> list[MessageEdit]:
    """Return all edit records for a message, ordered by version ascending."""
    async with db.execute(
        "SELECT * FROM message_edits WHERE message_id = ? ORDER BY version ASC",
        (message_id,),
    ) as cur:
        rows = await cur.fetchall()
    return [_row_to_message_edit(row) for row in rows]

