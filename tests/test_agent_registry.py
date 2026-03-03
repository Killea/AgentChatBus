import aiosqlite
import pytest

from src.db import crud
from src.db.database import init_schema
from src.main import _agent_emoji


async def _post_message(db, thread_id: str, author: str, content: str, role: str = "user", metadata: dict | None = None):
    sync = await crud.issue_reply_token(db, thread_id=thread_id)
    return await crud.msg_post(
        db,
        thread_id=thread_id,
        author=author,
        content=content,
        expected_last_seq=sync["current_seq"],
        reply_token=sync["reply_token"],
        role=role,
        metadata=metadata,
    )


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

    await _post_message(db, thread_id=t.id, author=agent.id, content="hello", role="assistant")

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


@pytest.mark.asyncio
async def test_agent_thread_create_updates_activity():
    """RQ-001: thread_create 后 agent last_activity 应更新为 'thread_create'，
    last_heartbeat 也应同时更新（touch_heartbeat=True）"""
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    agent = await crud.agent_register(db, ide="VSCode", model="GPT")
    assert agent.last_activity == "registered"  # 初始状态
    initial_heartbeat = agent.last_heartbeat

    # 模拟 dispatch.handle_thread_create 中的 activity tracking
    await crud._set_agent_activity(db, agent.id, "thread_create", touch_heartbeat=True)

    refreshed = (await crud.agent_list(db))[0]
    assert refreshed.last_activity == "thread_create", "Activity should be updated to 'thread_create'"
    assert refreshed.last_heartbeat is not None, "last_heartbeat should be set"

    await db.close()


def test_agent_emoji_mapping_is_deterministic_and_normalized():
    agent_id = "AbC-123"
    emoji1 = _agent_emoji(agent_id)
    emoji2 = _agent_emoji(agent_id)
    assert emoji1 == emoji2
    assert emoji1 == _agent_emoji("  abc-123  ")
