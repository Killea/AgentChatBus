"""
Dynamic tool dispatch layer for AgentChatBus.
This module is hot-reloaded by `mcp_server.py` to allow live updates to tool logic
without dropping connections.
"""
import json
import asyncio
import logging
from typing import Any

import mcp.types as types

from src.db.database import get_db
from src.db import crud
from src.db.crud import RateLimitExceeded
import src.mcp_server
from src.config import BUS_VERSION, HOST, PORT, MSG_WAIT_TIMEOUT

logger = logging.getLogger(__name__)

async def handle_bus_get_config(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    session_lang = src.mcp_server._session_language.get()
    effective_lang = session_lang or "English"
    source = "url_param" if session_lang else "default"
    return [types.TextContent(type="text", text=json.dumps({
        "preferred_language": effective_lang,
        "language_source":    source,
        "language_note": (
            f"Please respond in {effective_lang} whenever possible. "
            "This is a soft preference — use your best judgement."
        ),
        "bus_name": "AgentChatBus",
        "version":  BUS_VERSION,
        "endpoint": f"http://{HOST}:{PORT}",
    }))]

async def handle_thread_create(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    result = await crud.thread_create(db, arguments["topic"], arguments.get("metadata"), arguments.get("system_prompt"))
    return [types.TextContent(type="text", text=json.dumps({
        "thread_id": result.id, "topic": result.topic, "status": result.status, "system_prompt": result.system_prompt,
    }))]

async def handle_thread_list(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    threads = await crud.thread_list(
        db,
        status=arguments.get("status"),
        include_archived=arguments.get("include_archived", False),
    )
    return [types.TextContent(type="text", text=json.dumps([
        {"thread_id": t.id, "topic": t.topic, "status": t.status,
         "created_at": t.created_at.isoformat()} for t in threads
    ]))]

async def handle_thread_get(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    t = await crud.thread_get(db, arguments["thread_id"])
    if t is None:
        return [types.TextContent(type="text", text=json.dumps({"error": "Thread not found"}))]
    return [types.TextContent(type="text", text=json.dumps({
        "thread_id": t.id, "topic": t.topic, "status": t.status,
        "created_at": t.created_at.isoformat(),
        "closed_at": t.closed_at.isoformat() if t.closed_at else None,
        "summary": t.summary,
    }))]

async def handle_msg_post(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    msg = await crud.msg_post(
        db,
        thread_id=arguments["thread_id"],
        author=arguments["author"],
        content=arguments["content"],
        role=arguments.get("role", "user"),
        metadata=arguments.get("metadata"),
    )
    except RateLimitExceeded as e:
        return [types.TextContent(type="text", text=json.dumps({
            "error": "Rate limit exceeded",
            "limit": e.limit,
            "window": e.window,
            "retry_after": e.retry_after,
        }))]
    return [types.TextContent(type="text", text=json.dumps({
        "msg_id": msg.id, "seq": msg.seq,
    }))]

async def handle_msg_list(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    msgs = await crud.msg_list(
        db,
        thread_id=arguments["thread_id"],
        after_seq=arguments.get("after_seq", 0),
        limit=arguments.get("limit", 100),
        include_system_prompt=arguments.get("include_system_prompt", True),
    )
    return [types.TextContent(type="text", text=json.dumps([
        {"msg_id": m.id, "author": m.author, "author_id": m.author_id, "author_name": m.author_name, "role": m.role,
         "content": m.content, "seq": m.seq, "created_at": m.created_at.isoformat()}
        for m in msgs
    ]))]

async def handle_msg_wait(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    thread_id = arguments["thread_id"]
    after_seq = arguments["after_seq"]
    timeout_s = arguments.get("timeout_ms", MSG_WAIT_TIMEOUT * 1000) / 1000.0
    
    explicit_agent_id = arguments.get("agent_id")
    explicit_token = arguments.get("token")
    connection_agent_id, connection_token = src.mcp_server.get_connection_agent()
    
    agent_id = explicit_agent_id or connection_agent_id
    token = explicit_token or connection_token
    
    logger.info(f"[msg_wait] explicit: agent_id={explicit_agent_id}, connection: agent_id={connection_agent_id}, final_agent_id={agent_id}")

    if agent_id and token:
        try:
            result = await crud.agent_msg_wait(db, agent_id, token)
            logger.info(f"[msg_wait] activity recorded: agent_id={agent_id}, result={result}")
        except Exception as e:
            logger.warning(f"[msg_wait] Failed to record activity for {agent_id}: {e}")
    else:
        logger.warning(f"[msg_wait] No credentials available: agent_id={agent_id}, token={'***' if token else None}")

    async def _poll():
        while True:
            msgs = await crud.msg_list(db, thread_id, after_seq=after_seq, include_system_prompt=False)
            if msgs:
                return msgs
            await asyncio.sleep(0.5)

    try:
        msgs = await asyncio.wait_for(_poll(), timeout=timeout_s)
    except asyncio.TimeoutError:
        msgs = []

    return [types.TextContent(type="text", text=json.dumps([
        {"msg_id": m.id, "author": m.author, "author_id": m.author_id, "author_name": m.author_name, "role": m.role,
         "content": m.content, "seq": m.seq, "created_at": m.created_at.isoformat()}
        for m in msgs
    ]))]

async def handle_agent_register(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    agent = await crud.agent_register(
        db,
        ide=arguments["ide"],
        model=arguments["model"],
        description=arguments.get("description", ""),
        capabilities=arguments.get("capabilities"),
        display_name=arguments.get("display_name"),
    )
    src.mcp_server._current_agent_id.set(agent.id)
    src.mcp_server._current_agent_token.set(agent.token)
    src.mcp_server.set_connection_agent(agent.id, agent.token)
    logger.info(f"[agent_register] Set context and connection registry: agent_id={agent.id}")
    return [types.TextContent(type="text", text=json.dumps({
        "agent_id": agent.id,
        "name": agent.name,
        "display_name": agent.display_name,
        "alias_source": agent.alias_source,
        "token": agent.token,
        "last_activity": agent.last_activity,
        "last_activity_time": agent.last_activity_time.isoformat() if agent.last_activity_time else None,
    }))]

async def handle_agent_heartbeat(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    ok = await crud.agent_heartbeat(db, arguments["agent_id"], arguments["token"])
    if ok:
        src.mcp_server._current_agent_id.set(arguments["agent_id"])
        src.mcp_server._current_agent_token.set(arguments["token"])
        src.mcp_server.set_connection_agent(arguments["agent_id"], arguments["token"])
    return [types.TextContent(type="text", text=json.dumps({"ok": ok}))]

async def handle_agent_resume(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    try:
        agent = await crud.agent_resume(db, arguments["agent_id"], arguments["token"])
    except ValueError as e:
        return [types.TextContent(type="text", text=json.dumps({"ok": False, "error": str(e)}))]
    src.mcp_server._current_agent_id.set(agent.id)
    src.mcp_server._current_agent_token.set(agent.token)
    src.mcp_server.set_connection_agent(agent.id, agent.token)
    logger.info(f"[agent_resume] Set context and connection registry for agent_id={agent.id}")
    return [types.TextContent(type="text", text=json.dumps({
        "ok": True,
        "agent_id": agent.id,
        "name": agent.name,
        "display_name": agent.display_name,
        "alias_source": agent.alias_source,
        "is_online": agent.is_online,
        "last_heartbeat": agent.last_heartbeat.isoformat(),
        "last_activity": agent.last_activity,
        "last_activity_time": agent.last_activity_time.isoformat() if agent.last_activity_time else None,
    }))]

async def handle_agent_unregister(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    ok = await crud.agent_unregister(db, arguments["agent_id"], arguments["token"])
    return [types.TextContent(type="text", text=json.dumps({"ok": ok}))]

async def handle_agent_list(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    agents = await crud.agent_list(db)
    return [types.TextContent(type="text", text=json.dumps([
        {"agent_id": a.id, "name": a.name, "ide": a.ide, "model": a.model,
         "display_name": a.display_name, "alias_source": a.alias_source,
         "description": a.description, "is_online": a.is_online,
         "last_heartbeat": a.last_heartbeat.isoformat(),
         "last_activity": a.last_activity,
         "last_activity_time": a.last_activity_time.isoformat() if a.last_activity_time else None}
        for a in agents
    ]))]

async def handle_agent_set_typing(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    db2 = await get_db()
    actual_author = arguments["agent_id"]
    async with db2.execute("SELECT name FROM agents WHERE id = ?", (actual_author,)) as cur:
        row = await cur.fetchone()
        if row:
            actual_author = row["name"]

    await crud._emit_event(db2, "agent.typing", arguments["thread_id"], {
        "agent_id": actual_author,
        "is_typing": arguments["is_typing"],
    })
    return [types.TextContent(type="text", text=json.dumps({"ok": True}))]

TOOLS_DISPATCH = {
    "bus_get_config": handle_bus_get_config,
    "thread_create": handle_thread_create,
    "thread_list": handle_thread_list,
    "thread_get": handle_thread_get,
    "msg_post": handle_msg_post,
    "msg_list": handle_msg_list,
    "msg_wait": handle_msg_wait,
    "agent_register": handle_agent_register,
    "agent_heartbeat": handle_agent_heartbeat,
    "agent_resume": handle_agent_resume,
    "agent_unregister": handle_agent_unregister,
    "agent_list": handle_agent_list,
    "agent_set_typing": handle_agent_set_typing,
}

async def dispatch_tool(db, name: str, arguments: dict[str, Any]) -> list[types.TextContent]:
    handler = TOOLS_DISPATCH.get(name)
    if handler:
        return await handler(db, arguments)
    return [types.TextContent(type="text", text=json.dumps({"error": f"Unknown tool: {name}"}))]
