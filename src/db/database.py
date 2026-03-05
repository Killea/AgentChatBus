"""
SQLite database connection management and schema initialization.
Uses aiosqlite for fully async, non-blocking access.
"""
import aiosqlite
import asyncio
import logging
import threading
import sqlite3
from pathlib import Path
from typing import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta

from src.config import DB_PATH

logger = logging.getLogger(__name__)

# Module-level connection pool (single shared connection with WAL mode)
_db: aiosqlite.Connection | None = None
_initializing = False

# Schema version for consistency tracking
SCHEMA_VERSION = 1


def _is_duplicate_column_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    return "duplicate column" in msg or "duplicate column name" in msg


async def _add_column_if_missing(
    db: aiosqlite.Connection,
    table: str,
    col: str,
    typedef: str,
) -> None:
    """Add a column via ALTER TABLE.

    SQLite doesn't support IF NOT EXISTS for ADD COLUMN, so we rely on catching
    the duplicate-column error. Anything else is a real migration failure.
    """
    try:
        await db.execute(f"ALTER TABLE {table} ADD COLUMN {col} {typedef}")
        await db.commit()
        logger.info(f"Migration: added column '{table}.{col}'")
    except sqlite3.OperationalError as e:
        if _is_duplicate_column_error(e):
            logger.debug(f"Migration skip: column '{table}.{col}' already exists")
        else:
            logger.exception(f"Migration failed while adding column '{table}.{col}'")
            raise
    except Exception:
        logger.exception(f"Unexpected migration error while adding column '{table}.{col}'")
        raise


async def _table_has_column(db: aiosqlite.Connection, table: str, column: str) -> bool:
    """Return True when `table` has `column` (case-insensitive)."""
    async with db.execute(f"PRAGMA table_info({table})") as cur:
        rows = await cur.fetchall()
    wanted = column.lower()
    return any(str(r[1]).lower() == wanted for r in rows)


async def _thread_settings_needs_timeout_migration(db: aiosqlite.Connection) -> bool:
    """Detect legacy thread_settings timeout constraints/defaults requiring rebuild."""
    async with db.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'thread_settings'"
    ) as cur:
        row = await cur.fetchone()
    if not row or not row["sql"]:
        return False

    ddl = str(row["sql"]).lower().replace("\n", " ")
    has_legacy_max = "timeout_seconds" in ddl and "<= 300" in ddl
    has_legacy_min = "timeout_seconds" in ddl and ">= 10" in ddl
    has_default_100 = "timeout_seconds" in ddl and "default 100" in ddl
    return has_legacy_max or has_legacy_min or has_default_100


