import json
import time
import aiosqlite
import pytest
from mcp import types

from src.db import crud
from src.db.database import init_schema
from src.tools.dispatch import handle_bus_connect, handle_msg_edit, handle_msg_edit_history, handle_msg_get, handle_msg_list, handle_msg_post, handle_msg_search, handle_msg_wait
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
async def test_bus_connect_projects_human_only_message_for_agent_view():
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    thread = await crud.thread_create(db, topic="Existing Topic With Hidden Card")
    await crud._msg_create_system(
        db,
        thread.id,
        "Only humans should read this card.",
        metadata={"visibility": "human_only", "ui_type": "admin_switch_confirmation_required"},
        clear_auto_admin=False,
    )

    result = await handle_bus_connect(
        db,
        {
            "thread_name": "Existing Topic With Hidden Card",
            "ide": "TestIDE",
            "model": "TestModel",
        },
    )
    payload = json.loads(result[0].text)

    assert len(payload["messages"]) == 2
    assert payload["messages"][1]["content"] == "[human-only content hidden]"

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
async def test_bus_connect_does_not_make_next_msg_wait_fast_return():
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

    # First wait after bus_connect should follow normal waiting semantics.
    start = time.perf_counter()
    waited = await handle_msg_wait(
        db,
        {
            "thread_id": thread_id,
            "after_seq": 0,
            "timeout_ms": 120,
            "return_format": "json",
            "agent_id": agent_id,
            "token": agent_token,
        },
    )
    elapsed = time.perf_counter() - start
    wait_payload = json.loads(waited[0].text)
    assert wait_payload["messages"] == []
    assert "reply_token" in wait_payload
    assert "current_seq" in wait_payload
    assert elapsed >= 0.08

    posted2 = await handle_msg_post(
        db,
        {
            "thread_id": thread_id,
            "author": agent_id,
            "content": "first message with msg_wait sync context",
            "expected_last_seq": wait_payload["current_seq"],
            "reply_token": wait_payload["reply_token"],
            "role": "assistant",
        },
    )
    posted_payload2 = json.loads(posted2[0].text)
    assert "msg_id" in posted_payload2
    assert posted_payload2["seq"] == 1

    await db.close()


@pytest.mark.asyncio
async def test_msg_post_error_invalidate_tokens_uses_validated_author_when_no_connection_context():
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    connect_out = await handle_bus_connect(
        db,
        {
            "thread_name": "Author Fallback Invalidates",
            "ide": "VS Code",
            "model": "GPT-5.3-Codex",
        },
    )
    connect_payload = json.loads(connect_out[0].text)
    thread_id = connect_payload["thread"]["thread_id"]
    agent_id = connect_payload["agent"]["agent_id"]
    agent_token = connect_payload["agent"]["token"]

    # Consume initial bus_connect token so agent starts clean.
    await handle_msg_post(
        db,
        {
            "thread_id": thread_id,
            "author": agent_id,
            "content": "seed",
            "expected_last_seq": connect_payload["current_seq"],
            "reply_token": connect_payload["reply_token"],
            "role": "assistant",
        },
    )

    waited = await handle_msg_wait(
        db,
        {
            "thread_id": thread_id,
            "after_seq": 1,
            "timeout_ms": 1,
            "return_format": "json",
            "agent_id": agent_id,
            "token": agent_token,
        },
    )
    wait_payload = json.loads(waited[0].text)

    # Simulate lost connection context.
    src.mcp_server._current_agent_id.set(None)
    src.mcp_server._current_agent_token.set(None)

    # Force seq mismatch using stale expected_last_seq, should trigger token invalidation path.
    err = await handle_msg_post(
        db,
        {
            "thread_id": thread_id,
            "author": agent_id,
            "content": "stale post",
            "expected_last_seq": 0,
            "reply_token": wait_payload["reply_token"],
            "role": "assistant",
        },
    )
    err_payload = json.loads(err[0].text)
    assert err_payload["error"] in {"SeqMismatchError", "ReplyTokenReplayError", "ReplyTokenInvalidError"}

    # After invalidation from a failed post, the next msg_wait should quick-return
    # so the agent can refresh sync context immediately.
    start = time.perf_counter()
    waited2 = await handle_msg_wait(
        db,
        {
            "thread_id": thread_id,
            "after_seq": 1,
            "timeout_ms": 120,
            "return_format": "json",
            "agent_id": agent_id,
            "token": agent_token,
        },
    )
    elapsed = time.perf_counter() - start
    wait_payload2 = json.loads(waited2[0].text)
    assert wait_payload2["messages"] == []
    assert "reply_token" in wait_payload2
    assert elapsed < 0.08

    await db.close()


