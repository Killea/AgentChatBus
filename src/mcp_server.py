"""
MCP Server for AgentChatBus.

Registers Tools, Resources, and Prompts as defined in the plan.
Mounted onto the FastAPI app via SSE transport.
"""
import json
import asyncio
import logging
import uuid
from contextvars import ContextVar
from typing import Any

import mcp.types as types
from mcp.server import Server
from mcp.server.sse import SseServerTransport

from src.db.database import get_db
from src.db import crud
from src.config import BUS_VERSION, HOST, PORT, MSG_WAIT_TIMEOUT

logger = logging.getLogger(__name__)

# Per-connection language preference.
# Set in `mcp_sse_endpoint` from the ?lang= query parameter.
# Each SSE connection runs in its own asyncio Task, so ContextVar isolates
# concurrent clients: Cursor speaks Chinese while Claude Desktop speaks Japanese.
_session_language: ContextVar[str | None] = ContextVar("session_language", default=None)

# Per-connection session ID (UUID-like identifier for the SSE connection).
# Set in `mcp_sse_endpoint` to uniquely identify each SSE connection.
_session_id: ContextVar[str | None] = ContextVar("session_id", default=None)

def init_session_id() -> str:
    """Initialize a new session ID for this SSE connection."""
    session_id = str(uuid.uuid4())
    _session_id.set(session_id)
    return session_id

# Per-connection agent identity.
# Set when agent registers, heartbeats, or resumes. Used for auto-tracking activity.
_current_agent_id: ContextVar[str | None] = ContextVar("current_agent_id", default=None)
_current_agent_token: ContextVar[str | None] = ContextVar("current_agent_token", default=None)

# Connection-level agent registry.
# Maps session_id → {"agent_id": ..., "token": ...}
# Populated when agent_register/resume is called, used by msg_wait for auto-tracking.
_connection_agents: dict[str, dict[str, str]] = {}

def get_session_id() -> str | None:
    """Get session ID for this SSE connection."""
    return _session_id.get()

def set_connection_agent(agent_id: str, token: str) -> None:
    """Store agent identity for this connection."""
    session_id = get_session_id()
    if not session_id:
        logger.warning("[set_connection_agent] No session ID available, skipping")
        return
    _connection_agents[session_id] = {"agent_id": agent_id, "token": token}
    logger.info(f"[connection_agent] stored for session {session_id[:8]}: agent_id={agent_id}")

def get_connection_agent() -> tuple[str | None, str | None]:
    """Retrieve stored agent identity for this connection."""
    session_id = get_session_id()
    if not session_id:
        return None, None
    agent_info = _connection_agents.get(session_id)
    if agent_info:
        logger.info(f"[get_connection_agent] retrieved from session {session_id[:8]}: agent_id={agent_info['agent_id']}")
        return agent_info["agent_id"], agent_info["token"]
    return None, None

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
                    "status": {"type": "string", "enum": ["discuss", "implement", "review", "done", "closed", "archived"],
                               "description": "Filter by lifecycle state. Omit for all threads."},
                    "include_archived": {
                        "type": "boolean",
                        "default": False,
                        "description": "If true and no status filter is provided, include archived threads.",
                    },
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
                    "mentions":  {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "List of agent IDs to mention in this message."
                    },
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
                    "return_format": {
                        "type": "string",
                        "enum": ["json", "blocks"],
                        "default": "blocks",
                        "description": (
                            "Return format for tool result content. "
                            "'blocks' returns native MCP content blocks (TextContent/ImageContent...). "
                            "'json' returns a single JSON-encoded text payload (legacy)."
                        ),
                    },
                    "include_system_prompt": {
                        "type": "boolean",
                        "default": True,
                        "description": "If true and after_seq=0, prepend a synthetic system prompt row.",
                    },
                },
                "required": ["thread_id"],
            },
        ),
        types.Tool(
            name="msg_wait",
            description=(
                "Block until at least one new message arrives in the thread after `after_seq`. "
                "Returns immediately if messages are already available. "
                "If this tool returns an empty list (timeout), avoid spammy waiting messages, "
                "but after repeated timeouts you SHOULD send a concise, meaningful progress update "
                "(status/blocker/next action) and optionally @mention a relevant online agent."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "thread_id":   {"type": "string"},
                    "after_seq":   {"type": "integer"},
                    "timeout_ms":  {"type": "integer", "default": 300000, "description": "Max wait in milliseconds."},
                    "return_format": {
                        "type": "string",
                        "enum": ["json", "blocks"],
                        "default": "blocks",
                        "description": (
                            "Return format for tool result content. "
                            "'blocks' returns native MCP content blocks (TextContent/ImageContent...). "
                            "'json' returns a single JSON-encoded text payload (legacy)."
                        ),
                    },
                    "agent_id":    {"type": "string", "description": "Optional: your agent ID for activity tracking."},
                    "token":       {"type": "string", "description": "Optional: your agent token for verification."},
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
                "Optional `display_name` can be provided as a human-friendly alias. "
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
                    "display_name": {"type": "string", "description": "Optional human-friendly alias shown in UI and message labels."},
                    "resume_command": {"type": "string", "description": "Optional shell command to execute to resume or auto-wake this agent if offline."},
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
            name="agent_resume",
            description="Resume a previously registered agent session using saved agent_id and token. Preserves all identity fields (name, alias, etc.). Returns agent details with online status. Fails if agent_id not found or token invalid—provide correct credentials and retry.",
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
        types.Tool(
            name="agent_invite",
            description=(
                "Invite a local CLI agent to join a thread. "
                "The agent will be spawned with the configured invoke_command. "
                "This is an explicit, human-driven action (not automatic). "
                "The agent itself manages its session and connection lifecycle."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "agent_name": {
                        "type": "string",
                        "description": "Name of the agent from config (e.g. 'copilot-cli')"
                    },
                    "thread_id": {
                        "type": "string",
                        "description": "UUID of the thread to invite the agent to"
                    },
                },
                "required": ["agent_name", "thread_id"],
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
async def call_tool(name: str, arguments: dict[str, Any]) -> list[types.Content]:
    db = await get_db()

    import importlib
    import sys
    
    # Dynamically reload the dispatch module on every tool call
    if "src.tools.dispatch" in sys.modules:
        importlib.reload(sys.modules["src.tools.dispatch"])
    else:
        import src.tools.dispatch

    return await sys.modules["src.tools.dispatch"].dispatch_tool(db, name, arguments)


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
        resources.append(types.Resource(
            uri=f"chat://threads/{t.id}/state",
            name=f"State: {t.topic[:40]}",
            description=f"Current state snapshot for thread '{t.topic}' (status, latest_seq).",
            mimeType="application/json",
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
        thread_id = uri_str.split("/")[3]  # Fixed: was [2] which was 'threads', should be [3] which is the ID
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
        thread_id = uri_str.split("/")[3]  # Fixed: was [2] which was 'threads', should be [3] which is the ID
        t = await crud.thread_get(db, thread_id)
        if t is None:
            return "Thread not found."
        return t.summary or "(No summary recorded for this thread.)"

    # chat://threads/{id}/state
    if "/state" in uri_str:
        thread_id = uri_str.split("/")[3]
        t = await crud.thread_get(db, thread_id)
        if t is None:
            return "Thread not found."
        latest_seq = await crud.thread_latest_seq(db, thread_id)
        return json.dumps({
            "thread_id": t.id,
            "topic": t.topic,
            "status": t.status,
            "latest_seq": latest_seq,
            "created_at": t.created_at.isoformat(),
        }, indent=2)

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
