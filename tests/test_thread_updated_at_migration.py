import aiosqlite
import pytest

from agentchatbus.db import crud
from agentchatbus.db.database import init_schema


@pytest.mark.asyncio
async def test_legacy_schema_migrates_updated_at_and_supports_crud(tmp_path):
    db_path = tmp_path / "legacy_updated_at.db"
    db = await aiosqlite.connect(str(db_path))
    db.row_factory = aiosqlite.Row

    # Simulate an old schema that does not have threads.updated_at.
    await db.executescript(
        """
        CREATE TABLE threads (
            id          TEXT PRIMARY KEY,
            topic       TEXT NOT NULL,
            status      TEXT NOT NULL DEFAULT 'discuss',
            created_at  TEXT NOT NULL,
            closed_at   TEXT,
            summary     TEXT,
            metadata    TEXT,
            system_prompt TEXT
        );

        CREATE TABLE messages (
            id          TEXT PRIMARY KEY,
            thread_id   TEXT NOT NULL REFERENCES threads(id),
            author      TEXT NOT NULL,
            role        TEXT NOT NULL DEFAULT 'user',
            content     TEXT NOT NULL,
            seq         INTEGER NOT NULL,
            created_at  TEXT NOT NULL,
            metadata    TEXT
        );

        CREATE TABLE seq_counter (
            id  INTEGER PRIMARY KEY CHECK (id = 1),
            val INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO seq_counter (id, val) VALUES (1, 0);

        CREATE TABLE agents (
            id              TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            description     TEXT,
            capabilities    TEXT,
            registered_at   TEXT NOT NULL,
            last_heartbeat  TEXT NOT NULL,
            token           TEXT NOT NULL
        );

        CREATE TABLE events (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type  TEXT NOT NULL,
            thread_id   TEXT,
            payload     TEXT NOT NULL,
            created_at  TEXT NOT NULL
        );
        """
    )

    await db.execute(
        "INSERT INTO threads (id, topic, status, created_at) VALUES (?, ?, ?, ?)",
        ("legacy-thread", "legacy-topic", "discuss", "2026-03-01T00:00:00+00:00"),
    )
    await db.commit()

    # Run current schema initializer/migrations on the legacy DB.
    await init_schema(db)

    async with db.execute("PRAGMA table_info(threads)") as cur:
        cols = [row[1] for row in await cur.fetchall()]
    assert "updated_at" in cols

    async with db.execute("SELECT created_at, updated_at FROM threads WHERE id = ?", ("legacy-thread",)) as cur:
        row = await cur.fetchone()
    assert row["updated_at"] == row["created_at"]

    # Confirm CRUD paths that rely on updated_at are safe after migration.
    t = await crud.thread_create(db, "post-migration-topic")
    sync = await crud.issue_reply_token(db, thread_id=t.id)
    await crud.msg_post(
        db,
        thread_id=t.id,
        author="human",
        content="hello",
        expected_last_seq=sync["current_seq"],
        reply_token=sync["reply_token"],
    )
    threads = await crud.thread_list(db)

    assert any(thread.id == t.id and thread.updated_at is not None for thread in threads)

    await db.close()