async def _migrate_thread_settings_timeout_constraints(db: aiosqlite.Connection) -> None:
    """Rebuild thread_settings to apply timeout>=30 and default=60 with no max cap."""
    if not await _thread_settings_needs_timeout_migration(db):
        return

    logger.info("Migration: rebuilding thread_settings for timeout_seconds >= 30 (no max), default 60")

    has_creator_admin_id = await _table_has_column(db, "thread_settings", "creator_admin_id")
    has_creator_admin_name = await _table_has_column(db, "thread_settings", "creator_admin_name")
    has_creator_assignment_time = await _table_has_column(db, "thread_settings", "creator_assignment_time")
    has_auto_admin_col = await _table_has_column(db, "thread_settings", "auto_administrator_enabled")
    has_legacy_auto_col = await _table_has_column(db, "thread_settings", "auto_coordinator_enabled")

    if has_auto_admin_col:
        auto_admin_expr = "auto_administrator_enabled"
    elif has_legacy_auto_col:
        auto_admin_expr = "auto_coordinator_enabled"
    else:
        auto_admin_expr = "1"

    creator_id_expr = "creator_admin_id" if has_creator_admin_id else "NULL"
    creator_name_expr = "creator_admin_name" if has_creator_admin_name else "NULL"
    creator_time_expr = "creator_assignment_time" if has_creator_assignment_time else "NULL"

    await db.execute("PRAGMA foreign_keys=OFF")
    try:
        await db.executescript(
            """
            CREATE TABLE thread_settings_new (
                id                          INTEGER PRIMARY KEY AUTOINCREMENT,
                thread_id                   TEXT UNIQUE NOT NULL REFERENCES threads(id),
                auto_administrator_enabled  INTEGER NOT NULL DEFAULT 1,
                timeout_seconds             INTEGER NOT NULL DEFAULT 60 CHECK (timeout_seconds >= 30),
                last_activity_time          TEXT NOT NULL,
                auto_assigned_admin_id      TEXT,
                auto_assigned_admin_name    TEXT,
                admin_assignment_time       TEXT,
                creator_admin_id            TEXT,
                creator_admin_name          TEXT,
                creator_assignment_time     TEXT,
                created_at                  TEXT NOT NULL,
                updated_at                  TEXT NOT NULL
            );
            """
        )

        await db.execute(
            f"""
            INSERT INTO thread_settings_new (
                id,
                thread_id,
                auto_administrator_enabled,
                timeout_seconds,
                last_activity_time,
                auto_assigned_admin_id,
                auto_assigned_admin_name,
                admin_assignment_time,
                creator_admin_id,
                creator_admin_name,
                creator_assignment_time,
                created_at,
                updated_at
            )
            SELECT
                id,
                thread_id,
                COALESCE({auto_admin_expr}, 1),
                CASE
                    WHEN timeout_seconds IS NULL THEN 60
                    WHEN timeout_seconds < 30 THEN 30
                    ELSE timeout_seconds
                END,
                last_activity_time,
                auto_assigned_admin_id,
                auto_assigned_admin_name,
                admin_assignment_time,
                {creator_id_expr},
                {creator_name_expr},
                {creator_time_expr},
                created_at,
                updated_at
            FROM thread_settings
            """
        )

        await db.execute("DROP TABLE thread_settings")
        await db.execute("ALTER TABLE thread_settings_new RENAME TO thread_settings")
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_thread_settings_activity ON thread_settings(last_activity_time)"
        )
        await db.commit()
        logger.info("Migration: thread_settings timeout constraints updated successfully")
    finally:
        await db.execute("PRAGMA foreign_keys=ON")
        await db.commit()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Built-in thread templates (UP-18) ────────────────────────────────────────
# All templates are 100% generic — no project-specific references.
_BUILTIN_TEMPLATES = [
    (
        "code-review",
        "Code Review",
        "Structured code review focused on correctness, style, security, and performance.",
        "You are participating in a structured code review. Focus on: correctness, "
        "readability, security vulnerabilities, performance concerns, and adherence to "
        "best practices. Be specific in your feedback — cite exact lines or patterns. "
        "Distinguish blocking issues from suggestions.",
        None,
    ),
    (
        "security-audit",
        "Security Audit",
        "Security-focused review identifying vulnerabilities and risks.",
        "You are conducting a security audit. Focus on: injection risks, "
        "authentication/authorization flaws, data exposure, dependency vulnerabilities, "
        "and insecure defaults. Rate findings by severity (critical/high/medium/low). "
        "Propose concrete mitigations.",
        None,
    ),
    (
        "architecture",
        "Architecture Discussion",
        "Evaluate design decisions, trade-offs, and system structure.",
        "You are in an architecture discussion. Evaluate design trade-offs, scalability, "
        "maintainability, and separation of concerns. Consider both short-term pragmatism "
        "and long-term extensibility. Present alternatives when disagreeing.",
        None,
    ),
    (
        "brainstorm",
        "Brainstorm",
        "Free-form ideation session. All ideas welcome, defer judgment.",
        "You are in a brainstorming session. Generate diverse ideas without premature "
        "criticism. Build on others' suggestions. Quantity over quality at this stage. "
        "Flag ideas worth deeper exploration.",
        None,
    ),
]


async def _seed_builtin_templates(db: aiosqlite.Connection) -> None:
    """Seed built-in templates if they don't already exist. Idempotent."""
    for tid, name, description, system_prompt, default_metadata in _BUILTIN_TEMPLATES:
        try:
            await db.execute(
                """
                INSERT OR IGNORE INTO thread_templates
                    (id, name, description, system_prompt, default_metadata, created_at, is_builtin)
                VALUES (?, ?, ?, ?, ?, ?, 1)
                """,
                (tid, name, description, system_prompt, default_metadata, _now()),
            )
        except Exception as e:
            logger.warning(f"Failed to seed template '{tid}': {e}")
    await db.commit()
    logger.debug(f"Built-in templates seeded ({len(_BUILTIN_TEMPLATES)} templates).")