@pytest.mark.asyncio
async def test_msg_post_seq_mismatch_returns_first_read_messages():
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    thread = await crud.thread_create(db, topic="SeqMismatch Guidance")
    agent = await crud.agent_register(db, ide="VS Code", model="GPT-5.3-Codex")

    sync = await crud.issue_reply_token(db, thread.id, agent.id)
    await crud.msg_post(
        db,
        thread.id,
        author=agent.id,
        content="seed",
        expected_last_seq=sync["current_seq"],
        reply_token=sync["reply_token"],
        role="assistant",
    )

    waited = await handle_msg_wait(
        db,
        {
            "thread_id": thread.id,
            "after_seq": 1,
            "timeout_ms": 1,
            "return_format": "json",
            "agent_id": agent.id,
            "token": agent.token,
        },
    )
    wait_payload = json.loads(waited[0].text)

    await crud._msg_create_system(
        db,
        thread.id,
        "coordinator changed context",
        clear_auto_admin=False,
    )
    await crud._msg_create_system(
        db,
        thread.id,
        "another update",
        clear_auto_admin=False,
    )
    await crud._msg_create_system(
        db,
        thread.id,
        "third update",
        clear_auto_admin=False,
    )
    await crud._msg_create_system(
        db,
        thread.id,
        "fourth update",
        clear_auto_admin=False,
    )
    await crud._msg_create_system(
        db,
        thread.id,
        "fifth update",
        clear_auto_admin=False,
    )
    await crud._msg_create_system(
        db,
        thread.id,
        "human-only hidden update",
        metadata={"visibility": "human_only", "ui_type": "admin_switch_confirmation_required"},
        clear_auto_admin=False,
    )
    await crud._msg_create_system(
        db,
        thread.id,
        "sixth update",
        clear_auto_admin=False,
    )

    err = await handle_msg_post(
        db,
        {
            "thread_id": thread.id,
            "author": agent.id,
            "content": "stale post",
            "expected_last_seq": wait_payload["current_seq"],
            "reply_token": wait_payload["reply_token"],
            "role": "assistant",
        },
    )
    err_payload = json.loads(err[0].text)

    assert err_payload["error"] == "SeqMismatchError"
    assert err_payload["action"] == "READ_MESSAGES_THEN_CALL_MSG_WAIT"
    assert "CRITICAL_REMINDER" in err_payload
    assert len(err_payload["new_messages_1st_read"]) >= 6
    assert any(m["content"] == "[human-only content hidden]" for m in err_payload["new_messages_1st_read"])
    assert all(m["content"] != "human-only hidden update" for m in err_payload["new_messages_1st_read"])

    await db.close()


@pytest.mark.asyncio
async def test_msg_get_projects_human_only_message_for_agent_view():
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    thread = await crud.thread_create(db, topic="MsgGet Hidden Card")
    msg = await crud._msg_create_system(
        db,
        thread.id,
        "Human-only content",
        metadata={"visibility": "human_only", "ui_type": "admin_switch_confirmation_required"},
        clear_auto_admin=False,
    )

    result = await handle_msg_get(db, {"message_id": msg.id})
    payload = json.loads(result[0].text)

    assert payload["found"] is True
    assert payload["message"]["content"] == "[human-only content hidden]"
    assert payload["message"]["metadata"] is not None
    assert "human_only" in payload["message"]["metadata"]

    await db.close()


@pytest.mark.asyncio
async def test_msg_edit_history_projects_human_only_contents_for_agent_view():
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    thread = await crud.thread_create(db, topic="Hidden Edit History")
    agent = await crud.agent_register(db, ide="VS Code", model="GPT-5.3-Codex")
    sync = await crud.issue_reply_token(db, thread.id, agent.id)
    msg = await crud.msg_post(
        db,
        thread.id,
        author=agent.id,
        content="hidden original",
        expected_last_seq=sync["current_seq"],
        reply_token=sync["reply_token"],
        role="assistant",
        metadata={"visibility": "human_only", "ui_type": "admin_switch_confirmation_required"},
    )
    await crud.msg_edit(db, msg.id, "hidden updated", agent.id)

    result = await handle_msg_edit_history(db, {"message_id": msg.id})
    payload = json.loads(result[0].text)

    assert payload["current_content"] == "[human-only content hidden]"
    assert payload["edits"][0]["old_content"] == "[human-only content hidden]"
    assert payload["edits"][0]["edited_by"] == agent.id

    await db.close()


