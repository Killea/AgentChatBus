"""
MCP Server for AgentChatBus.

Registers Tools, Resources, and Prompts as defined in the plan.
Mounted onto the FastAPI app via SSE transport.
"""
import json
import asyncio
import logging
from contextvars import ContextVar
from typing import Any

import mcp.types as types
from mcp.server import Server
from mcp.server.sse import SseServerTransport

from src.db.database import get_db
from src.db import crud
from src.config import BUS_VERSION, HOST, PORT

logger = logging.getLogger(__name__)

# Per-connection language preference.
# Set in `mcp_sse_endpoint` from the ?lang= query parameter.
# Each SSE connection runs in its own asyncio Task, so ContextVar isolates
# concurrent clients: Cursor speaks Chinese while Claude Desktop speaks Japanese.
_session_language: ContextVar[str | None] = ContextVar("session_language", default=None)

# Create the MCP server instance
server = Server("AgentChatBus")


# ═════════════════════════════════════════════
# TOOLS
# ═════════════════════════════════════════════

@server.list_tools()
async def list_tools() -> list[types.Tool]:
    return [
        # ── Thread Management ──────────────────
        types.Tool(
            name="thread_create",
            description="Create a new conversation thread (topic / task context) on the bus.",
            inputSchema={
                "type": "object",
                "properties": {
                    "topic":         {"type": "string", "description": "Short description of the thread's purpose."},
                    "metadata":      {"type": "object", "description": "Optional arbitrary key-value metadata."},
                    "system_prompt": {"type": "string", "description": "Optional system prompt defining collaboration rules for this thread."},
                },
                "required": ["topic"],
            },
        ),
        types.Tool(
            name="thread_list",
            description="List threads, optionally filtered by status.",
            inputSchema={
                "type": "object",
                "properties": {
                    "status": {"type": "string", "enum": ["discuss", "implement", "review", "done", "closed"],
                               "description": "Filter by lifecycle state. Omit for all threads."},
                },
            },
        ),
        types.Tool(
            name="thread_get",
            description="Get details of a single thread by ID.",
            inputSchema={
                "type": "object",
                "properties": {"thread_id": {"type": "string"}},
                "required": ["thread_id"],
            },
        ),
        types.Tool(
            name="thread_set_state",
            description="Advance the thread state machine: discuss → implement → review → done.",
            inputSchema={
                "type": "object",
                "properties": {
                    "thread_id": {"type": "string"},
                    "state":     {"type": "string", "enum": ["discuss", "implement", "review", "done", "closed"]},
                },
                "required": ["thread_id", "state"],
            },
        ),
        types.Tool(
            name="thread_close",
            description="Close a thread and optionally write a final summary for future checkpoint reads.",
            inputSchema={
                "type": "object",
                "properties": {
                    "thread_id": {"type": "string"},
                    "summary":   {"type": "string", "description": "Summary of conclusions reached in this thread."},
                },
                "required": ["thread_id"],
            },
        ),

        # ── Messaging ─────────────────────────
        types.Tool(
            name="msg_post",
            description="Post a message to a thread. Returns the new message ID and global seq number.",
            inputSchema={
                "type": "object",
                "properties": {
                    "thread_id": {"type": "string"},
                    "author":    {"type": "string", "description": "Agent ID, 'system', or 'human'."},
                    "content":   {"type": "string"},
                    "role":      {"type": "string", "enum": ["user", "assistant", "system"], "default": "user"},
                    "metadata":  {"type": "object"},
                },
                "required": ["thread_id", "author", "content"],
            },
        ),
        types.Tool(
            name="msg_list",
            description="Fetch messages in a thread after a given seq cursor.",
            inputSchema={
                "type": "object",
                "properties": {
                    "thread_id": {"type": "string"},
                    "after_seq": {"type": "integer", "default": 0, "description": "Return messages with seq > this value."},
                    "limit":     {"type": "integer", "default": 100},
                },
                "required": ["thread_id"],
            },
        ),
        types.Tool(
            name="msg_wait",
            description=(
                "Block until at least one new message arrives in the thread after `after_seq`. "
                "Returns immediately if messages are already available. "
                "CRITICAL BEHAVIOR: If this tool returns an empty list (timeout), "
                "DO NOT post a message to the thread saying you are 'waiting' or 'polling'. "
                "REMAIN SILENT. Just call this tool again to continue listening."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "thread_id":   {"type": "string"},
                    "after_seq":   {"type": "integer"},
                    "timeout_ms":  {"type": "integer", "default": 30000, "description": "Max wait in milliseconds."},
                },
                "required": ["thread_id", "after_seq"],
            },
        ),

        # ── Agent Identity & Presence ──────────
        types.Tool(
            name="agent_register",
            description=(
                "Register an agent onto the bus. The display name is auto-generated as "
                "'IDE (Model)' — e.g. 'Cursor (GPT-4)'. If the same IDE+Model pair is already "
                "registered, a numeric suffix is appended: 'Cursor (GPT-4) 2'. "
                "Returns agent_id and a secret token for subsequent calls."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "ide":          {"type": "string",
                                     "description": "Name of the IDE or client, e.g. 'Cursor', 'Claude Desktop', 'CLI'."},
                    "model":        {"type": "string",
                                     "description": "Model name, e.g. 'claude-3-5-sonnet-20241022', 'GPT-4'."},
                    "description":  {"type": "string", "description": "Optional short description of this agent's role."},
                    "capabilities": {"type": "array", "items": {"type": "string"},
                                     "description": "List of capability tags, e.g. ['code', 'review']."},
                },
                "required": ["ide", "model"],
            },
        ),
        types.Tool(
            name="agent_heartbeat",
            description="Send a keep-alive ping. Agents that miss the heartbeat window are marked offline.",
            inputSchema={
                "type": "object",
                "properties": {
                    "agent_id": {"type": "string"},
                    "token":    {"type": "string"},
                },
                "required": ["agent_id", "token"],
            },
        ),
        types.Tool(
            name="agent_unregister",
            description="Gracefully deregister an agent from the bus.",
            inputSchema={
                "type": "object",
                "properties": {
                    "agent_id": {"type": "string"},
                    "token":    {"type": "string"},
                },
                "required": ["agent_id", "token"],
            },
        ),
        types.Tool(
            name="agent_list",
            description="List all registered agents and their online status.",
            inputSchema={"type": "object", "properties": {}},
        ),
        types.Tool(
            name="agent_set_typing",
            description="Broadcast an 'is typing' signal for a thread (optional, for UI feedback).",
            inputSchema={
                "type": "object",
                "properties": {
                    "thread_id":  {"type": "string"},
                    "agent_id":   {"type": "string"},
                    "is_typing":  {"type": "boolean"},
                },
                "required": ["thread_id", "agent_id", "is_typing"],
            },
        ),

        # ── Bus config ────────────────────────────
        types.Tool(
            name="bus_get_config",
            description=(
                "Get the bus-level configuration. "
                "Agents SHOULD call this once at startup. "
                "The most important field is `preferred_language`: agents are expected to "
                "try to communicate in that language whenever possible. "
                "This is a SOFT recommendation — no enforcement is done by the server. "
                "If not configured by the operator, defaults to 'English'."
            ),
            inputSchema={"type": "object", "properties": {}},
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[types.TextContent]:
    db = await get_db()

    # ── Bus config tool ─────────────────────────────────────────────────────────

    if name == "bus_get_config":
        # Priority: ?lang= query param (per-connection) > "English"
        session_lang   = _session_language.get()
        effective_lang = session_lang or "English"
        source = "url_param" if session_lang else "default"
        return [types.TextContent(type="text", text=json.dumps({
            "preferred_language": effective_lang,
            "language_source":    source,   # "url_param" | "default"
            "language_note": (
                f"Please respond in {effective_lang} whenever possible. "
                "This is a soft preference — use your best judgement."
            ),
            "bus_name": "AgentChatBus",
            "version":  BUS_VERSION,
            "endpoint": f"http://{HOST}:{PORT}",
        }))]

    # ── Thread tools ───────────────────────────────────────────────────────────

    if name == "thread_create":
        result = await crud.thread_create(db, arguments["topic"], arguments.get("metadata"), arguments.get("system_prompt"))
        return [types.TextContent(type="text", text=json.dumps({
            "thread_id": result.id, "topic": result.topic, "status": result.status, "system_prompt": result.system_prompt,
        }))]

    if name == "thread_list":
        threads = await crud.thread_list(db, status=arguments.get("status"))
        return [types.TextContent(type="text", text=json.dumps([
            {"thread_id": t.id, "topic": t.topic, "status": t.status,
             "created_at": t.created_at.isoformat()} for t in threads
        ]))]

    if name == "thread_get":
        t = await crud.thread_get(db, arguments["thread_id"])
        if t is None:
            return [types.TextContent(type="text", text=json.dumps({"error": "Thread not found"}))]
        return [types.TextContent(type="text", text=json.dumps({
            "thread_id": t.id, "topic": t.topic, "status": t.status,
            "created_at": t.created_at.isoformat(),
            "closed_at": t.closed_at.isoformat() if t.closed_at else None,
            "summary": t.summary,
        }))]

    if name == "thread_set_state":
        await crud.thread_set_state(db, arguments["thread_id"], arguments["state"])
        return [types.TextContent(type="text", text=json.dumps({"ok": True}))]

    if name == "thread_close":
        await crud.thread_close(db, arguments["thread_id"], arguments.get("summary"))
        return [types.TextContent(type="text", text=json.dumps({"ok": True}))]

    # ── Message tools ──────────────────────────────────────────────────────────

    if name == "msg_post":
        msg = await crud.msg_post(
            db,
            thread_id=arguments["thread_id"],
            author=arguments["author"],
            content=arguments["content"],
            role=arguments.get("role", "user"),
            metadata=arguments.get("metadata"),
        )
        return [types.TextContent(type="text", text=json.dumps({
            "msg_id": msg.id, "seq": msg.seq,
        }))]

    if name == "msg_list":
        thread_id = arguments["thread_id"]
        t = await crud.thread_get(db, thread_id)
        sys_prompt = t.system_prompt if t else None
        msgs = await crud.msg_list(
            db,
            thread_id=thread_id,
            after_seq=arguments.get("after_seq", 0),
            limit=arguments.get("limit", 100),
        )
        msg_payload = [
            {"msg_id": m.id, "author": m.author, "author_id": m.author_id, "author_name": m.author_name, "role": m.role,
             "content": m.content, "seq": m.seq, "created_at": m.created_at.isoformat()}
            for m in msgs
        ]
        return_data = {"system_prompt": sys_prompt, "messages": msg_payload} if sys_prompt else msg_payload
        return [types.TextContent(type="text", text=json.dumps(return_data))]

    if name == "msg_wait":
        thread_id = arguments["thread_id"]
        after_seq = arguments["after_seq"]
        timeout_s = arguments.get("timeout_ms", 30000) / 1000.0

        async def _poll():
            while True:
                msgs = await crud.msg_list(db, thread_id, after_seq=after_seq)
                if msgs:
                    return msgs
                await asyncio.sleep(0.5)

        try:
            msgs = await asyncio.wait_for(_poll(), timeout=timeout_s)
        except asyncio.TimeoutError:
            msgs = []

        t = await crud.thread_get(db, thread_id)
        sys_prompt = t.system_prompt if t else None
        msg_payload = [
            {"msg_id": m.id, "author": m.author, "author_id": m.author_id, "author_name": m.author_name, "role": m.role,
             "content": m.content, "seq": m.seq, "created_at": m.created_at.isoformat()}
            for m in msgs
        ]
        return_data = {"system_prompt": sys_prompt, "messages": msg_payload} if sys_prompt else msg_payload
        return [types.TextContent(type="text", text=json.dumps(return_data))]

    # ── Agent tools ────────────────────────────────────────────────────────────

    if name == "agent_register":
        agent = await crud.agent_register(
            db,
            ide=arguments["ide"],
            model=arguments["model"],
            description=arguments.get("description", ""),
            capabilities=arguments.get("capabilities"),
        )
        return [types.TextContent(type="text", text=json.dumps({
            "agent_id": agent.id, "name": agent.name, "token": agent.token,
        }))]

    if name == "agent_heartbeat":
        ok = await crud.agent_heartbeat(db, arguments["agent_id"], arguments["token"])
        return [types.TextContent(type="text", text=json.dumps({"ok": ok}))]

    if name == "agent_unregister":
        ok = await crud.agent_unregister(db, arguments["agent_id"], arguments["token"])
        return [types.TextContent(type="text", text=json.dumps({"ok": ok}))]

    if name == "agent_list":
        agents = await crud.agent_list(db)
        return [types.TextContent(type="text", text=json.dumps([
            {"agent_id": a.id, "name": a.name, "ide": a.ide, "model": a.model,
             "description": a.description, "is_online": a.is_online,
             "last_heartbeat": a.last_heartbeat.isoformat()}
            for a in agents
        ]))]

    if name == "agent_set_typing":
        db2 = await get_db()
        actual_author = arguments["agent_id"]
        async with db2.execute("SELECT name FROM agents WHERE id = ?", (actual_author,)) as cur:
            row = await cur.fetchone()
            if row:
                actual_author = row["name"]

        await crud._emit_event(db2, "agent.typing", arguments["thread_id"], {
            "agent_id": actual_author,   # Overwrite with resolved name for UI
            "is_typing": arguments["is_typing"],
        })
        return [types.TextContent(type="text", text=json.dumps({"ok": True}))]

    return [types.TextContent(type="text", text=json.dumps({"error": f"Unknown tool: {name}"}))]


# ═════════════════════════════════════════════
# RESOURCES
# ═════════════════════════════════════════════

@server.list_resources()
async def list_resources() -> list[types.Resource]:
    db = await get_db()
    threads = await crud.thread_list(db, status=None)
    resources = [
        types.Resource(
            uri="chat://bus/config",
            name="Bus Configuration",
            description=(
                "Bus-level settings including the preferred language. "
                "Agents should read this at startup and try to comply with preferred_language."
            ),
            mimeType="application/json",
        ),
        types.Resource(
            uri="chat://agents/active",
            name="Active Agents",
            description="All currently registered agents and their online status.",
            mimeType="application/json",
        ),
        types.Resource(
            uri="chat://threads/active",
            name="Active Threads",
            description="Summary list of all threads.",
            mimeType="application/json",
        ),
    ]
    for t in threads:
        resources.append(types.Resource(
            uri=f"chat://threads/{t.id}/transcript",
            name=f"Transcript: {t.topic[:40]}",
            description=f"Full conversation history for thread '{t.topic}'",
            mimeType="text/plain",
        ))
        if t.summary:
            resources.append(types.Resource(
                uri=f"chat://threads/{t.id}/summary",
                name=f"Summary: {t.topic[:40]}",
                description=f"Closed-thread summary for '{t.topic}'",
                mimeType="text/plain",
            ))
    return resources


@server.read_resource()
async def read_resource(uri: types.AnyUrl) -> str:
    db = await get_db()
    uri_str = str(uri)

    if uri_str == "chat://bus/config":
        session_lang   = _session_language.get()
        effective_lang = session_lang or "English"
        return json.dumps({
            "preferred_language": effective_lang,
            "language_source":    "url_param" if session_lang else "default",
            "language_note": (
                f"Please respond in {effective_lang} whenever possible. "
                "This is a soft preference — use your best judgement."
            ),
            "bus_name": "AgentChatBus",
            "version":  BUS_VERSION,
            "endpoint": f"http://{HOST}:{PORT}",
        }, indent=2)

    if uri_str == "chat://agents/active":
        agents = await crud.agent_list(db)
        return json.dumps([
            {"agent_id": a.id, "name": a.name, "description": a.description,
             "capabilities": json.loads(a.capabilities) if a.capabilities else [],
             "is_online": a.is_online}
            for a in agents
        ], indent=2)

    if uri_str == "chat://threads/active":
        threads = await crud.thread_list(db)
        return json.dumps([
            {"thread_id": t.id, "topic": t.topic, "status": t.status,
             "created_at": t.created_at.isoformat()}
            for t in threads
        ], indent=2)

    # chat://threads/{id}/transcript
    if "/transcript" in uri_str:
        thread_id = uri_str.split("/")[2]
        t = await crud.thread_get(db, thread_id)
        if t is None:
            return "Thread not found."
        msgs = await crud.msg_list(db, thread_id, after_seq=0, limit=10000)
        lines = [f"# Thread: {t.topic}  [status: {t.status}]\n"]
        for m in msgs:
            lines.append(f"[seq={m.seq}] {m.author} ({m.role}): {m.content}")
        return "\n".join(lines)

    # chat://threads/{id}/summary
    if "/summary" in uri_str:
        thread_id = uri_str.split("/")[2]
        t = await crud.thread_get(db, thread_id)
        if t is None:
            return "Thread not found."
        return t.summary or "(No summary recorded for this thread.)"

    return f"Unknown resource URI: {uri_str}"


# ═════════════════════════════════════════════
# PROMPTS
# ═════════════════════════════════════════════

@server.list_prompts()
async def list_prompts() -> list[types.Prompt]:
    return [
        types.Prompt(
            name="summarize_thread",
            description="Instructs an agent to produce a concise summary of a thread's transcript.",
            arguments=[
                types.PromptArgument(name="topic", description="The thread topic.", required=True),
                types.PromptArgument(name="transcript", description="The full transcript text.", required=True),
            ],
        ),
        types.Prompt(
            name="handoff_to_agent",
            description="Standard format for handing off a task from one agent to another.",
            arguments=[
                types.PromptArgument(name="from_agent", description="Name of the delegating agent.", required=True),
                types.PromptArgument(name="to_agent", description="Name of the receiving agent.", required=True),
                types.PromptArgument(name="task_description", description="What needs to be done.", required=True),
                types.PromptArgument(name="context", description="Relevant background or prior decisions.", required=False),
            ],
        ),
    ]


@server.get_prompt()
async def get_prompt(name: str, arguments: dict[str, str] | None) -> types.GetPromptResult:
    args = arguments or {}

    if name == "summarize_thread":
        return types.GetPromptResult(
            description="Summarize the thread transcript.",
            messages=[types.PromptMessage(
                role="user",
                content=types.TextContent(type="text", text=(
                    f"Please read the following conversation transcript for the topic "
                    f"\"{args.get('topic', '(unknown)')}\" and write a concise summary "
                    f"capturing the key decisions, conclusions, and any open questions.\n\n"
                    f"--- TRANSCRIPT ---\n{args.get('transcript', '')}\n--- END ---"
                )),
            )],
        )

    if name == "handoff_to_agent":
        context_block = f"\n\nRelevant context:\n{args['context']}" if args.get("context") else ""
        return types.GetPromptResult(
            description="Task handoff message.",
            messages=[types.PromptMessage(
                role="user",
                content=types.TextContent(type="text", text=(
                    f"Hi {args.get('to_agent', 'Agent')}, this is {args.get('from_agent', 'Agent')} handing off a task to you.\n\n"
                    f"**Task:** {args.get('task_description', '')}{context_block}\n\n"
                    f"Please acknowledge and proceed."
                )),
            )],
        )

    raise ValueError(f"Unknown prompt: {name}")
