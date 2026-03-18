import asyncio
import json
import time

import aiosqlite
import pytest

import src.mcp_server
from src.db import crud
from src.db.database import init_schema
from src.tools import dispatch
from src.tools.dispatch import handle_bus_connect, handle_msg_post, handle_msg_wait


@pytest.fixture(autouse=True)
def isolated_mcp_context():
    src.mcp_server._session_id.set("test-session")
    src.mcp_server._current_agent_id.set(None)
    src.mcp_server._current_agent_token.set(None)
    src.mcp_server._connection_agents.clear()
    yield


def _parse_payload(result):
    assert len(result) == 1
    return json.loads(result[0].text)


@pytest.mark.asyncio
async def test_msg_wait_min_timeout_ab_scenario_ts_port(monkeypatch):
    """
    Ported from the TS backend integration scenario:
    - Agent A requests msg_wait(timeout_ms=100)
    - Minimum wait policy is active (simulated as 600ms in test)
    - Agent B posts around 400ms later
    - Agent A returns naturally with B's message (no premature timeout)
    """
    monkeypatch.setattr(dispatch, "MSG_WAIT_MIN_TIMEOUT_MS", 600, raising=False)

    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    connect_a = _parse_payload(
        await handle_bus_connect(
            db,
            {
                "thread_name": "ab-min-wait-scenario-py",
                "ide": "VSCode",
                "model": "Agent-A",
            },
        )
    )
    connect_b = _parse_payload(
        await handle_bus_connect(
            db,
            {
                "thread_name": "ab-min-wait-scenario-py",
                "ide": "VSCode",
                "model": "Agent-B",
            },
        )
    )

    thread_id = connect_a["thread"]["thread_id"]

    start = time.perf_counter()
    wait_task = asyncio.create_task(
        handle_msg_wait(
            db,
            {
                "thread_id": thread_id,
                "after_seq": connect_a["current_seq"],
                    "agent_id": connect_a["agent"]["agent_id"],
                    "token": connect_a["agent"]["token"],
                    "timeout_ms": 100,
                    "return_format": "json",
                },
            )
        )

    # Ensure Agent A has entered wait-state before posting from Agent B.
    for _ in range(20):
        grouped = await crud.thread_wait_states_grouped(db)
        waiters = grouped.get(thread_id, {})
        if connect_a["agent"]["agent_id"] in waiters:
            break
        await asyncio.sleep(0.002)

    await asyncio.sleep(0.4)

    post_payload = _parse_payload(
        await handle_msg_post(
            db,
            {
                "thread_id": thread_id,
                "author": connect_b["agent"]["agent_id"],
                "content": "message from agent b after 40ms",
                "expected_last_seq": connect_b["current_seq"],
                "reply_token": connect_b["reply_token"],
            },
        )
    )
    assert isinstance(post_payload.get("msg_id"), str)
    assert isinstance(post_payload.get("seq"), int)

    wait_payload = _parse_payload(await wait_task)
    elapsed_ms = (time.perf_counter() - start) * 1000

    assert isinstance(wait_payload.get("messages"), list)
    assert len(wait_payload["messages"]) > 0
    assert "agent b" in (wait_payload["messages"][0].get("content") or "").lower()
    assert elapsed_ms >= 300

    await db.close()


@pytest.mark.asyncio
async def test_msg_wait_min_timeout_keeps_fast_return_ts_port(monkeypatch):
    """
    Ported from the TS backend quick-return check:
    even with minimum wait enabled, recovery/behind fast-return path must not be stretched.
    """
    monkeypatch.setattr(dispatch, "MSG_WAIT_MIN_TIMEOUT_MS", 600, raising=False)

    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)

    wait_agent = await crud.agent_register(db, "VSCode", "Wait-Agent")
    thread = await crud.thread_create(db, topic="behind-fast-return-py")

    sync = await crud.issue_reply_token(db, thread.id, None)
    await crud.msg_post(
        db,
        thread.id,
        author="human",
        content="seed message",
        expected_last_seq=sync["current_seq"],
        reply_token=sync["reply_token"],
    )
    seeded = await crud.msg_list(db, thread.id, after_seq=0, include_system_prompt=False)
    assert len(seeded) > 0

    start = time.perf_counter()
    wait_payload = _parse_payload(
        await handle_msg_wait(
            db,
            {
                "thread_id": thread.id,
                    "after_seq": 0,
                    "agent_id": wait_agent.id,
                    "token": wait_agent.token,
                    "timeout_ms": 100,
                    "return_format": "json",
                },
            )
        )
    elapsed_ms = (time.perf_counter() - start) * 1000

    assert isinstance(wait_payload.get("messages"), list)
    assert len(wait_payload["messages"]) > 0
    assert elapsed_ms < 600

    await db.close()
