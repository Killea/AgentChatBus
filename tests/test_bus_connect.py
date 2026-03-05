import json
import aiosqlite
import pytest
from mcp import types

from src.db import crud
from src.db.database import init_schema
from src.tools.dispatch import handle_bus_connect, handle_msg_post, handle_msg_wait
import src.mcp_server

@pytest.fixture(autouse=True)
def isolated_mcp_context():
    """Ensure MCP connection context is clean for each test."""
    src.mcp_server._session_id.set("test-session")
    src.mcp_server._current_agent_id.set(None)
    src.mcp_server._current_agent_token.set(None)
    src.mcp_server._connection_agents.clear()
    yield

@pytest.mark.asyncio
async def test_bus_connect_new_agent_new_thread():
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    args = {
        "thread_name": "Test Auto Create",
        "ide": "TestIDE",
        "model": "TestModel"
    }

    result = await handle_bus_connect(db, args)
    assert len(result) == 1
    
    payload = json.loads(result[0].text)
    
    # Check agent
    assert payload["agent"]["registered"] is True
    assert "agent_id" in payload["agent"]
    assert "token" in payload["agent"]
    assert payload["agent"]["name"].startswith("TestIDE")

    # Check thread
    assert payload["thread"]["topic"] == "Test Auto Create"
    assert payload["thread"]["created"] is True
    assert payload["thread"]["status"] == "discuss"

    # Check messages and sync context
    assert len(payload["messages"]) == 1  # System prompt is injected synthetically
    assert payload["current_seq"] == 0
    assert "reply_token" in payload
    assert "reply_window" in payload

    await db.close()

@pytest.mark.asyncio
async def test_bus_connect_new_agent_existing_thread():
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    # Pre-create thread via generic crud
    t = await crud.thread_create(db, topic="Existing Topic")
    
    # Wait, need an agent to issue reply token and post msg
    agent0 = await crud.agent_register(db, "System", "0")
    sync = await crud.issue_reply_token(db, t.id, agent0.id)
    await crud.msg_post(
        db, t.id, author=agent0.id, content="First message",
        expected_last_seq=sync["current_seq"], reply_token=sync["reply_token"]
    )

    args = {
        "thread_name": "Existing Topic",
        "ide": "TestIDE",
        "model": "TestModel"
    }

    result = await handle_bus_connect(db, args)
    payload = json.loads(result[0].text)
    
    assert payload["agent"]["registered"] is True
    assert payload["thread"]["created"] is False
    assert payload["thread"]["topic"] == "Existing Topic"
    assert len(payload["messages"]) == 2  # System prompt + First message
    assert payload["messages"][1]["content"] == "First message"
    assert payload["current_seq"] == 1
    assert "reply_token" in payload
    assert "reply_window" in payload

    await db.close()

@pytest.mark.asyncio
async def test_bus_connect_no_reuse_agent():
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    # First call: registers an agent and sets context
    args1 = {"thread_name": "Thread1", "ide": "IDE1", "model": "Mod1"}
    r1 = await handle_bus_connect(db, args1)
    p1 = json.loads(r1[0].text)
    assert p1["agent"]["registered"] is True
    agent_id1 = p1["agent"]["agent_id"]

    # Second call (same connection/session): joins another thread without explicitly providing agent_id
    args2 = {"thread_name": "Thread2"}
    r2 = await handle_bus_connect(db, args2)
    p2 = json.loads(r2[0].text)
    
    # Should NOT reuse the same agent, must register a new one
    assert p2["agent"]["registered"] is True
    assert p2["agent"]["agent_id"] != agent_id1
    assert p2["thread"]["topic"] == "Thread2"
    assert p2["thread"]["created"] is True

    await db.close()


@pytest.mark.asyncio
async def test_bus_connect_requires_msg_wait_before_first_msg_post():
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    connect_out = await handle_bus_connect(
        db,
        {
            "thread_name": "Fixed Flow Thread",
            "ide": "VS Code",
            "model": "GPT-5.3-Codex",
        },
    )
    connect_payload = json.loads(connect_out[0].text)
    thread_id = connect_payload["thread"]["thread_id"]
    agent_id = connect_payload["agent"]["agent_id"]
    agent_token = connect_payload["agent"]["token"]

    # Bus-connect now issues sync fields directly, so first post can succeed.
    posted = await handle_msg_post(
        db,
        {
            "thread_id": thread_id,
            "author": agent_id,
            "content": "first message with bus_connect sync context",
            "expected_last_seq": connect_payload["current_seq"],
            "reply_token": connect_payload["reply_token"],
            "role": "assistant",
        },
    )
    posted_payload = json.loads(posted[0].text)
    assert "msg_id" in posted_payload
    assert posted_payload["seq"] == 1

    await db.close()


@pytest.mark.asyncio
async def test_bus_connect_token_makes_next_msg_wait_immediate_once():
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    connect_out = await handle_bus_connect(
        db,
        {
            "thread_name": "Fast Return Once",
            "ide": "VS Code",
            "model": "GPT-5.3-Codex",
        },
    )
    connect_payload = json.loads(connect_out[0].text)
    thread_id = connect_payload["thread"]["thread_id"]
    agent_id = connect_payload["agent"]["agent_id"]
    agent_token = connect_payload["agent"]["token"]

    # First wait should fast-return due to pending bus_connect token.
    waited = await handle_msg_wait(
        db,
        {
            "thread_id": thread_id,
            "after_seq": 0,
            "timeout_ms": 1,
            "return_format": "json",
            "agent_id": agent_id,
            "token": agent_token,
        },
    )
    wait_payload = json.loads(waited[0].text)
    assert "reply_token" in wait_payload
    assert "current_seq" in wait_payload

    # The same pending bus_connect token should only fast-return once.
    # Second wait should follow timeout behavior (still returns sync envelope).
    waited2 = await handle_msg_wait(
        db,
        {
            "thread_id": thread_id,
            "after_seq": 0,
            "timeout_ms": 10,
            "return_format": "json",
            "agent_id": agent_id,
            "token": agent_token,
        },
    )
    wait_payload2 = json.loads(waited2[0].text)
    assert wait_payload2["messages"] == []
    assert "reply_token" in wait_payload2

    posted2 = await handle_msg_post(
        db,
        {
            "thread_id": thread_id,
            "author": agent_id,
            "content": "first message with msg_wait sync context",
            "expected_last_seq": wait_payload2["current_seq"],
            "reply_token": wait_payload2["reply_token"],
            "role": "assistant",
        },
    )
    posted_payload2 = json.loads(posted2[0].text)
    assert "msg_id" in posted_payload2
    assert posted_payload2["seq"] == 1

    await db.close()
