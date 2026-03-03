import json

import aiosqlite
import pytest

from src.db import crud
from src.db.database import init_schema
from src.tools.dispatch import handle_msg_wait


async def _setup_db() -> aiosqlite.Connection:
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)
    return db


@pytest.mark.asyncio
async def test_msg_wait_no_admin_prompt_when_no_agent_online():
    """Do not emit admin/coordinator prompts when there are no online agents."""
    db = await _setup_db()
    try:
        thread = await crud.thread_create(db, "msg-wait-no-online")

        out = await handle_msg_wait(
            db,
            {
                "thread_id": thread.id,
                "after_seq": 0,
                "timeout_ms": 1,
                "return_format": "json",
                # Simulate stale/unverified caller identity: not an online registered agent.
                "agent_id": "ghost-agent",
                "token": "ghost-token",
            },
        )

        payload = json.loads(out[0].text)
        assert "coordination_prompt" not in payload
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_msg_wait_single_online_agent_gets_admin_prompt():
    """When the current caller is the only online agent, emit actionable non-admin prompt."""
    db = await _setup_db()
    try:
        thread = await crud.thread_create(db, "msg-wait-one-online")
        agent = await crud.agent_register(db, ide="VS Code", model="GPT-5.3-Codex")

        out = await handle_msg_wait(
            db,
            {
                "thread_id": thread.id,
                "after_seq": 0,
                "timeout_ms": 1,
                "return_format": "json",
                "agent_id": agent.id,
                "token": agent.token,
            },
        )

        payload = json.loads(out[0].text)
        assert "coordination_prompt" in payload
        assert payload["coordination_prompt"]["type"] == "single_agent_timeout_notice"
    finally:
        await db.close()
