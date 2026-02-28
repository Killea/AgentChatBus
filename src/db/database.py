"""
SQLite database connection management and schema initialization.
Uses aiosqlite for fully async, non-blocking access.
"""
import aiosqlite
import asyncio
import logging
from pathlib import Path
from typing import AsyncIterator
from contextlib import asynccontextmanager

from src.config import DB_PATH

logger = logging.getLogger(__name__)

# Module-level connection pool (single shared connection with WAL mode)
_db: aiosqlite.Connection | None = None
_lock = asyncio.Lock()


async def get_db() -> aiosqlite.Connection:
    """Return the shared async database connection, initializing it if needed."""
    global _db
    if _db is None:
        async with _lock:
            if _db is None:
                Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
                _db = await aiosqlite.connect(DB_PATH)
                _db.row_factory = aiosqlite.Row
                # WAL mode: allows concurrent reads while writing
                await _db.execute("PRAGMA journal_mode=WAL")
                await _db.execute("PRAGMA foreign_keys=ON")
                await init_schema(_db)
                logger.info(f"Database initialized at {DB_PATH}")
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
        -- Thread: a conversation or task context
        -- ----------------------------------------------------------------
        CREATE TABLE IF NOT EXISTS threads (
            id          TEXT PRIMARY KEY,
            topic       TEXT NOT NULL,
            status      TEXT NOT NULL DEFAULT 'discuss',
            created_at  TEXT NOT NULL,
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
        
    for col, typedef in [
        ("ide",   "TEXT NOT NULL DEFAULT ''"),
        ("model", "TEXT NOT NULL DEFAULT ''"),
    ]:
        try:
            await db.execute(f"ALTER TABLE agents ADD COLUMN {col} {typedef}")
            await db.commit()
            logger.info(f"Migration: added column 'agents.{col}'")
        except Exception:
            pass  # Column already exists — safe to ignore
            
    for col, typedef in [
        ("author_id", "TEXT"),
        ("author_name", "TEXT"),
    ]:
        try:
            await db.execute(f"ALTER TABLE messages ADD COLUMN {col} {typedef}")
            await db.commit()
            logger.info(f"Migration: added column 'messages.{col}'")
        except Exception:
            pass

    for col, typedef in [
        ("system_prompt", "TEXT"),
    ]:
        try:
            await db.execute(f"ALTER TABLE threads ADD COLUMN {col} {typedef}")
            await db.commit()
            logger.info(f"Migration: added column 'threads.{col}'")
        except Exception:
            pass

    # Migration: Add display_name and alias_source for agent alias support
    for col, typedef in [
        ("display_name", "TEXT"),
        ("alias_source", "TEXT CHECK (alias_source IN ('auto', 'user'))"),
    ]:
        try:
            await db.execute(f"ALTER TABLE agents ADD COLUMN {col} {typedef}")
            await db.commit()
            logger.info(f"Migration: added column 'agents.{col}'")
        except Exception:
            pass

    # Migration: Add last_activity and last_activity_time for agent status tracking
    for col, typedef in [
        ("last_activity", "TEXT"),
        ("last_activity_time", "TEXT"),
    ]:
        try:
            await db.execute(f"ALTER TABLE agents ADD COLUMN {col} {typedef}")
            await db.commit()
            logger.info(f"Migration: added column 'agents.{col}'")
        except Exception:
            pass

    logger.info("Schema initialized.")
