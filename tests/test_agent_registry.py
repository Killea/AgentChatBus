import aiosqlite
import pytest

from src.db import crud
from src.db.database import init_schema


@pytest.mark.asyncio
async def test_agent_register_supports_display_name_and_resume_updates_activity():
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    agent = await crud.agent_register(
        db,
        ide="Cursor",
        model="GPT-4",
        description="worker",
        capabilities=["code"],
        display_name="Alpha",
    )

    assert agent.display_name == "Alpha"
    assert agent.alias_source == "user"
    assert agent.last_activity == "registered"
    assert agent.last_activity_time is not None

    resumed = await crud.agent_resume(db, agent.id, agent.token)
    assert resumed.id == agent.id
    assert resumed.display_name == "Alpha"
    assert resumed.last_activity == "resume"
    assert resumed.last_activity_time is not None

    await db.close()


@pytest.mark.asyncio
async def test_agent_wait_and_post_activity_tracking():
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    t = await crud.thread_create(db, "activity-test")
    agent = await crud.agent_register(db, ide="VSCode", model="GPT", display_name=None)

    ok_wait = await crud.agent_msg_wait(db, agent.id, agent.token)
    assert ok_wait is True

    refreshed = (await crud.agent_list(db))[0]
    assert refreshed.last_activity == "msg_wait"

    await crud.msg_post(
        db,
        thread_id=t.id,
        author=agent.id,
        content="hello",
        role="assistant",
    )

    refreshed2 = (await crud.agent_list(db))[0]
    assert refreshed2.last_activity == "msg_post"

    await db.close()


@pytest.mark.asyncio
async def test_agent_resume_rejects_bad_token():
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    agent = await crud.agent_register(db, ide="CLI", model="X")

    with pytest.raises(ValueError):
        await crud.agent_resume(db, agent.id, "bad-token")

    await db.close()
