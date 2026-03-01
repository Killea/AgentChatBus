import aiosqlite
import pytest

from src.db import crud
from src.db.database import init_schema


async def _make_db() -> aiosqlite.Connection:
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)
    return db


@pytest.mark.asyncio
async def test_msg_list_uses_builtin_prompt_when_thread_has_no_custom_prompt():
    db = await _make_db()
    try:
        thread = await crud.thread_create(db, topic="sysprompt-default")

        msgs = await crud.msg_list(
            db,
            thread_id=thread.id,
            after_seq=0,
            limit=10,
            include_system_prompt=True,
        )

        assert msgs, "Expected synthetic system prompt message"
        assert msgs[0].seq == 0
        assert msgs[0].role == "system"
        assert msgs[0].author == "system"
        assert msgs[0].content == crud.GLOBAL_SYSTEM_PROMPT
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_msg_list_appends_thread_prompt_without_overriding_builtin_prompt():
    db = await _make_db()
    custom_prompt = "Creator preference: prioritize concise updates."

    try:
        thread = await crud.thread_create(
            db,
            topic="sysprompt-custom",
            system_prompt=custom_prompt,
        )

        msgs = await crud.msg_list(
            db,
            thread_id=thread.id,
            after_seq=0,
            limit=10,
            include_system_prompt=True,
        )

        assert msgs, "Expected synthetic system prompt message"
        prompt_text = msgs[0].content

        assert "## Section: System (Built-in)" in prompt_text
        assert "## Section: Thread Create (Provided By Creator)" in prompt_text
        assert crud.GLOBAL_SYSTEM_PROMPT in prompt_text
        assert custom_prompt in prompt_text

        # Ensure built-in guidance appears before custom guidance.
        assert prompt_text.find(crud.GLOBAL_SYSTEM_PROMPT) < prompt_text.find(custom_prompt)
    finally:
        await db.close()