@pytest.mark.asyncio
async def test_msg_search_projects_human_only_snippet_for_agent_view():
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    thread = await crud.thread_create(db, topic="Hidden Search")
    agent = await crud.agent_register(db, ide="VS Code", model="GPT-5.3-Codex")
    sync = await crud.issue_reply_token(db, thread.id, agent.id)
    await crud.msg_post(
        db,
        thread.id,
        author=agent.id,
        content="secret approval token banana",
        expected_last_seq=sync["current_seq"],
        reply_token=sync["reply_token"],
        role="assistant",
        metadata={"visibility": "human_only", "ui_type": "admin_switch_confirmation_required"},
    )

    result = await handle_msg_search(db, {"query": "banana", "thread_id": thread.id, "limit": 10})
    payload = json.loads(result[0].text)

    assert payload["total"] == 1
    assert payload["results"][0]["snippet"] == "[human-only content hidden]"
    assert "banana" not in payload["results"][0]["snippet"]
    assert "metadata" not in payload["results"][0]

    await db.close()


@pytest.mark.asyncio
async def test_msg_edit_requires_authenticated_agent_connection():
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    thread = await crud.thread_create(db, topic="Edit Auth Required")
    agent = await crud.agent_register(db, ide="VS Code", model="GPT-5.3-Codex")
    sync = await crud.issue_reply_token(db, thread.id, agent.id)
    msg = await crud.msg_post(
        db,
        thread.id,
        author=agent.id,
        content="editable",
        expected_last_seq=sync["current_seq"],
        reply_token=sync["reply_token"],
        role="assistant",
    )

    result = await handle_msg_edit(db, {"message_id": msg.id, "new_content": "tampered"})
    payload = json.loads(result[0].text)

    assert payload["error"] == "AUTHENTICATION_REQUIRED"

    unchanged = await crud.msg_get(db, msg.id)
    assert unchanged is not None
    assert unchanged.content == "editable"

    await db.close()


@pytest.mark.asyncio
async def test_msg_edit_uses_agent_id_authorization_for_registered_agent():
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    thread = await crud.thread_create(db, topic="Edit Uses Author ID")
    agent = await crud.agent_register(db, ide="VS Code", model="GPT-5.3-Codex")
    sync = await crud.issue_reply_token(db, thread.id, agent.id)
    msg = await crud.msg_post(
        db,
        thread.id,
        author=agent.id,
        content="editable by owner",
        expected_last_seq=sync["current_seq"],
        reply_token=sync["reply_token"],
        role="assistant",
    )

    src.mcp_server._session_id.set("test-session")
    src.mcp_server.set_connection_agent(agent.id, agent.token)

    result = await handle_msg_edit(db, {"message_id": msg.id, "new_content": "edited by owner"})
    payload = json.loads(result[0].text)

    assert payload["msg_id"] == msg.id

    updated = await crud.msg_get(db, msg.id)
    assert updated is not None
    assert updated.content == "edited by owner"

    await db.close()


@pytest.mark.asyncio
async def test_msg_post_invalid_token_does_not_claim_new_messages_arrived():
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    thread = await crud.thread_create(db, topic="Invalid Token Guidance")

    err = await handle_msg_post(
        db,
        {
            "thread_id": thread.id,
            "author": "human",
            "content": "post with bad token",
            "expected_last_seq": 0,
            "reply_token": "not-a-real-token",
            "role": "user",
        },
    )
    err_payload = json.loads(err[0].text)

    assert err_payload["error"] == "ReplyTokenInvalidError"
    assert err_payload["action"] == "CALL_MSG_WAIT"
    assert "REMINDER" in err_payload
    assert "CRITICAL_REMINDER" not in err_payload
    assert "new_messages_1st_read" not in err_payload

    await db.close()