async def get_db() -> aiosqlite.Connection:
    """Return the shared async database connection, initializing it if needed."""
    global _db, _initializing
    if _db is None and not _initializing:
        _initializing = True
        try:
            Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
            _db = await aiosqlite.connect(DB_PATH)
            _db.row_factory = aiosqlite.Row
            # WAL mode: allows concurrent reads while writing
            await _db.execute("PRAGMA journal_mode=WAL")
            await _db.execute("PRAGMA foreign_keys=ON")
            await init_schema(_db)
            logger.info(f"Database initialized at {DB_PATH}")
        finally:
            _initializing = False
    return _db


async def close_db() -> None:
    """Gracefully close the database connection."""
    global _db
    if _db is not None:
        await _db.close()
        _db = None
        logger.info("Database connection closed.")


async def init_schema(db: aiosqlite.Connection) -> None:
    """Create all tables if they do not already exist (idempotent)."""
    await db.executescript("""
        -- ----------------------------------------------------------------
        -- Schema version tracking
        -- ----------------------------------------------------------------
        CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
        );
    """)
    await db.commit()
    
    # Check current schema version
    current_version = None
    async with db.execute("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1") as cur:
        row = await cur.fetchone()
        if row:
            current_version = row["version"]
    
    # If version mismatch, warn but allow to continue (for development)
    if current_version is not None and current_version != SCHEMA_VERSION:
        logger.warning(
            f"Schema version mismatch: current={current_version}, expected={SCHEMA_VERSION}. "
            "Consider running migrations or recreating the database."
        )
    
    await db.executescript("""
        -- ----------------------------------------------------------------
        -- Thread: a conversation or task context
        -- ----------------------------------------------------------------
        CREATE TABLE IF NOT EXISTS threads (
            id          TEXT PRIMARY KEY,
            topic       TEXT NOT NULL,
            status      TEXT NOT NULL DEFAULT 'discuss',
            created_at  TEXT NOT NULL,
            updated_at  TEXT,
            closed_at   TEXT,
            summary     TEXT,
            metadata    TEXT,
            system_prompt TEXT
        );

        -- ----------------------------------------------------------------
        -- Message: a single turn within a thread
        -- The bus-wide `seq` is a globally monotonic integer.
        -- ----------------------------------------------------------------
        CREATE TABLE IF NOT EXISTS messages (
            id          TEXT PRIMARY KEY,
            thread_id   TEXT NOT NULL REFERENCES threads(id),
            author      TEXT NOT NULL,
            role        TEXT NOT NULL DEFAULT 'user',
            content     TEXT NOT NULL,
            seq         INTEGER NOT NULL,
            created_at  TEXT NOT NULL,
            metadata    TEXT,
            author_id   TEXT,
            author_name TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_messages_thread_seq
            ON messages(thread_id, seq);

        -- ----------------------------------------------------------------
        -- Reply token lease: mandatory sync token for msg_post in strict mode
        -- ----------------------------------------------------------------
        CREATE TABLE IF NOT EXISTS reply_tokens (
            token       TEXT PRIMARY KEY,
            thread_id   TEXT NOT NULL REFERENCES threads(id),
            agent_id    TEXT,
            issued_at   TEXT NOT NULL,
            expires_at  TEXT NOT NULL,
            consumed_at TEXT,
            status      TEXT NOT NULL CHECK (status IN ('issued', 'consumed', 'expired')),
            source      TEXT NOT NULL DEFAULT 'msg_wait' CHECK (source IN ('bus_connect', 'msg_wait', 'thread_create')),
            fast_returned_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_reply_tokens_thread_status
            ON reply_tokens(thread_id, status);
        CREATE INDEX IF NOT EXISTS idx_reply_tokens_expires_at
            ON reply_tokens(expires_at);

        -- ----------------------------------------------------------------
        -- Sequence counter: single-row table for thread-safe seq increment
        -- ----------------------------------------------------------------
        CREATE TABLE IF NOT EXISTS seq_counter (
            id  INTEGER PRIMARY KEY CHECK (id = 1),
            val INTEGER NOT NULL DEFAULT 0
        );
        INSERT OR IGNORE INTO seq_counter (id, val) VALUES (1, 0);

        -- ----------------------------------------------------------------
        -- Agent registry: tracks connected agents and their heartbeats
        -- ----------------------------------------------------------------
        CREATE TABLE IF NOT EXISTS agents (
            id              TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            ide             TEXT NOT NULL DEFAULT '',
            model           TEXT NOT NULL DEFAULT '',
            description     TEXT,
            capabilities    TEXT,
            registered_at   TEXT NOT NULL,
            last_heartbeat  TEXT NOT NULL,
            token           TEXT NOT NULL,
            display_name    TEXT,
            alias_source    TEXT,
            last_activity   TEXT,
            last_activity_time TEXT
        );

        -- ----------------------------------------------------------------
        -- Events: transient fan-out table for SSE notifications.
        -- Rows are written by mutating ops; the SSE pump reads and deletes them.
        -- ----------------------------------------------------------------
        CREATE TABLE IF NOT EXISTS events (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type  TEXT NOT NULL,
            thread_id   TEXT,
            payload     TEXT NOT NULL,
            created_at  TEXT NOT NULL
        );

        -- ----------------------------------------------------------------
        -- Thread templates: reusable presets for thread creation (UP-18)
        -- is_builtin = 1 for shipped templates, 0 for user-created.
        -- ----------------------------------------------------------------
        CREATE TABLE IF NOT EXISTS thread_templates (
            id               TEXT PRIMARY KEY,
            name             TEXT NOT NULL,
            description      TEXT,
            system_prompt    TEXT,
            default_metadata TEXT,
            created_at       TEXT NOT NULL,
            is_builtin       INTEGER NOT NULL DEFAULT 0
        );

        -- ----------------------------------------------------------------
        -- Thread settings: automation and coordination configuration per thread
        -- ----------------------------------------------------------------
        CREATE TABLE IF NOT EXISTS thread_settings (
            id                          INTEGER PRIMARY KEY AUTOINCREMENT,
            thread_id                   TEXT UNIQUE NOT NULL REFERENCES threads(id),
            auto_administrator_enabled  INTEGER NOT NULL DEFAULT 1,  -- Renamed from auto_coordinator_enabled
            timeout_seconds             INTEGER NOT NULL DEFAULT 60 CHECK (timeout_seconds >= 30),
            last_activity_time          TEXT NOT NULL,
            auto_assigned_admin_id      TEXT,
            auto_assigned_admin_name    TEXT,
            admin_assignment_time       TEXT,
            created_at                  TEXT NOT NULL,
            updated_at                  TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_thread_settings_activity
            ON thread_settings(last_activity_time);

        -- ----------------------------------------------------------------
        -- Thread wait states: cross-process shared msg_wait tracking
        -- ----------------------------------------------------------------
        CREATE TABLE IF NOT EXISTS thread_wait_states (
            thread_id    TEXT NOT NULL REFERENCES threads(id),
            agent_id     TEXT NOT NULL REFERENCES agents(id),
            entered_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL,
            timeout_ms   INTEGER NOT NULL,
            PRIMARY KEY (thread_id, agent_id)
        );

        CREATE INDEX IF NOT EXISTS idx_thread_wait_states_thread
            ON thread_wait_states(thread_id);
        CREATE INDEX IF NOT EXISTS idx_thread_wait_states_updated
            ON thread_wait_states(updated_at);

        -- ----------------------------------------------------------------
        -- Reactions: per-message reactions/annotations from agents (UP-13)
        -- UNIQUE constraint prevents duplicate (message, agent, reaction) triples.
        -- ----------------------------------------------------------------
        CREATE TABLE IF NOT EXISTS reactions (
            id          TEXT PRIMARY KEY,
            message_id  TEXT NOT NULL REFERENCES messages(id),
            agent_id    TEXT,
            agent_name  TEXT,
            reaction    TEXT NOT NULL,
            created_at  TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_reactions_unique
            ON reactions(message_id, agent_id, reaction);
        CREATE INDEX IF NOT EXISTS idx_reactions_message
            ON reactions(message_id);
    """)
    await db.commit()

    # ── Safe migration: add new columns to existing DBs ──────────────────────
    # Migration: Handle duplicate threads.topic before adding UNIQUE INDEX
    # Keep the most recent thread (by created_at) for each topic, delete duplicates
    try:
        async with db.execute("""
            SELECT topic, COUNT(*) as cnt FROM threads 
            GROUP BY topic HAVING cnt > 1
        """) as duplicates:
            dup_rows = await duplicates.fetchall()
        if dup_rows:
            logger.warning(f"Found {len(dup_rows)} topics with duplicates, cleaning up...")
            for row in dup_rows:
                topic = row["topic"]
                # Find the most recent thread ID for this topic
                keep_query = await db.execute(
                    "SELECT id FROM threads WHERE topic = ? ORDER BY created_at DESC LIMIT 1",
                    (topic,)
                )
                keep_row = await keep_query.fetchone()
                if keep_row:
                    keep_id = keep_row["id"]
                    # Delete all OTHER threads with this topic
                    await db.execute(
                        "DELETE FROM threads WHERE topic = ? AND id != ?",
                        (topic, keep_id)
                    )
                    logger.debug(f"Kept thread {keep_id[:8]}... for topic '{topic}', deleted others")
            await db.commit()
            logger.info(f"Cleaned up duplicate topics")
    except Exception as e:
        logger.error(f"Duplicate cleanup check failed (may not have duplicates): {e}")
    
    # Add UNIQUE INDEX on threads.topic to enforce atomic idempotency on concurrent thread_create
    try:
        await db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_topic ON threads(topic)")
        await db.commit()
        logger.info("Migration: added UNIQUE INDEX on 'threads.topic' for idempotency")
    except Exception as e:
        logger.error(f"UNIQUE INDEX on threads.topic may already exist or conflict: {e}")

    # Add index on threads.created_at for efficient keyset pagination (UP-20)
    try:
        await db.execute("CREATE INDEX IF NOT EXISTS idx_threads_created_at ON threads(created_at)")
        await db.commit()
        logger.info("Migration: added INDEX on 'threads.created_at' for cursor pagination")
    except Exception as e:
        logger.error(f"INDEX on threads.created_at failed: {e}")

    for col, typedef in [
        ("ide",   "TEXT NOT NULL DEFAULT ''"),
        ("model", "TEXT NOT NULL DEFAULT ''"),
    ]:
        await _add_column_if_missing(db, "agents", col, typedef)
            
    for col, typedef in [
        ("author_id", "TEXT"),
        ("author_name", "TEXT"),
    ]:
        await _add_column_if_missing(db, "messages", col, typedef)

    for col, typedef in [
        ("system_prompt", "TEXT"),
    ]:
        await _add_column_if_missing(db, "threads", col, typedef)

    # Migration: Add updated_at for thread activity tracking
    try:
        await db.execute("ALTER TABLE threads ADD COLUMN updated_at TEXT")
        await db.commit()
        logger.info("Migration: added column 'threads.updated_at'")
        # Backfill: set updated_at = created_at for existing threads
        await db.execute("UPDATE threads SET updated_at = created_at WHERE updated_at IS NULL")
        await db.commit()
        logger.info("Migration: backfilled updated_at from created_at for existing threads")
    except sqlite3.OperationalError as e:
        if _is_duplicate_column_error(e):
            logger.debug("Migration: 'threads.updated_at' already exists, skipping")
        else:
            logger.error(f"Migration failed for 'threads.updated_at': {e}")
            raise
    except Exception as e:
        logger.error(f"Unexpected migration error for 'threads.updated_at': {e}")
        raise

    # Migration: Add display_name and alias_source for agent alias support
    for col, typedef in [
        ("display_name", "TEXT"),
        ("alias_source", "TEXT CHECK (alias_source IN ('auto', 'user'))"),
    ]:
        await _add_column_if_missing(db, "agents", col, typedef)

    # Migration: Add last_activity and last_activity_time for agent status tracking
    for col, typedef in [
        ("last_activity", "TEXT"),
        ("last_activity_time", "TEXT"),
    ]:
        await _add_column_if_missing(db, "agents", col, typedef)

    # Migration: Add skills for A2A-compatible agent capability declarations (UP-15)
    try:
        await db.execute("ALTER TABLE agents ADD COLUMN skills TEXT")
        await db.commit()
        logger.info("Migration: added column 'agents.skills'")
    except Exception:
        pass  # Column already exists — safe to ignore

    # Migration: Add template_id to threads for template tracking (UP-18)
    try:
        await db.execute("ALTER TABLE threads ADD COLUMN template_id TEXT")
        await db.commit()
        logger.info("Migration: added column 'threads.template_id'")
    except Exception:
        pass  # Column already exists — safe to ignore

    # Migration: Add creator_admin fields to thread_settings for creator-as-admin feature
    for col, typedef in [
        ("creator_admin_id", "TEXT"),
        ("creator_admin_name", "TEXT"),
        ("creator_assignment_time", "TEXT"),
    ]:
        await _add_column_if_missing(db, "thread_settings", col, typedef)

    # Migration: Rebuild thread_settings to relax timeout max cap and bump defaults.
    await _migrate_thread_settings_timeout_constraints(db)

    # Migration: rename thread_settings.auto_coordinator_enabled -> auto_administrator_enabled
    # for existing DBs created before the terminology update.
    has_new_admin_col = await _table_has_column(db, "thread_settings", "auto_administrator_enabled")
    has_legacy_coord_col = await _table_has_column(db, "thread_settings", "auto_coordinator_enabled")
    if not has_new_admin_col and has_legacy_coord_col:
        await _add_column_if_missing(
            db,
            "thread_settings",
            "auto_administrator_enabled",
            "INTEGER NOT NULL DEFAULT 0",
        )
        try:
            await db.execute(
                """
                UPDATE thread_settings
                SET auto_administrator_enabled = auto_coordinator_enabled
                """
            )
            await db.commit()
            logger.info(
                "Migration: copied thread_settings.auto_coordinator_enabled values "
                "to auto_administrator_enabled"
            )
        except Exception as e:
            logger.error(
                "Migration failed while copying auto_coordinator_enabled -> "
                f"auto_administrator_enabled: {e}"
            )
            raise

    # Migration: Add priority column to messages (UP-16)
    await _add_column_if_missing(db, "messages", "priority", "TEXT NOT NULL DEFAULT 'normal'")

    # Migration: Add reply_to_msg_id column to messages (UP-14)
    await _add_column_if_missing(db, "messages", "reply_to_msg_id", "TEXT")
    try:
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages(reply_to_msg_id)"
        )
        await db.commit()
        logger.info("Migration: ensured reply_to_msg_id column + index exist (UP-14)")
    except Exception as e:
        logger.error(f"Migration failed for reply_to_msg_id index: {e}")

    # Migration: Add reply-token source / fast-return state for bus_connect fast-path.
    await _add_column_if_missing(
        db,
        "reply_tokens",
        "source",
        "TEXT NOT NULL DEFAULT 'msg_wait' CHECK (source IN ('bus_connect', 'msg_wait', 'thread_create'))",
    )
    await _add_column_if_missing(db, "reply_tokens", "fast_returned_at", "TEXT")
    try:
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_reply_tokens_agent_thread_source_status "
            "ON reply_tokens(thread_id, agent_id, source, status)"
        )
        await db.commit()
        logger.info("Migration: ensured reply_tokens source/fast-return columns + index exist")
    except Exception as e:
        logger.error(f"Migration failed for reply_tokens source/fast-return index: {e}")

    # Migration: Create reactions table if it does not exist (UP-13)
    # Safe for existing DBs — CREATE TABLE IF NOT EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS
    try:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS reactions (
                id          TEXT PRIMARY KEY,
                message_id  TEXT NOT NULL REFERENCES messages(id),
                agent_id    TEXT,
                agent_name  TEXT,
                reaction    TEXT NOT NULL,
                created_at  TEXT NOT NULL
            )
        """)
        await db.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_reactions_unique ON reactions(message_id, agent_id, reaction)"
        )
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id)"
        )
        await db.commit()
        logger.info("Migration: ensured reactions table + indexes exist (UP-13)")
    except Exception as e:
        logger.error(f"Migration failed for reactions table: {e}")

    # Migration: FTS5 virtual table for full-text search (UI-02)
    # messages_fts mirrors content from `messages` for fast MATCH queries.
    # message_id / thread_id are UNINDEXED: stored for JOINs, not full-text indexed.
    try:
        await db.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                message_id UNINDEXED,
                thread_id  UNINDEXED,
                author     UNINDEXED,
                content
            )
        """)
        await db.commit()
        logger.info("Migration: ensured messages_fts FTS5 virtual table exists (UI-02)")
    except Exception as e:
        logger.error(f"Migration failed for messages_fts FTS5 table: {e}")

    # Migration: INSERT trigger to keep messages_fts in sync with messages (UI-02)
    try:
        await db.execute("""
            CREATE TRIGGER IF NOT EXISTS messages_fts_insert
            AFTER INSERT ON messages
            BEGIN
                INSERT INTO messages_fts(message_id, thread_id, author, content)
                VALUES (NEW.id, NEW.thread_id, NEW.author, NEW.content);
            END
        """)
        await db.commit()
        logger.info("Migration: ensured messages_fts_insert trigger exists (UI-02)")
    except Exception as e:
        logger.error(f"Migration failed for messages_fts_insert trigger: {e}")

    # Migration: Backfill messages_fts for existing messages not yet indexed (UI-02)
    try:
        await db.execute("""
            INSERT INTO messages_fts(message_id, thread_id, author, content)
            SELECT id, thread_id, author, content FROM messages
            WHERE id NOT IN (SELECT message_id FROM messages_fts)
        """)
        await db.commit()
        logger.info("Migration: backfilled messages_fts for existing messages (UI-02)")
    except Exception as e:
        logger.error(f"Migration backfill for messages_fts failed: {e}")

    # Migration: Add edited_at and edit_version columns to messages (UP-21)
    await _add_column_if_missing(db, "messages", "edited_at", "TEXT")
    await _add_column_if_missing(db, "messages", "edit_version", "INTEGER NOT NULL DEFAULT 0")

    # Migration: Create message_edits table for full version history (UP-21)
    # Append-only: each row captures one edit event (old_content before the change).
    try:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS message_edits (
                id          TEXT PRIMARY KEY,
                message_id  TEXT NOT NULL REFERENCES messages(id),
                old_content TEXT NOT NULL,
                edited_by   TEXT NOT NULL,
                version     INTEGER NOT NULL,
                created_at  TEXT NOT NULL
            )
        """)
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_message_edits_msg ON message_edits(message_id, version)"
        )
        await db.commit()
        logger.info("Migration: ensured message_edits table + index exist (UP-21)")
    except Exception as e:
        logger.error(f"Migration failed for message_edits table: {e}")

    # Migration: FTS5 update trigger — keeps messages_fts in sync when content is edited (UP-21)
    # SQLite FTS5 has no UPDATE; pattern is DELETE old row + INSERT new row.
    try:
        await db.execute("""
            CREATE TRIGGER IF NOT EXISTS messages_fts_update
            AFTER UPDATE OF content ON messages
            BEGIN
                DELETE FROM messages_fts WHERE message_id = OLD.id;
                INSERT INTO messages_fts(message_id, thread_id, author, content)
                VALUES (NEW.id, NEW.thread_id, NEW.author, NEW.content);
            END
        """)
        await db.commit()
        logger.info("Migration: ensured messages_fts_update trigger exists (UP-21)")
    except Exception as e:
        logger.error(f"Migration failed for messages_fts_update trigger: {e}")

    # Seed built-in thread templates (UP-18) — idempotent via INSERT OR IGNORE
    await _seed_builtin_templates(db)

    # Record current schema version
    await db.execute(
        "INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)",
        (SCHEMA_VERSION, _now())
    )
    await db.commit()
    
    logger.info(f"Schema initialized (version {SCHEMA_VERSION}).")


async def get_schema_version(db: aiosqlite.Connection) -> int | None:
    """Get the current schema version from the database."""
    try:
        async with db.execute("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1") as cur:
            row = await cur.fetchone()
            return row["version"] if row else None
    except Exception:
        return None


async def verify_schema_consistency(db: aiosqlite.Connection) -> tuple[bool, str]:
    """Verify that the database schema matches the expected version.
    
    Returns:
        (is_consistent, message)
    """
    try:
        current_version = await get_schema_version(db)
        if current_version is None:
            return False, "Schema version table not found"
        if current_version != SCHEMA_VERSION:
            return False, f"Schema version mismatch: expected {SCHEMA_VERSION}, got {current_version}"
        return True, f"Schema version {SCHEMA_VERSION} is consistent"
    except Exception as e:
        return False, f"Error checking schema: {e}"
