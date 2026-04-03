import aiosqlite
import pytest

from agentchatbus.db import crud
from agentchatbus.db.database import init_schema


@pytest.mark.asyncio
async def test_legacy_schema_adds_required_columns_for_current_crud(tmp_path):
    db_path = tmp_path / "legacy_required_columns.db"
    db = await aiosqlite.connect(str(db_path))
    db.row_factory = aiosqlite.Row

    # Simulate a very old schema missing columns that current CRUD references
    # unconditionally (e.g., agents.display_name, messages.author_id).
    await db.executescript(
        """
        CREATE TABLE threads (
            id          TEXT PRIMARY KEY,
            topic       TEXT NOT NULL,
            status      TEXT NOT NULL DEFAULT 'discuss',
            created_at  TEXT NOT NULL,
            closed_at   TEXT,
            summary     TEXT,
            metadata    TEXT
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
    await db.commit()

    # Apply migrations.
    await init_schema(db)

    # Columns that must exist for current CRUD to work.
    async with db.execute("PRAGMA table_info(agents)") as cur:
        agent_cols = {row[1] for row in await cur.fetchall()}
    assert {"ide", "model", "display_name", "alias_source", "last_activity", "last_activity_time"}.issubset(agent_cols)

    async with db.execute("PRAGMA table_info(messages)") as cur:
        msg_cols = {row[1] for row in await cur.fetchall()}
    assert {"author_id", "author_name"}.issubset(msg_cols)

    async with db.execute("PRAGMA table_info(threads)") as cur:
        thread_cols = {row[1] for row in await cur.fetchall()}
    assert {"system_prompt", "updated_at"}.issubset(thread_cols)

    # Exercise the CRUD paths that would have failed without these columns.
    t = await crud.thread_create(db, "legacy-required-columns")
    agent = await crud.agent_register(db, ide="CLI", model="X", display_name="Alpha")
    sync = await crud.issue_reply_token(db, thread_id=t.id, agent_id=agent.id)

    await crud.msg_post(
        db,
        thread_id=t.id,
        author=agent.id,
        content="hello",
        expected_last_seq=sync["current_seq"],
        reply_token=sync["reply_token"],
        role="assistant",
    )

    # This query references agents.display_name; it should not error.
    agents = await crud.agent_list(db)
    assert agents and agents[0].display_name == "Alpha"

    await db.close()