@pytest.mark.asyncio
async def test_msg_post_success_clears_wait_state_for_author_not_connection_agent():
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    thread = await crud.thread_create(db, topic="Author Owns Success State")
    author_agent = await crud.agent_register(db, ide="VS Code", model="GPT-5.3-Codex")
    other_agent = await crud.agent_register(db, ide="VS Code", model="GPT-5.3-Codex")

    sync = await crud.issue_reply_token(db, thread.id, author_agent.id)
    await crud.thread_wait_enter(db, thread.id, author_agent.id, 300000)
    await crud.thread_wait_enter(db, thread.id, other_agent.id, 300000)

    src.mcp_server._current_agent_id.set(other_agent.id)
    src.mcp_server._current_agent_token.set(other_agent.token)
    src.mcp_server.set_connection_agent(other_agent.id, other_agent.token)

    posted = await handle_msg_post(
        db,
        {
            "thread_id": thread.id,
            "author": author_agent.id,
            "content": "author posts successfully",
            "expected_last_seq": sync["current_seq"],
            "reply_token": sync["reply_token"],
            "role": "assistant",
        },
    )
    posted_payload = json.loads(posted[0].text)
    assert posted_payload["seq"] == 1

    states = await crud.thread_wait_states_grouped(db)
    assert author_agent.id not in states.get(thread.id, {})
    assert other_agent.id in states.get(thread.id, {})

    await db.close()


@pytest.mark.asyncio
async def test_msg_post_failure_refresh_request_follows_author_not_connection_agent():
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    thread = await crud.thread_create(db, topic="Author Owns Failure State")
    author_agent = await crud.agent_register(db, ide="VS Code", model="GPT-5.3-Codex")
    other_agent = await crud.agent_register(db, ide="VS Code", model="GPT-5.3-Codex")

    sync = await crud.issue_reply_token(db, thread.id, author_agent.id)
    await crud.msg_post(
        db,
        thread.id,
        author=author_agent.id,
        content="seed",
        expected_last_seq=sync["current_seq"],
        reply_token=sync["reply_token"],
        role="assistant",
    )

    waited = await handle_msg_wait(
        db,
        {
            "thread_id": thread.id,
            "after_seq": 1,
            "timeout_ms": 1,
            "return_format": "json",
            "agent_id": author_agent.id,
            "token": author_agent.token,
        },
    )
    wait_payload = json.loads(waited[0].text)

    src.mcp_server._current_agent_id.set(other_agent.id)
    src.mcp_server._current_agent_token.set(other_agent.token)
    src.mcp_server.set_connection_agent(other_agent.id, other_agent.token)

    failed = await handle_msg_post(
        db,
        {
            "thread_id": thread.id,
            "author": author_agent.id,
            "content": "stale author post",
            "expected_last_seq": 0,
            "reply_token": wait_payload["reply_token"],
            "role": "assistant",
        },
    )
    failed_payload = json.loads(failed[0].text)
    assert failed_payload["error"] == "SeqMismatchError"

    author_refresh = await crud.msg_wait_refresh_request_get(db, thread.id, author_agent.id)
    other_refresh = await crud.msg_wait_refresh_request_get(db, thread.id, other_agent.id)
    assert author_refresh is not None
    assert other_refresh is None

    await db.close()


