import pytest
import aiosqlite

from src.db.database import init_schema
from src.db import crud


@pytest.mark.asyncio
async def test_thread_list_include_archived_filtering_and_archive():
    async with aiosqlite.connect(":memory:") as db:
        db.row_factory = aiosqlite.Row
        await init_schema(db)

        t1 = await crud.thread_create(db, "Thread A")
        t2 = await crud.thread_create(db, "Thread B")

        # Initially, both show up regardless of include_archived
        threads = await crud.thread_list(db, include_archived=False)
        assert {t.id for t in threads} == {t1.id, t2.id}

        threads = await crud.thread_list(db, include_archived=True)
        assert {t.id for t in threads} == {t1.id, t2.id}

        # Archive one thread
        ok = await crud.thread_archive(db, t1.id)
        assert ok is True

        # Explicit status filtering should work
        archived_only = await crud.thread_list(db, status="archived")
        assert [t.id for t in archived_only] == [t1.id]

        # Default listing should exclude archived
        threads = await crud.thread_list(db, include_archived=False)
        assert {t.id for t in threads} == {t2.id}

        # include_archived=True returns both
        threads = await crud.thread_list(db, include_archived=True)
        assert {t.id for t in threads} == {t1.id, t2.id}

        # Ensure state validator accepts 'archived'
        ok = await crud.thread_set_state(db, t2.id, "archived")
        assert ok is True

        # Ensure a thread.archived event exists (thread.state events also exist)
        async with db.execute(
            "SELECT COUNT(*) AS c FROM events WHERE event_type = 'thread.archived' AND thread_id = ?",
            (t1.id,),
        ) as cur:
            row = await cur.fetchone()
        assert row["c"] >= 1
