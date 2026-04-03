import json

import aiosqlite
import pytest

from agentchatbus.db import crud
from agentchatbus.db.database import init_schema
from agentchatbus.tools.dispatch import handle_msg_wait, handle_msg_list


async def _setup_db() -> aiosqlite.Connection:
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)
    return db


@pytest.mark.asyncio
async def test_msg_wait_no_admin_prompt_when_no_agent_online():
    """Do not emit coordination prompts when there are no online agents."""
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
            },
        )

        payload = json.loads(out[0].text)
        assert "coordination_prompt" not in payload
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_msg_wait_rejects_invalid_explicit_credentials():
    db = await _setup_db()
    try:
        thread = await crud.thread_create(db, "msg-wait-invalid-creds")
        agent = await crud.agent_register(db, ide="VS Code", model="GPT-5.3-Codex")

        out = await handle_msg_wait(
            db,
            {
                "thread_id": thread.id,
                "after_seq": 0,
                "timeout_ms": 1,
                "return_format": "json",
                "agent_id": agent.id,
                "token": "wrong-token",
            },
        )

        payload = json.loads(out[0].text)
        assert payload["error"] == "InvalidCredentials"

        states = await crud.thread_wait_states_grouped(db)
        assert thread.id not in states or agent.id not in states.get(thread.id, {})
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_msg_wait_single_online_agent_has_no_dispatch_coordination_prompt():
    """Coordinator prompts are now produced by the backend coordinator loop, not dispatch.msg_wait."""
    db = await _setup_db()
    try:
        thread = await crud.thread_create(db, "msg-wait-one-online")
        agent = await crud.agent_register(db, ide="VS Code", model="GPT-5.3-Codex")

        out = await handle_msg_wait(
            db,
            {
                "thread_id": thread.id,
                "after_seq": 0,
                "timeout_ms": 50,
                "return_format": "json",
                "agent_id": agent.id,
                "token": agent.token,
            },
        )

        payload = json.loads(out[0].text)
        assert "coordination_prompt" not in payload
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_msg_wait_and_msg_list_project_human_only_system_messages():
    """human_only system notices should reach agents only as placeholder content."""
    db = await _setup_db()
    try:
        thread = await crud.thread_create(db, "msg-wait-human-only")
        agent = await crud.agent_register(db, ide="VS Code", model="GPT-5.3-Codex")

        await crud._msg_create_system(
            db,
            thread.id,
            "Auto Administrator Timeout triggered after 100 seconds.",
            metadata={
                "ui_type": "admin_switch_confirmation_required",
                "visibility": "human_only",
                "private_body": "do not leak this to agents",
            },
            clear_auto_admin=False,
        )

        out = await handle_msg_wait(
            db,
            {
                "thread_id": thread.id,
                "after_seq": 0,
                "timeout_ms": 50,
                "return_format": "json",
                "agent_id": agent.id,
                "token": agent.token,
            },
        )

        payload = json.loads(out[0].text)
        assert len(payload.get("messages") or []) == 1
        assert payload["messages"][0]["content"] == "[human-only content hidden]"
        assert "human_only" in (payload["messages"][0].get("metadata") or "")
        assert "private_body" not in (payload["messages"][0].get("metadata") or "")

        list_out = await handle_msg_list(
            db,
            {
                "thread_id": thread.id,
                "after_seq": 0,
                "limit": 200,
                "include_system_prompt": False,
                "return_format": "json",
            },
        )
        listed = json.loads(list_out[0].text)
        assert [m["content"] for m in listed] == ["[human-only content hidden]"]
        assert all("Auto Administrator Timeout triggered" not in (m.get("content") or "") for m in listed)
        assert all("private_body" not in (m.get("metadata") or "") for m in listed)
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_msg_wait_returns_targeted_takeover_instruction_to_agent():
    """Targeted coordination instructions must stay visible to the intended agent."""
    db = await _setup_db()
    try:
        thread = await crud.thread_create(db, "msg-wait-targeted-takeover")
        agent = await crud.agent_register(db, ide="VS Code", model="GPT-5.3-Codex")

        await crud._msg_create_system(
            db,
            thread.id,
            "Coordinator decision: please take over now.",
            metadata={
                "ui_type": "admin_coordination_takeover_instruction",
                "handoff_target": agent.id,
                "target_admin_id": agent.id,
            },
            clear_auto_admin=False,
        )

        out = await handle_msg_wait(
            db,
            {
                "thread_id": thread.id,
                "after_seq": 0,
                "timeout_ms": 50,
                "return_format": "json",
                "agent_id": agent.id,
                "token": agent.token,
            },
        )

        payload = json.loads(out[0].text)
        assert len(payload.get("messages") or []) == 1
        assert payload["messages"][0]["content"] == "Coordinator decision: please take over now."
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_msg_wait_for_agent_unmatched_message_timeout_clears_wait_state():
    """When for_agent does not match and msg_wait times out, the wait state should be cleared."""
    db = await _setup_db()
    try:
        thread = await crud.thread_create(db, "msg-wait-for-agent-unmatched")
        agent = await crud.agent_register(db, ide="VS Code", model="GPT-5.3-Codex")

        sync = await crud.issue_reply_token(db, thread_id=thread.id, agent_id=agent.id)
        await crud.msg_post(
            db,
            thread_id=thread.id,
            author=agent.id,
            content="message for another agent",
            expected_last_seq=sync["current_seq"],
            reply_token=sync["reply_token"],
            role="assistant",
            metadata={"handoff_target": "someone-else"},
        )

        # A post consumes the agent's reply token. The next msg_wait will be treated
        # as wants_sync_only=True and exit immediately, giving the agent a new token.
        # We perform that sync call here so the subsequent wait functions as a real poll.
        await handle_msg_wait(
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

        out = await handle_msg_wait(
            db,
            {
                "thread_id": thread.id,
                "after_seq": 0,
                "timeout_ms": 20,
                "return_format": "json",
                "agent_id": agent.id,
                "token": agent.token,
                "for_agent": agent.id,
            },
        )

        payload = json.loads(out[0].text)
        assert payload.get("messages") == []

        states = await crud.thread_wait_states_grouped(db)
        assert thread.id not in states or agent.id not in states.get(thread.id, {})
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_msg_wait_timeout_clears_wait_state():
    db = await _setup_db()
    try:
        thread = await crud.thread_create(db, "msg-wait-timeout-clears-state")
        agent = await crud.agent_register(db, ide="VS Code", model="GPT-5.3-Codex")

        out = await handle_msg_wait(
            db,
            {
                "thread_id": thread.id,
                "after_seq": 0,
                "timeout_ms": 20,
                "return_format": "json",
                "agent_id": agent.id,
                "token": agent.token,
            },
        )

        payload = json.loads(out[0].text)
        assert payload.get("messages") == []

        states = await crud.thread_wait_states_grouped(db)
        assert thread.id not in states or agent.id not in states.get(thread.id, {})
    finally:
        await db.close()