@pytest.mark.asyncio
async def test_two_agents_can_chat_multiple_rounds_via_bus_connect_and_msg_wait():
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    thread_name = "Realistic Multi Agent Chat"

    connect_a = await handle_bus_connect(
        db,
        {
            "thread_name": thread_name,
            "ide": "VS Code",
            "model": "GPT-5.3-Codex",
        },
    )
    payload_a = json.loads(connect_a[0].text)
    thread_id = payload_a["thread"]["thread_id"]
    agent_a_id = payload_a["agent"]["agent_id"]
    agent_a_token = payload_a["agent"]["token"]

    post_a1 = await handle_msg_post(
        db,
        {
            "thread_id": thread_id,
            "author": agent_a_id,
            "content": "A1: hello from agent A",
            "expected_last_seq": payload_a["current_seq"],
            "reply_token": payload_a["reply_token"],
            "role": "assistant",
        },
    )
    post_a1_payload = json.loads(post_a1[0].text)
    assert post_a1_payload["seq"] == 1

    connect_b = await handle_bus_connect(
        db,
        {
            "thread_name": thread_name,
            "ide": "VS Code",
            "model": "GPT-5.3-Codex",
        },
    )
    payload_b = json.loads(connect_b[0].text)
    agent_b_id = payload_b["agent"]["agent_id"]
    agent_b_token = payload_b["agent"]["token"]

    assert payload_b["thread"]["thread_id"] == thread_id
    assert any(m.get("content") == "A1: hello from agent A" for m in payload_b["messages"])
    assert payload_b["current_seq"] == 1

    post_b1 = await handle_msg_post(
        db,
        {
            "thread_id": thread_id,
            "author": agent_b_id,
            "content": "B1: hi A, I joined the thread",
            "expected_last_seq": payload_b["current_seq"],
            "reply_token": payload_b["reply_token"],
            "role": "assistant",
        },
    )
    post_b1_payload = json.loads(post_b1[0].text)
    assert post_b1_payload["seq"] == 2

    wait_a1 = await handle_msg_wait(
        db,
        {
            "thread_id": thread_id,
            "after_seq": 1,
            "timeout_ms": 50,
            "return_format": "json",
            "agent_id": agent_a_id,
            "token": agent_a_token,
        },
    )
    wait_a1_payload = json.loads(wait_a1[0].text)
    assert [m["content"] for m in wait_a1_payload["messages"]] == ["B1: hi A, I joined the thread"]
    assert wait_a1_payload["current_seq"] == 2

    post_a2 = await handle_msg_post(
        db,
        {
            "thread_id": thread_id,
            "author": agent_a_id,
            "content": "A2: let's discuss the patch plan",
            "expected_last_seq": wait_a1_payload["current_seq"],
            "reply_token": wait_a1_payload["reply_token"],
            "role": "assistant",
        },
    )
    post_a2_payload = json.loads(post_a2[0].text)
    assert post_a2_payload["seq"] == 3

    wait_b1 = await handle_msg_wait(
        db,
        {
            "thread_id": thread_id,
            "after_seq": 2,
            "timeout_ms": 50,
            "return_format": "json",
            "agent_id": agent_b_id,
            "token": agent_b_token,
        },
    )
    wait_b1_payload = json.loads(wait_b1[0].text)
    assert [m["content"] for m in wait_b1_payload["messages"]] == ["A2: let's discuss the patch plan"]
    assert wait_b1_payload["current_seq"] == 3

    post_b2 = await handle_msg_post(
        db,
        {
            "thread_id": thread_id,
            "author": agent_b_id,
            "content": "B2: agreed, I will handle the tests",
            "expected_last_seq": wait_b1_payload["current_seq"],
            "reply_token": wait_b1_payload["reply_token"],
            "role": "assistant",
        },
    )
    post_b2_payload = json.loads(post_b2[0].text)
    assert post_b2_payload["seq"] == 4

    wait_a2 = await handle_msg_wait(
        db,
        {
            "thread_id": thread_id,
            "after_seq": 3,
            "timeout_ms": 50,
            "return_format": "json",
            "agent_id": agent_a_id,
            "token": agent_a_token,
        },
    )
    wait_a2_payload = json.loads(wait_a2[0].text)
    assert [m["content"] for m in wait_a2_payload["messages"]] == ["B2: agreed, I will handle the tests"]
    assert wait_a2_payload["current_seq"] == 4

    listed = await handle_msg_list(
        db,
        {
            "thread_id": thread_id,
            "after_seq": 0,
            "limit": 20,
            "include_system_prompt": False,
            "return_format": "json",
        },
    )
    listed_payload = json.loads(listed[0].text)

    chat_messages = [m for m in listed_payload if m["role"] == "assistant"]
    assert [m["content"] for m in chat_messages] == [
        "A1: hello from agent A",
        "B1: hi A, I joined the thread",
        "A2: let's discuss the patch plan",
        "B2: agreed, I will handle the tests",
    ]
    assert [m["author_id"] for m in chat_messages] == [
        agent_a_id,
        agent_b_id,
        agent_a_id,
        agent_b_id,
    ]

    await db.close()


@pytest.mark.asyncio
async def test_msg_wait_caught_up_agent_waits_instead_of_fast_returning():
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    thread = await crud.thread_create(db, topic="Caught Up Wait")
    agent = await crud.agent_register(db, ide="VS Code", model="GPT-5.3-Codex")

    sync = await crud.issue_reply_token(db, thread.id, agent.id)
    await crud.msg_post(
        db,
        thread.id,
        author=agent.id,
        content="seed",
        expected_last_seq=sync["current_seq"],
        reply_token=sync["reply_token"],
        role="assistant",
    )

    start = time.perf_counter()
    waited = await handle_msg_wait(
        db,
        {
            "thread_id": thread.id,
            "after_seq": 1,
            "timeout_ms": 120,
            "return_format": "json",
            "agent_id": agent.id,
            "token": agent.token,
        },
    )
    elapsed = time.perf_counter() - start

    payload = json.loads(waited[0].text)
    assert payload["messages"] == []
    assert "reply_token" in payload
    assert elapsed >= 0.08

    await db.close()


@pytest.mark.asyncio
async def test_repeated_msg_wait_timeouts_reuse_single_token():
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    thread = await crud.thread_create(db, topic="Stable Wait Token")
    agent = await crud.agent_register(db, ide="VS Code", model="GPT-5.3-Codex")

    first = await handle_msg_wait(
        db,
        {
            "thread_id": thread.id,
            "after_seq": 0,
            "timeout_ms": 60,
            "return_format": "json",
            "agent_id": agent.id,
            "token": agent.token,
        },
    )
    first_payload = json.loads(first[0].text)

    second = await handle_msg_wait(
        db,
        {
            "thread_id": thread.id,
            "after_seq": 0,
            "timeout_ms": 60,
            "return_format": "json",
            "agent_id": agent.id,
            "token": agent.token,
        },
    )
    second_payload = json.loads(second[0].text)

    assert second_payload["reply_token"] == first_payload["reply_token"]

    async with db.execute(
        "SELECT COUNT(*) AS cnt FROM reply_tokens WHERE thread_id = ? AND agent_id = ? AND status = 'issued'",
        (thread.id, agent.id),
    ) as cur:
        row = await cur.fetchone()
    assert row["cnt"] == 1

    await db.close()


@pytest.mark.asyncio
async def test_bus_connect_with_system_prompt_creates_thread_with_prompt():
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    args = {
        "thread_name": "Thread With Custom Prompt",
        "ide": "TestIDE",
        "model": "TestModel",
        "system_prompt": "You are a code reviewer. Focus on security issues.",
    }

    result = await handle_bus_connect(db, args)
    payload = json.loads(result[0].text)

    assert payload["thread"]["created"] is True

    async with db.execute(
        "SELECT system_prompt FROM threads WHERE id = ?",
        (payload["thread"]["thread_id"],),
    ) as cur:
        row = await cur.fetchone()
    assert row["system_prompt"] == "You are a code reviewer. Focus on security issues."

    await db.close()


@pytest.mark.asyncio
async def test_bus_connect_system_prompt_ignored_when_joining_existing_thread():
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    await crud.thread_create(db, topic="Pre-Existing Thread", system_prompt="Original prompt")

    args = {
        "thread_name": "Pre-Existing Thread",
        "ide": "TestIDE",
        "model": "TestModel",
        "system_prompt": "Attempted override prompt",
    }

    result = await handle_bus_connect(db, args)
    payload = json.loads(result[0].text)

    assert payload["thread"]["created"] is False

    async with db.execute(
        "SELECT system_prompt FROM threads WHERE id = ?",
        (payload["thread"]["thread_id"],),
    ) as cur:
        row = await cur.fetchone()
    assert row["system_prompt"] == "Original prompt"

    await db.close()


@pytest.mark.asyncio
async def test_bus_connect_with_template_applies_template_prompt():
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    await crud.template_create(
        db,
        id="up29-test-template",
        name="UP-29 Test Template",
        system_prompt="You are reviewing code for quality and security.",
    )

    args = {
        "thread_name": "Review Session",
        "ide": "TestIDE",
        "model": "TestModel",
        "template": "up29-test-template",
    }

    result = await handle_bus_connect(db, args)
    payload = json.loads(result[0].text)

    assert payload["thread"]["created"] is True

    async with db.execute(
        "SELECT system_prompt, template_id FROM threads WHERE id = ?",
        (payload["thread"]["thread_id"],),
    ) as cur:
        row = await cur.fetchone()
    assert row["system_prompt"] == "You are reviewing code for quality and security."
    assert row["template_id"] == "up29-test-template"

    await db.close()


@pytest.mark.asyncio
async def test_bus_connect_system_prompt_reflected_in_response():
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    args = {
        "thread_name": "Thread With Prompt In Response",
        "ide": "TestIDE",
        "model": "TestModel",
        "system_prompt": "Review all changes for accessibility compliance.",
    }

    result = await handle_bus_connect(db, args)
    payload = json.loads(result[0].text)

    assert payload["thread"]["created"] is True
    assert payload["thread"]["system_prompt"] == "Review all changes for accessibility compliance."

    # When joining existing thread, system_prompt should NOT be in response
    args2 = {
        "thread_name": "Thread With Prompt In Response",
        "ide": "TestIDE2",
        "model": "TestModel2",
    }

    result2 = await handle_bus_connect(db, args2)
    payload2 = json.loads(result2[0].text)

    assert payload2["thread"]["created"] is False
    assert "system_prompt" not in payload2["thread"]

    await db.close()
