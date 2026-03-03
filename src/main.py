"""
AgentChatBus main entry point.

Starts a FastAPI HTTP server that:
  1. Mounts the MCP Server (SSE + JSON-RPC) at /mcp
  2. Serves a lightweight web console at /  (static HTML)
  3. Provides a simple SSE broadcast endpoint at /events for the web console
"""
import asyncio
import json
import logging
import os
import time
import uuid
import random
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

import uvicorn
from fastapi import FastAPI, Request, HTTPException, Header
from starlette.responses import Response
from fastapi.responses import HTMLResponse, StreamingResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict
from mcp.server.sse import SseServerTransport
from starlette.routing import Mount

from src.config import HOST, PORT, get_config_dict, save_config_dict, ADMIN_TOKEN
from src.db.database import get_db, close_db, SCHEMA_VERSION
from src.db import crud
from src.db.crud import (
    RateLimitExceeded,
    MissingSyncFieldsError,
    SeqMismatchError,
    ReplyTokenInvalidError,
    ReplyTokenExpiredError,
    ReplyTokenReplayError,
    MessageNotFoundError,
)
from src.config import THREAD_TIMEOUT_ENABLED, THREAD_TIMEOUT_MINUTES, THREAD_TIMEOUT_SWEEP_INTERVAL, RELOAD_ENABLED
from src.mcp_server import server as mcp_server, _session_language
from src.content_filter import ContentFilterError
from src.thread_creation_service import (
    create_thread_with_verified_creator,
    CreatorAuthError,
    CreatorNotFoundError,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("agentchatbus")

# ── Agent msg_wait State Tracking ─────────────────────────────────────────
# Tracks when each agent enters msg_wait state for each thread.
# Used to detect when all agents in a thread are waiting (coordination timeout).
# Structure: {thread_id: {agent_id: {"entered_at": datetime, "timeout_ms": int}}}
_thread_agent_wait_states: dict[str, dict[str, dict]] = {}

def agent_enter_wait(thread_id: str, agent_id: str, timeout_ms: int = 300000) -> None:
    """Record that an agent has entered msg_wait state for a thread."""
    if thread_id not in _thread_agent_wait_states:
        _thread_agent_wait_states[thread_id] = {}
    _thread_agent_wait_states[thread_id][agent_id] = {
        "entered_at": datetime.now(timezone.utc),
        "timeout_ms": timeout_ms,
    }
    logger.debug(f"[agent_enter_wait] agent_id={agent_id} entered wait for thread={thread_id}")

def agent_exit_wait(thread_id: str, agent_id: str) -> None:
    """Remove agent from wait state (e.g., when they post a message)."""
    if thread_id in _thread_agent_wait_states:
        _thread_agent_wait_states[thread_id].pop(agent_id, None)
        if not _thread_agent_wait_states[thread_id]:
            del _thread_agent_wait_states[thread_id]
        logger.debug(f"[agent_exit_wait] agent_id={agent_id} exited wait for thread={thread_id}")

def get_thread_wait_state(thread_id: str) -> dict[str, dict]:
    """Get all agents currently in msg_wait state for a thread."""
    return _thread_agent_wait_states.get(thread_id, {})

def clear_thread_wait_state(thread_id: str) -> None:
    """Clear all wait states for a thread (e.g., after admin notification)."""
    _thread_agent_wait_states.pop(thread_id, None)


_ADMIN_EMOJIS = ["🤖", "🛠️", "🧠", "📡", "🧭", "⚙️"]


def _agent_emoji(agent_id: str | None) -> str:
    if not agent_id:
        return "❔"
    idx = abs(hash(agent_id)) % len(_ADMIN_EMOJIS)
    return _ADMIN_EMOJIS[idx]


def _agent_label(agent: object | None, fallback_id: str | None = None) -> str:
    if agent is None:
        return fallback_id or "Unknown"
    display_name = getattr(agent, "display_name", None)
    name = getattr(agent, "name", None)
    agent_id = getattr(agent, "id", None)
    return str(display_name or name or agent_id or fallback_id or "Unknown")

STATIC_DIR = Path(__file__).resolve().parent / "static"

# Database operation timeout (seconds)
# Support environment variable override via AGENTCHATBUS_DB_TIMEOUT
DB_TIMEOUT = int(os.getenv("AGENTCHATBUS_DB_TIMEOUT", "5"))

# Server start time — set in lifespan(), used by /api/metrics (UP-22)
_start_time: datetime | None = None


async def _cleanup_events_loop():
    """Periodically completely prune old delivery events since they are transient."""
    while True:
        try:
            db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
            # Prune events older than 10 mins (600s)
            await asyncio.wait_for(crud.events_delete_old(db, max_age_seconds=600), timeout=DB_TIMEOUT)
        except asyncio.TimeoutError:
            logger.error("Event cleanup timeout: database operation took too long")
        except Exception as e:
            logger.error(f"Event cleanup failed: {e}")
        await asyncio.sleep(60)

async def _thread_timeout_loop() -> None:
    """Background task: periodically close inactive threads."""
    logger.info(f"Thread timeout sweep enabled: {THREAD_TIMEOUT_MINUTES}min inactivity threshold, sweep every {THREAD_TIMEOUT_SWEEP_INTERVAL}s")
    while True:
        try:
            await asyncio.sleep(THREAD_TIMEOUT_SWEEP_INTERVAL)
            db = await get_db()
            closed = await crud.thread_timeout_sweep(db, THREAD_TIMEOUT_MINUTES)
            if closed:
                logger.info(f"Timeout sweep: closed {len(closed)} thread(s): {closed}")
        except asyncio.CancelledError:
            break
        except Exception as exc:
            logger.warning(f"Thread timeout sweep error: {exc}")


async def _admin_coordinator_loop() -> None:
    """Background task: check for msg_wait coordination timeouts and notify/assign admins.
    
    New logic (2026-03-02):
    - Detect when all online agents in a thread are in msg_wait state for >= 60 seconds
    - Notify the administrator to coordinate
    - If no administrator exists, randomly assign one from online agents
    - If only one agent remains, include "other agents offline" notice
    """
    logger.info("Admin coordinator loop enabled: checking for msg_wait coordination timeouts every 10s")
    while True:
        try:
            await asyncio.sleep(10)
            db = await get_db()
            
            # Get all agents for online status check
            all_agents = await asyncio.wait_for(crud.agent_list(db), timeout=DB_TIMEOUT)
            online_agents = [a for a in all_agents if a.is_online]
            online_agent_ids = {a.id for a in online_agents}
            
            # Check each thread that has agents in wait state
            for thread_id, wait_states in list(_thread_agent_wait_states.items()):
                if not wait_states:
                    continue
                
                # Get thread settings
                ts = await asyncio.wait_for(
                    crud.thread_settings_get_or_create(db, thread_id),
                    timeout=DB_TIMEOUT,
                )
                
                # Skip if auto_administrator is disabled
                if not ts.auto_administrator_enabled:
                    continue
                
                # Filter wait states to only include online agents
                online_wait_states = {
                    agent_id: state for agent_id, state in wait_states.items()
                    if agent_id in online_agent_ids
                }
                
                if not online_wait_states:
                    continue

                # Build thread participant set from message history, then intersect online agents.
                # If history is empty (new thread), fall back to current waiters.
                async with db.execute(
                    """
                    SELECT DISTINCT author_id
                    FROM messages
                    WHERE thread_id = ? AND author_id IS NOT NULL AND author_id != ''
                    """,
                    (thread_id,),
                ) as cur:
                    participant_rows = await cur.fetchall()
                thread_participant_ids = {
                    row["author_id"]
                    for row in participant_rows
                    if row["author_id"] in online_agent_ids
                }
                if not thread_participant_ids:
                    thread_participant_ids = set(online_wait_states.keys())

                participating_online_agents = [
                    a for a in online_agents if a.id in thread_participant_ids
                ]
                if not participating_online_agents:
                    continue
                
                # Trigger only when all online participants of THIS thread are waiting.
                if not thread_participant_ids.issubset(set(online_wait_states.keys())):
                    continue
                
                # All online agents are in wait state - check timing
                # Use the most recent entry time (last agent to enter wait)
                latest_enter = max(
                    online_wait_states[agent_id]["entered_at"]
                    for agent_id in thread_participant_ids
                )
                elapsed = (datetime.now(timezone.utc) - latest_enter).total_seconds()
                
                if elapsed < ts.timeout_seconds:
                    continue
                
                # Timeout reached - evaluate admin coordination action
                logger.info(f"Thread {thread_id}: all {len(online_wait_states)} online agents in msg_wait for {elapsed:.0f}s")
                
                try:
                    participant_count = len(participating_online_agents)
                    # Trigger prompt when at least one online participant remains.
                    if participant_count < 1:
                        continue

                    # Current admin is creator-admin first, then auto-assigned admin.
                    current_admin_id = ts.creator_admin_id or ts.auto_assigned_admin_id
                    if not current_admin_id:
                        continue

                    current_admin_online = current_admin_id in thread_participant_ids
                    if current_admin_online:
                        continue

                    current_admin = next((a for a in all_agents if a.id == current_admin_id), None)

                    # Propose a candidate from online participants, excluding the current admin.
                    candidate_pool = [a for a in participating_online_agents if a.id != current_admin_id]
                    if not candidate_pool:
                        logger.warning(f"No online candidate available for thread {thread_id} admin switch prompt")
                        continue

                    candidate_admin = random.choice(candidate_pool)

                    current_admin_emoji = _agent_emoji(current_admin_id)
                    current_admin_label = _agent_label(current_admin, current_admin_id)
                    candidate_admin_emoji = _agent_emoji(candidate_admin.id)
                    candidate_admin_label = _agent_label(candidate_admin, candidate_admin.id)

                    system_msg_content = (
                        "Possible administrator offline detected. "
                        f"Current admin: {current_admin_emoji} {current_admin_label}. "
                        f"Candidate admin: {candidate_admin_emoji} {candidate_admin_label}. "
                        "Human confirmation is required before any admin change."
                    )
                    
                    metadata = {
                        "ui_type": "admin_switch_confirmation_required",
                        "thread_id": thread_id,
                        "reason": "possible_admin_offline",
                        "current_admin_id": current_admin_id,
                        "current_admin_name": current_admin_label,
                        "current_admin_emoji": current_admin_emoji,
                        "candidate_admin_id": candidate_admin.id,
                        "candidate_admin_name": candidate_admin_label,
                        "candidate_admin_emoji": candidate_admin_emoji,
                        "timeout_seconds": int(elapsed),
                        "online_agents_count": participant_count,
                        "triggered_at": datetime.now(timezone.utc).isoformat(),
                        "ui_buttons": [
                            {
                                "action": "switch",
                                "label": f"Switch admin to {candidate_admin_emoji} {candidate_admin_label}",
                            },
                            {
                                "action": "keep",
                                "label": f"Keep {current_admin_emoji} {current_admin_label} as admin",
                            },
                        ],
                    }
                    
                    # Post system message
                    await asyncio.wait_for(
                        crud._msg_create_system(
                            db,
                            thread_id=thread_id,
                            content=system_msg_content,
                            metadata=metadata,
                            clear_auto_admin=False,
                        ),
                        timeout=DB_TIMEOUT,
                    )
                    
                    # Clear wait states for this thread to avoid repeated notifications
                    clear_thread_wait_state(thread_id)
                    
                    logger.info(
                        "Sent admin-switch confirmation prompt for thread %s: current=%s, candidate=%s",
                        thread_id,
                        current_admin_id,
                        candidate_admin.id,
                    )
                    
                except asyncio.TimeoutError:
                    logger.error(f"Timeout processing coordination for thread {thread_id}")
                except Exception as e:
                    logger.error(f"Error processing coordination for thread {thread_id}: {e}")
                    
        except asyncio.CancelledError:
            break
        except Exception as exc:
            logger.warning(f"Admin coordinator loop error: {exc}")

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _start_time
    _start_time = datetime.now(timezone.utc)
    # Startup: initialize DB
    try:
        await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
    except asyncio.TimeoutError:
        logger.error("Startup timeout: Unable to connect to database")
        raise
    cleanup_task = asyncio.create_task(_cleanup_events_loop())
    timeout_task = asyncio.create_task(_thread_timeout_loop()) if THREAD_TIMEOUT_ENABLED else None
    admin_task = asyncio.create_task(_admin_coordinator_loop())
    logger.info(f"AgentChatBus running at http://{HOST}:{PORT}")
    yield
    # Shutdown: close DB
    cleanup_task.cancel()
    admin_task.cancel()
    if timeout_task is not None:
        timeout_task.cancel()
        try:
            await timeout_task
        except asyncio.CancelledError:
            pass
    try:
        await cleanup_task
    except asyncio.CancelledError:
        pass
    try:
        await admin_task
    except asyncio.CancelledError:
        pass
    try:
        await asyncio.wait_for(close_db(), timeout=DB_TIMEOUT)
    except asyncio.TimeoutError:
        logger.warning("Shutdown timeout: Unable to close database connection")
    except Exception as e:
        logger.warning(f"Shutdown database close failed: {e}")


app = FastAPI(
    title="AgentChatBus",
    description="Multi-agent communication bus supporting MCP and A2A protocols.",
    version="0.1.0",
    lifespan=lifespan,
)

# ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
# MCP SSE Transport (mounted at /mcp)
# ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

sse_transport = SseServerTransport("/mcp/messages")


class _SseCompletedResponse:
    """
    Sentinel returned from mcp_sse_endpoint after connect_sse() exits.

    The SSE transport sends the full HTTP response (http.response.start +
    http.response.body chunks) directly to uvicorn via request._send.
    If we return a real Response(), FastAPI calls it with send, which tries
    to emit a SECOND http.response.start ΓÇö uvicorn rejects this with:
      "Unexpected ASGI message 'http.response.start'"  (normal close), or
      "Expected 'http.response.body', got 'http.response.start'"  (abrupt close).

    This no-op sentinel lets FastAPI complete its routing without sending
    any additional ASGI messages.
    """
    async def __call__(self, scope, receive, send):
        pass  # intentional no-op ΓÇö SSE transport already sent the response


@app.get("/mcp/sse")
async def mcp_sse_endpoint(request: Request):
    """MCP SSE endpoint consumed by MCP clients (Claude Desktop, Cursor, ΓÇª)."""
    from src.mcp_server import init_session_id, pop_agent_for_session
    from src.db import crud
    
    # Initialize unique session ID for this SSE connection
    session_id = init_session_id()
    logger.debug(f"New MCP SSE connection: session_id={session_id[:8]}")
    
    lang = request.query_params.get("lang")
    if lang:
        _session_language.set(lang)

    try:
        async with sse_transport.connect_sse(
            request.scope, request.receive, request._send
        ) as streams:
            await mcp_server.run(
                streams[0], streams[1],
                mcp_server.create_initialization_options(),
            )
    except Exception as exc:
        # Most are normal disconnects (anyio.ClosedResourceError, CancelledErrorΓÇª).
        # Mark agent as offline if it was registered for this connection.
        agent_id, token = pop_agent_for_session(session_id)
        if agent_id and token:
            try:
                db = await get_db()
                await crud.agent_unregister(db, agent_id, token)
                logger.info(f"Agent {agent_id} marked offline (SSE disconnect)")
            except Exception as db_err:
                logger.warning(f"Failed to mark agent {agent_id} offline: {db_err}")
        else:
            logger.debug("MCP SSE session ended (no agent registered): %s: %s", type(exc).__name__, exc)
    return _SseCompletedResponse()


# Mount handle_post_message as a raw ASGI app ΓÇö NOT a FastAPI route.
# The transport sends its own 202 Accepted internally; a FastAPI route wrapper
# would attempt a second response and produce ASGI errors.
app.mount("/mcp/messages/", app=sse_transport.handle_post_message)


# ΓöÇΓöÇ Suppress leftover ASGI RuntimeErrors caused by client disconnects ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
class _AsgiDisconnectFilter(logging.Filter):
    """
    Filters uvicorn 'Exception in ASGI application' records that are caused
    by normal MCP client disconnects ΓÇö not real bugs, just transport noise.
    """
    _NOISE = (
        "Unexpected ASGI message 'http.response.start'",
        "Expected ASGI message 'http.response.body'",
    )
    def filter(self, record: logging.LogRecord) -> bool:
        return not any(n in record.getMessage() for n in self._NOISE)

for _ln in ("uvicorn.error", "uvicorn"):
    logging.getLogger(_ln).addFilter(_AsgiDisconnectFilter())



# ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
# Public SSE broadcast for the web console
# ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

@app.get("/events")
async def global_sse_stream(request: Request):
    """
    SSE broadcast stream consumed by the web console.
    Polls the `events` table and fans out new rows as SSE messages.
    """
    async def event_generator():
        try:
            db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        except asyncio.TimeoutError:
            logger.error("Event stream timeout: Unable to connect to database")
            return
        last_id = 0
        while True:
            try:
                if await request.is_disconnected():
                    break
                events = await asyncio.wait_for(crud.events_since(db, after_id=last_id), timeout=DB_TIMEOUT)
                for ev in events:
                    last_id = ev.id
                    data = json.dumps({"type": ev.event_type, "payload": json.loads(ev.payload)})
                    yield f"id: {ev.id}\nevent: message\ndata: {data}\n\n"
            except asyncio.TimeoutError:
                logger.warning("Event polling timeout for an event_since query")
            except Exception as e:
                logger.error(f"Event stream error: {e}")
                break
            await asyncio.sleep(0.5)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


# ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
# Simple REST API for the web console
# ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

@app.get("/api/threads")
async def api_threads(
    status: str | None = None,
    include_archived: bool = False,
    limit: int = 0,
    before: str | None = None,
):
    """List threads with optional cursor pagination.

    - `limit`: max threads to return (0 = all, hard cap 200).
    - `before`: ISO datetime cursor — returns threads created before this timestamp.
      Use `next_cursor` from a previous response to fetch the next page.
    """
    if limit > 0:
        limit = min(limit, 200)
    if before:
        # URL-decode: '+' in timezone offset (e.g. +00:00) is decoded as space by HTTP
        # query param parsers. Normalize it back before parsing.
        before = before.replace(" ", "+")
        try:
            datetime.fromisoformat(before)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid 'before' cursor: must be an ISO datetime string")
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        threads, total = await asyncio.gather(
            asyncio.wait_for(
                crud.thread_list(db, status=status, include_archived=include_archived, limit=limit, before=before),
                timeout=DB_TIMEOUT,
            ),
            asyncio.wait_for(
                crud.thread_count(db, status=status, include_archived=include_archived),
                timeout=DB_TIMEOUT,
            ),
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    has_more = limit > 0 and len(threads) == limit
    return {
        "threads": [
            {"id": t.id, "topic": t.topic, "status": t.status, "system_prompt": t.system_prompt,
             "created_at": t.created_at.isoformat()}
            for t in threads
        ],
        "total": total,
        "has_more": has_more,
        "next_cursor": threads[-1].created_at.isoformat() if has_more else None,
    }


@app.get("/api/threads/{thread_id}/messages")
async def api_messages(
    thread_id: str,
    after_seq: int = 0,
    limit: int = 200,
    include_system_prompt: bool = False,
    priority: str | None = None,
):
    limit = min(limit, 1000)  # server-side hard cap — prevents memory exhaustion
    if priority is not None and priority not in {"normal", "urgent", "system"}:
        raise HTTPException(status_code=400, detail=f"Invalid priority filter '{priority}'")
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        t = await asyncio.wait_for(crud.thread_get(db, thread_id), timeout=DB_TIMEOUT)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    if t is None:
        raise HTTPException(status_code=404, detail="Thread not found")
    try:
        msgs = await asyncio.wait_for(
            crud.msg_list(
                db,
                thread_id,
                after_seq=after_seq,
                limit=limit,
                include_system_prompt=include_system_prompt,
                priority=priority,
            ),
            timeout=DB_TIMEOUT,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")

    # Fetch reactions for real message IDs (exclude synthetic system msg with id=sys-*)
    real_ids = [m.id for m in msgs if not m.id.startswith("sys-")]
    try:
        reactions_map = await asyncio.wait_for(
            crud.msg_reactions_bulk(db, real_ids),
            timeout=DB_TIMEOUT,
        )
    except asyncio.TimeoutError:
        reactions_map = {}

    return [
        {
            "id": m.id,
            "author": m.author,
            "author_id": m.author_id,
            "author_name": m.author_name,
            "role": m.role,
            "content": m.content,
            "seq": m.seq,
            "created_at": m.created_at.isoformat(),
            "metadata": m.metadata,
            "priority": m.priority,
            "reply_to_msg_id": m.reply_to_msg_id,
            "reactions": reactions_map.get(m.id, []),
        }
        for m in msgs
    ]


# ─────────────────────────────────────────────
# Reactions API (UP-13)
# ─────────────────────────────────────────────

class ReactionCreate(BaseModel):
    agent_id: str
    reaction: str


@app.post("/api/messages/{message_id}/reactions", status_code=201)
async def api_add_reaction(message_id: str, body: ReactionCreate):
    """Add a reaction to a message. Idempotent — duplicate reactions are silently ignored."""
    if not body.reaction or not body.reaction.strip():
        raise HTTPException(status_code=400, detail="Reaction must be a non-empty string")
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        reaction = await asyncio.wait_for(
            crud.msg_react(db, message_id=message_id, agent_id=body.agent_id, reaction=body.reaction.strip()),
            timeout=DB_TIMEOUT,
        )
    except MessageNotFoundError:
        raise HTTPException(status_code=404, detail=f"Message '{message_id}' not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    return {
        "id": reaction.id,
        "message_id": reaction.message_id,
        "agent_id": reaction.agent_id,
        "agent_name": reaction.agent_name,
        "reaction": reaction.reaction,
        "created_at": reaction.created_at.isoformat(),
    }


@app.delete("/api/messages/{message_id}/reactions/{reaction}", status_code=200)
async def api_remove_reaction(message_id: str, reaction: str, agent_id: str):
    """Remove a reaction from a message. Returns removed=true/false."""
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        removed = await asyncio.wait_for(
            crud.msg_unreact(db, message_id=message_id, agent_id=agent_id, reaction=reaction),
            timeout=DB_TIMEOUT,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    return {"removed": removed, "message_id": message_id, "reaction": reaction, "agent_id": agent_id}


@app.get("/api/messages/{message_id}/reactions")
async def api_get_reactions(message_id: str):
    """Get all reactions for a message."""
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        reactions = await asyncio.wait_for(
            crud.msg_reactions(db, message_id),
            timeout=DB_TIMEOUT,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    return [
        {
            "id": r.id,
            "message_id": r.message_id,
            "agent_id": r.agent_id,
            "agent_name": r.agent_name,
            "reaction": r.reaction,
            "created_at": r.created_at.isoformat(),
        }
        for r in reactions
    ]


# ─────────────────────────────────────────────
# Image Upload API
# ─────────────────────────────────────────────

UPLOAD_DIR = Path(__file__).resolve().parent / "static" / "uploads"

# ── Image upload hardening (QW-01) ─────────────────────────────────────────
# Max upload size: 5 MB. Prevents memory exhaustion / disk DoS.
_MAX_IMAGE_BYTES = int(os.getenv("AGENTCHATBUS_MAX_IMAGE_BYTES", str(5 * 1024 * 1024)))

# Allowlist of safe extensions mapped to their expected magic-byte signatures.
# Only files whose first bytes match the declared extension are accepted.
_ALLOWED_IMAGE_EXTS: dict[str, list[bytes]] = {
    ".jpg":  [b"\xff\xd8\xff"],
    ".jpeg": [b"\xff\xd8\xff"],
    ".png":  [b"\x89PNG\r\n\x1a\n"],
    ".gif":  [b"GIF87a", b"GIF89a"],
    ".webp": [b"RIFF"],
}


def _ext_from_filename(filename: str) -> str:
    """Return lowercase extension; map .jpe / .jfif → .jpg for uniformity."""
    ext = Path(filename).suffix.lower()
    return ".jpg" if ext in {".jpe", ".jfif"} else ext


def _magic_bytes_ok(data: bytes, ext: str) -> bool:
    """Return True if the first bytes of data match any known signature for ext."""
    signatures = _ALLOWED_IMAGE_EXTS.get(ext, [])
    return any(data[:len(sig)] == sig for sig in signatures)


@app.post("/api/upload/image")
async def api_upload_image(request: Request):
    """Upload an image and return its URL."""
    try:
        form = await request.form()
        file = form.get("file")
        if not file or not file.filename:
            raise HTTPException(status_code=400, detail="No file provided")

        ext = _ext_from_filename(file.filename)
        if ext not in _ALLOWED_IMAGE_EXTS:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported file type '{ext}'. Allowed: {', '.join(_ALLOWED_IMAGE_EXTS)}",
            )

        # Read with size cap to prevent memory exhaustion
        contents = await file.read(_MAX_IMAGE_BYTES + 1)
        if len(contents) > _MAX_IMAGE_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"File too large. Maximum size is {_MAX_IMAGE_BYTES // (1024 * 1024)} MB",
            )

        # Verify magic bytes — guards against renamed executables / polyglots
        if not _magic_bytes_ok(contents, ext):
            raise HTTPException(status_code=400, detail="File content does not match its extension")

        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        unique_name = f"{uuid.uuid4()}{ext}"
        file_path = UPLOAD_DIR / unique_name
        with open(file_path, "wb") as f:
            f.write(contents)

        return {"url": f"/static/uploads/{unique_name}", "name": file.filename}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Image upload error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/agents")
async def api_agents():
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        agents = await asyncio.wait_for(crud.agent_list(db), timeout=DB_TIMEOUT)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")

    result = []
    # Consider active SSE connections as a sign the agent is online even if the
    # DB heartbeat is slightly stale. mcp_server maintains a per-session mapping
    # of connected agents which we consult here to reflect live connections in
    # the `/api/agents` response.
    try:
        active_agent_ids = {v.get("agent_id") for v in mcp_server._connection_agents.values() if v.get("agent_id")}
    except Exception:
        active_agent_ids = set()

    import json as _json
    for a in agents:
        is_online = bool(a.is_online or (a.id in active_agent_ids))
        result.append({
            "id": a.id, "name": a.name, "display_name": a.display_name, "alias_source": a.alias_source,
            "description": a.description, "ide": a.ide, "model": a.model,
            "capabilities": _json.loads(a.capabilities) if a.capabilities else [],
            "skills": _json.loads(a.skills) if a.skills else [],
            "is_online": is_online, "last_heartbeat": a.last_heartbeat.isoformat(),
            "last_activity": a.last_activity,
            "last_activity_time": a.last_activity_time.isoformat() if a.last_activity_time else None
        })

    return result


@app.get("/api/settings")
async def api_get_settings():
    return get_config_dict()

class SettingsUpdate(BaseModel):
    HOST: str | None = None
    PORT: int | None = None
    AGENT_HEARTBEAT_TIMEOUT: int | None = None
    MSG_WAIT_TIMEOUT: int | None = None

@app.put("/api/settings")
async def api_update_settings(body: SettingsUpdate, x_admin_token: str | None = Header(default=None)):
    if ADMIN_TOKEN and x_admin_token != ADMIN_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid admin token")
    update_data = {k: v for k, v in body.model_dump().items() if v is not None}
    if update_data:
        save_config_dict(update_data)
    # The user should be notified that a restart is required for some settings
    return {"ok": True, "message": "Settings saved. Restart the server to apply changes."}

# ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
# Request/Response Models
# ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

class ThreadCreate(BaseModel):
    topic: str
    metadata: dict | None = None
    system_prompt: str | None = None
    template: str | None = None   # Template ID for defaults (UP-18)
    creator_agent_id: str


class TemplateCreate(BaseModel):
    id: str
    name: str
    description: str | None = None
    system_prompt: str | None = None
    default_metadata: dict | None = None
    agent_id: str | None = None  # optional — if provided with token, must match a registered agent
    token: str | None = None     # optional — required only when agent_id is provided

class MessageCreate(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "author": "Agent-A",
                "role": "user",
                "content": "What do you think about this approach?"
            }
        }
    )
    
    author: str = "human"
    role: Literal["user", "assistant", "system"] = "user"
    content: str
    expected_last_seq: int | None = None
    reply_token: str | None = None
    mentions: list[str] | None = None
    metadata: dict | None = None
    images: list[dict] | None = None  # [{url: str, name: str}, ...]
    priority: Literal["normal", "urgent", "system"] = "normal"  # UP-16
    reply_to_msg_id: str | None = None  # UP-14: optional parent message ID

class SyncContextRequest(BaseModel):
    agent_id: str | None = None


@app.get("/api/templates")
async def api_list_templates():
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        templates = await asyncio.wait_for(crud.template_list(db), timeout=DB_TIMEOUT)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    return [
        {
            "id": t.id, "name": t.name, "description": t.description,
            "is_builtin": t.is_builtin, "created_at": t.created_at.isoformat(),
        }
        for t in templates
    ]


@app.get("/api/templates/{template_id}")
async def api_get_template(template_id: str):
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        t = await asyncio.wait_for(crud.template_get(db, template_id), timeout=DB_TIMEOUT)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    if t is None:
        raise HTTPException(status_code=404, detail="Template not found")
    return {
        "id": t.id, "name": t.name, "description": t.description,
        "system_prompt": t.system_prompt, "default_metadata": t.default_metadata,
        "is_builtin": t.is_builtin, "created_at": t.created_at.isoformat(),
    }


@app.post("/api/templates", status_code=201)
async def api_create_template(body: TemplateCreate):
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")

    # QW-06: if agent_id + token provided, verify they match a registered agent
    if body.agent_id and body.token:
        token_valid = await asyncio.wait_for(
            crud.agent_verify_token(db, body.agent_id, body.token), timeout=DB_TIMEOUT
        )
        if not token_valid:
            raise HTTPException(status_code=401, detail="Invalid agent_id or token")

    # QW-07: apply content filter to system_prompt to block embedded secrets
    if body.system_prompt:
        from src.content_filter import check_content, ContentFilterError as _CFE
        blocked, pattern = check_content(body.system_prompt)
        if blocked:
            raise HTTPException(status_code=400, detail={"error": "system_prompt blocked by content filter", "pattern": pattern})

    try:
        t = await asyncio.wait_for(
            crud.template_create(
                db,
                id=body.id,
                name=body.name,
                description=body.description,
                system_prompt=body.system_prompt,
                default_metadata=body.default_metadata,
            ),
            timeout=DB_TIMEOUT,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {"id": t.id, "name": t.name, "description": t.description, "is_builtin": t.is_builtin}


@app.delete("/api/templates/{template_id}", status_code=204)
async def api_delete_template(template_id: str):
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        await asyncio.wait_for(crud.template_delete(db, template_id), timeout=DB_TIMEOUT)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    except ValueError as e:
        err = str(e)
        if "not found" in err.lower():
            raise HTTPException(status_code=404, detail=err)
        raise HTTPException(status_code=403, detail=err)


@app.post("/api/threads/{thread_id}/sync-context")
async def api_sync_context(thread_id: str, body: SyncContextRequest | None = None):
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        t = await asyncio.wait_for(crud.thread_get(db, thread_id), timeout=DB_TIMEOUT)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    if t is None:
        raise HTTPException(status_code=404, detail="Thread not found")

    agent_id = body.agent_id if body else None
    sync = await asyncio.wait_for(
        crud.issue_reply_token(db, thread_id=thread_id, agent_id=agent_id),
        timeout=DB_TIMEOUT,
    )
    return sync

@app.post("/api/threads", status_code=201)
async def api_create_thread(
    body: ThreadCreate,
    x_agent_token: str | None = Header(default=None),
):
    # QW-07: apply content filter to system_prompt to block embedded secrets
    if body.system_prompt:
        from src.content_filter import check_content
        blocked, pattern = check_content(body.system_prompt)
        if blocked:
            raise HTTPException(status_code=400, detail={"error": "system_prompt blocked by content filter", "pattern": pattern})

    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)

        if not x_agent_token:
            raise HTTPException(
                status_code=401,
                detail="X-Agent-Token header required to create thread as a registered agent",
            )

        t, sync = await asyncio.wait_for(
            create_thread_with_verified_creator(
                db,
                topic=body.topic,
                creator_agent_id=body.creator_agent_id,
                creator_token=x_agent_token,
                metadata=body.metadata,
                system_prompt=body.system_prompt,
                template=body.template,
            ),
            timeout=DB_TIMEOUT,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    except CreatorAuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except CreatorNotFoundError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"id": t.id, "topic": t.topic, "status": t.status, "system_prompt": t.system_prompt,
            "template_id": t.template_id, "created_at": t.created_at.isoformat(),
            "current_seq": sync["current_seq"], "reply_token": sync["reply_token"],
            "reply_window": sync["reply_window"]}

@app.post("/api/threads/{thread_id}/messages", status_code=201)
async def api_post_message(thread_id: str, body: MessageCreate, x_agent_token: str | None = Header(default=None)):
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        t = await asyncio.wait_for(crud.thread_get(db, thread_id), timeout=DB_TIMEOUT)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    if t is None:
        raise HTTPException(status_code=404, detail="Thread not found")

    # Vecteur B: prevent role escalation from human/anonymous senders
    if body.role == "system" and body.author in ("human", ""):
        raise HTTPException(status_code=400, detail="role 'system' is not allowed for human messages")

    # Vecteur C: if author matches a known agent_id, require a valid token
    try:
        known_agent = await asyncio.wait_for(crud.agent_get(db, body.author), timeout=DB_TIMEOUT)
    except asyncio.TimeoutError:
        known_agent = None
    if known_agent is not None:
        if not x_agent_token:
            raise HTTPException(status_code=401, detail="X-Agent-Token header required to post as a registered agent")
        token_valid = await asyncio.wait_for(
            crud.agent_verify_token(db, body.author, x_agent_token), timeout=DB_TIMEOUT
        )
        if not token_valid:
            raise HTTPException(status_code=401, detail="Invalid agent token")

    # REST compatibility: allow callers to omit strict sync fields.
    # The MCP tool surface remains strict (expects msg_wait -> msg_post).
    expected_last_seq = body.expected_last_seq
    reply_token = body.reply_token
    if expected_last_seq is None or not reply_token:
        try:
            sync = await asyncio.wait_for(
                crud.issue_reply_token(
                    db,
                    thread_id=thread_id,
                    agent_id=body.author if known_agent is not None else None,
                ),
                timeout=DB_TIMEOUT,
            )
        except asyncio.TimeoutError:
            raise HTTPException(status_code=503, detail="Database operation timeout")
        if expected_last_seq is None:
            expected_last_seq = sync["current_seq"]
        if not reply_token:
            reply_token = sync["reply_token"]

    msg_metadata = body.metadata or {}
    if body.mentions:
        msg_metadata["mentions"] = body.mentions
    if body.images:
        msg_metadata["images"] = body.images

    try:
        m = await asyncio.wait_for(
            crud.msg_post(db, thread_id=thread_id, author=body.author,
                         content=body.content,
                         expected_last_seq=expected_last_seq,
                         reply_token=reply_token,
                         role=body.role,
                         metadata=msg_metadata if msg_metadata else None,
                         priority=body.priority,
                         reply_to_msg_id=body.reply_to_msg_id),
            timeout=DB_TIMEOUT
        )
    except MissingSyncFieldsError as e:
        raise HTTPException(status_code=400, detail={
            "error": "MISSING_SYNC_FIELDS",
            "missing_fields": e.missing_fields,
            "action": "CALL_SYNC_CONTEXT_THEN_RETRY",
        })
    except SeqMismatchError as e:
        raise HTTPException(status_code=409, detail={
            "error": "SEQ_MISMATCH",
            "expected_last_seq": e.expected_last_seq,
            "current_seq": e.current_seq,
            "new_messages": e.new_messages,
            "action": "RE_READ_AND_RETRY",
        })
    except ReplyTokenInvalidError:
        raise HTTPException(status_code=400, detail={
            "error": "TOKEN_INVALID",
            "action": "CALL_SYNC_CONTEXT_THEN_RETRY",
        })
    except ReplyTokenExpiredError as e:
        raise HTTPException(status_code=400, detail={
            "error": "TOKEN_EXPIRED",
            "expires_at": e.expires_at,
            "action": "CALL_SYNC_CONTEXT_THEN_RETRY",
        })
    except ReplyTokenReplayError as e:
        raise HTTPException(status_code=400, detail={
            "error": "TOKEN_REPLAY",
            "consumed_at": e.consumed_at,
            "action": "CALL_SYNC_CONTEXT_THEN_RETRY",
        })
    except ContentFilterError as e:
        raise HTTPException(status_code=400, detail={"error": "Content blocked by filter", "pattern": e.pattern_name})
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    except RateLimitExceeded as e:
        from fastapi.responses import JSONResponse
        return JSONResponse(
            status_code=429,
            content={"error": "Rate limit exceeded", "limit": e.limit, "window": e.window, "retry_after": e.retry_after},
            headers={"Retry-After": str(e.retry_after)},
        )


    
    # Return the full message with metadata
    result = {"id": m.id, "seq": m.seq, "author": m.author,
            "role": m.role, "content": m.content, "created_at": m.created_at.isoformat(),
            "priority": m.priority, "reply_to_msg_id": m.reply_to_msg_id}

    # Add metadata (includes mentions and images)
    if m.metadata:
        result["metadata"] = m.metadata
    else:
        result["metadata"] = None

    return result



# ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
# Agent REST API (for simulation scripts)
# ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

class AgentRegister(BaseModel):
    ide: str
    model: str
    description: str = ""
    capabilities: list[str] | None = None
    skills: list[dict] | None = None
    display_name: str | None = None

class AgentToken(BaseModel):
    agent_id: str
    token: str

class AgentUpdate(BaseModel):
    token: str
    description: str | None = None
    capabilities: list[str] | None = None
    skills: list[dict] | None = None
    display_name: str | None = None


@app.get("/api/agents/{agent_id}")
async def api_agent_get(agent_id: str):
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        a = await asyncio.wait_for(crud.agent_get(db, agent_id), timeout=DB_TIMEOUT)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    if a is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    import json as _json
    return {
        "id": a.id, "name": a.name, "display_name": a.display_name, "alias_source": a.alias_source,
        "description": a.description, "ide": a.ide, "model": a.model,
        "capabilities": _json.loads(a.capabilities) if a.capabilities else [],
        "skills": _json.loads(a.skills) if a.skills else [],
        "is_online": a.is_online, "last_heartbeat": a.last_heartbeat.isoformat(),
        "registered_at": a.registered_at.isoformat(),
        "last_activity": a.last_activity,
        "last_activity_time": a.last_activity_time.isoformat() if a.last_activity_time else None,
    }


@app.put("/api/agents/{agent_id}")
async def api_agent_update(agent_id: str, body: AgentUpdate):
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        a = await asyncio.wait_for(
            crud.agent_update(
                db,
                agent_id=agent_id,
                token=body.token,
                description=body.description,
                capabilities=body.capabilities,
                skills=body.skills,
                display_name=body.display_name,
            ),
            timeout=DB_TIMEOUT
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    except ValueError as e:
        msg = str(e)
        if "not found" in msg:
            raise HTTPException(status_code=404, detail=msg)
        raise HTTPException(status_code=401, detail=msg)
    import json as _json
    return {
        "ok": True,
        "agent_id": a.id, "name": a.name, "display_name": a.display_name,
        "description": a.description,
        "capabilities": _json.loads(a.capabilities) if a.capabilities else [],
        "skills": _json.loads(a.skills) if a.skills else [],
        "last_activity": a.last_activity,
    }


@app.post("/api/agents/register", status_code=200)
async def api_agent_register(body: AgentRegister, response: Response):
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        a = await asyncio.wait_for(
            crud.agent_register(
                db,
                body.ide,
                body.model,
                body.description,
                body.capabilities,
                body.display_name,
                body.skills,
            ),
            timeout=DB_TIMEOUT
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    import json as _json
    response.set_cookie("acb_agent_id", a.id, httponly=True, samesite="lax", path="/")
    response.set_cookie("acb_agent_token", a.token, httponly=True, samesite="lax", path="/")
    return {
        "agent_id": a.id,
        "name": a.name,
        "display_name": a.display_name,
        "alias_source": a.alias_source,
        "token": a.token,
        "capabilities": _json.loads(a.capabilities) if a.capabilities else [],
        "skills": _json.loads(a.skills) if a.skills else [],
    }

@app.post("/api/agents/heartbeat")
async def api_agent_heartbeat(body: AgentToken):
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        ok = await asyncio.wait_for(
            crud.agent_heartbeat(db, body.agent_id, body.token),
            timeout=DB_TIMEOUT
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    if not ok:
        raise HTTPException(status_code=401, detail="Invalid agent_id/token")
    return {"ok": ok}

@app.post("/api/agents/resume")
async def api_agent_resume(body: AgentToken, response: Response):
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        a = await asyncio.wait_for(
            crud.agent_resume(db, body.agent_id, body.token),
            timeout=DB_TIMEOUT
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    except ValueError:
        raise HTTPException(status_code=401, detail="Invalid agent_id/token")
    response.set_cookie("acb_agent_id", a.id, httponly=True, samesite="lax", path="/")
    response.set_cookie("acb_agent_token", body.token, httponly=True, samesite="lax", path="/")
    return {
        "ok": True,
        "agent_id": a.id,
        "name": a.name,
        "display_name": a.display_name,
        "alias_source": a.alias_source,
        "is_online": a.is_online,
        "last_heartbeat": a.last_heartbeat.isoformat(),
    }

@app.post("/api/agents/unregister")
async def api_agent_unregister(body: AgentToken):
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        ok = await asyncio.wait_for(
            crud.agent_unregister(db, body.agent_id, body.token),
            timeout=DB_TIMEOUT
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    if not ok:
        raise HTTPException(status_code=401, detail="Invalid agent_id/token")
    return {"ok": ok}


@app.post("/api/agents/{agent_id}/kick")
async def api_agent_kick(agent_id: str):
    """Force an agent offline: interrupt msg_wait, remove from connections, backdate heartbeat.
    
    This is used to simulate agent crashes or forcibly disconnect misbehaving agents.
    Does NOT require authentication.
    """
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        agent = await asyncio.wait_for(crud.agent_get(db, agent_id), timeout=DB_TIMEOUT)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    
    # Step 1: Remove from all thread msg_wait states (interrupt long polls)
    threads_interrupted = []
    for thread_id in list(_thread_agent_wait_states.keys()):
        if agent_id in _thread_agent_wait_states[thread_id]:
            _thread_agent_wait_states[thread_id].pop(agent_id, None)
            threads_interrupted.append(thread_id)
            logger.info(f"[kick] Removed agent {agent_id} from msg_wait on thread {thread_id}")
        if not _thread_agent_wait_states[thread_id]:
            del _thread_agent_wait_states[thread_id]
    
    # Step 2: Remove from MCP connection registry (disconnect SSE/MCP sessions)
    import uuid
    sessions_disconnected = []
    try:
        from src.mcp_server import _connection_agents, pop_agent_for_session
        for session_id in list(_connection_agents.keys()):
            info = _connection_agents.get(session_id)
            if info and info.get("agent_id") == agent_id:
                result = pop_agent_for_session(session_id)
                sessions_disconnected.append(session_id[:8])
                logger.info(f"[kick] Removed agent {agent_id} from MCP session {session_id[:8]}...")
    except Exception as e:
        logger.warning(f"[kick] Could not remove from MCP connections: {e}")
    
    # Step 3: Mark agent offline by rotating token and backdating heartbeat
    try:
        now = datetime.now(timezone.utc)
        old_heartbeat = now - timedelta(seconds=120)  # 120s in past, beyond 30s heartbeat window
        new_token = str(uuid.uuid4())
        
        db2 = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        await asyncio.wait_for(
            db2.execute(
                "UPDATE agents SET token=?, last_heartbeat=? WHERE id=?",
                (new_token, old_heartbeat.isoformat()+"+00:00", agent_id)
            ),
            timeout=DB_TIMEOUT
        )
        await asyncio.wait_for(db2.commit(), timeout=DB_TIMEOUT)
        logger.info(f"[kick] Backdated heartbeat and rotated token for agent {agent_id}")
    except Exception as e:
        logger.warning(f"[kick] Could not update DB for agent {agent_id}: {e}")
    
    return {
        "ok": True,
        "agent_id": agent_id,
        "agent_name": agent.display_name or agent.name,
        "threads_interrupted": threads_interrupted,
        "sessions_disconnected_count": len(sessions_disconnected),
        "message": f"Agent {agent.display_name or agent.name} has been kicked offline. "
                   f"Interrupted {len(threads_interrupted)} msg_wait(s), "
                   f"disconnected {len(sessions_disconnected)} session(s)."
    }



# ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ


# ─────────────────────────────────────────────
# Thread state management REST (for web console)
# ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

class StateChange(BaseModel):
    state: str

class ThreadClose(BaseModel):
    summary: str | None = None

@app.post("/api/threads/{thread_id}/state")
async def api_thread_state(thread_id: str, body: StateChange):
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        t = await asyncio.wait_for(crud.thread_get(db, thread_id), timeout=DB_TIMEOUT)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    if t is None:
        raise HTTPException(status_code=404, detail="Thread not found")
    try:
        await asyncio.wait_for(
            crud.thread_set_state(db, thread_id, body.state),
            timeout=DB_TIMEOUT
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}

@app.post("/api/threads/{thread_id}/close")
async def api_thread_close(thread_id: str, body: ThreadClose):
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        t = await asyncio.wait_for(crud.thread_get(db, thread_id), timeout=DB_TIMEOUT)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    if t is None:
        raise HTTPException(status_code=404, detail="Thread not found")
    try:
        await asyncio.wait_for(
            crud.thread_close(db, thread_id, body.summary),
            timeout=DB_TIMEOUT
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    return {"ok": True}


@app.delete("/api/threads/{thread_id}")
async def api_thread_delete(thread_id: str):
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    try:
        result = await asyncio.wait_for(
            crud.thread_delete(db, thread_id),
            timeout=DB_TIMEOUT,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    if result is None:
        raise HTTPException(status_code=404, detail="Thread not found")
    return {"ok": True, "deleted": result}


@app.post("/api/threads/{thread_id}/archive")
async def api_thread_archive(thread_id: str):
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        t = await asyncio.wait_for(crud.thread_get(db, thread_id), timeout=DB_TIMEOUT)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    if t is None:
        raise HTTPException(status_code=404, detail="Thread not found")
    try:
        ok = await asyncio.wait_for(
            crud.thread_archive(db, thread_id),
            timeout=DB_TIMEOUT
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not ok:
        raise HTTPException(status_code=404, detail="Thread not found")
    return {"ok": True}


# ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
@app.post("/api/threads/{thread_id}/unarchive")
async def api_thread_unarchive(thread_id: str):
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        t = await asyncio.wait_for(crud.thread_get(db, thread_id), timeout=DB_TIMEOUT)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    if t is None:
        raise HTTPException(status_code=404, detail="Thread not found")
    try:
        ok = await asyncio.wait_for(
            crud.thread_unarchive(db, thread_id),
            timeout=DB_TIMEOUT
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not ok:
        raise HTTPException(status_code=404, detail="Thread not found")
    return {"ok": True}


# ─────────────────────────────────────────────
# Export
# ─────────────────────────────────────────────

@app.get("/api/threads/{thread_id}/export")
async def api_thread_export(thread_id: str):
    """Export a thread as a downloadable Markdown transcript."""
    import re

    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        md = await asyncio.wait_for(
            crud.thread_export_markdown(db, thread_id),
            timeout=DB_TIMEOUT,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    if md is None:
        raise HTTPException(status_code=404, detail="Thread not found")

    try:
        t = await asyncio.wait_for(crud.thread_get(db, thread_id), timeout=DB_TIMEOUT)
        raw_topic = t.topic if t else thread_id
    except asyncio.TimeoutError:
        raw_topic = thread_id

    slug = re.sub(r"[^\w\-]", "-", raw_topic.lower(), flags=re.ASCII)
    slug = re.sub(r"-+", "-", slug, flags=re.ASCII).strip("-")[:80] or "thread"
    filename = f"{slug}.md"

    return PlainTextResponse(
        content=md,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename=\"{filename}\""},
    )


# ─────────────────────────────────────────────────────────────────────────────
# Thread Settings APIs
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/threads/{thread_id}/settings")
async def api_get_thread_settings(thread_id: str):
    """Get thread settings (coordination and automation config)."""
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        # Verify thread exists
        t = await asyncio.wait_for(crud.thread_get(db, thread_id), timeout=DB_TIMEOUT)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    if t is None:
        raise HTTPException(status_code=404, detail="Thread not found")
    
    try:
        settings = await asyncio.wait_for(
            crud.thread_settings_get_or_create(db, thread_id),
            timeout=DB_TIMEOUT,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    
    return {
        "thread_id": settings.thread_id,
        "auto_administrator_enabled": settings.auto_administrator_enabled,
        "auto_coordinator_enabled": settings.auto_administrator_enabled,  # Backward compatibility
        "timeout_seconds": settings.timeout_seconds,
        "last_activity_time": settings.last_activity_time.isoformat(),
        "auto_assigned_admin_id": settings.auto_assigned_admin_id,
        "auto_assigned_admin_name": settings.auto_assigned_admin_name,
        "admin_assignment_time": settings.admin_assignment_time.isoformat() if settings.admin_assignment_time else None,
        "creator_admin_id": settings.creator_admin_id,
        "creator_admin_name": settings.creator_admin_name,
        "creator_assignment_time": settings.creator_assignment_time.isoformat() if settings.creator_assignment_time else None,
        "created_at": settings.created_at.isoformat(),
        "updated_at": settings.updated_at.isoformat(),
    }


class ThreadSettingsUpdate(BaseModel):
    auto_administrator_enabled: bool | None = None
    auto_coordinator_enabled: bool | None = None  # Backward compatibility alias
    timeout_seconds: int | None = None
    model_config = ConfigDict(extra="ignore")


class AdminDecisionRequest(BaseModel):
    action: Literal["switch", "keep"]
    candidate_admin_id: str | None = None
    source_message_id: str | None = None


@app.post("/api/threads/{thread_id}/settings")
async def api_update_thread_settings(thread_id: str, body: ThreadSettingsUpdate):
    """Update thread settings for coordination and timeout."""
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        # Verify thread exists
        t = await asyncio.wait_for(crud.thread_get(db, thread_id), timeout=DB_TIMEOUT)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    if t is None:
        raise HTTPException(status_code=404, detail="Thread not found")
    
    try:
        # Support both new and legacy field names
        auto_admin_value = body.auto_administrator_enabled if body.auto_administrator_enabled is not None else body.auto_coordinator_enabled
        
        settings = await asyncio.wait_for(
            crud.thread_settings_update(
                db,
                thread_id,
                auto_administrator_enabled=auto_admin_value,
                timeout_seconds=body.timeout_seconds,
            ),
            timeout=DB_TIMEOUT,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    
    return {
        "thread_id": settings.thread_id,
        "auto_administrator_enabled": settings.auto_administrator_enabled,
        "auto_coordinator_enabled": settings.auto_administrator_enabled,  # Backward compatibility
        "timeout_seconds": settings.timeout_seconds,
        "last_activity_time": settings.last_activity_time.isoformat(),
        "auto_assigned_admin_id": settings.auto_assigned_admin_id,
        "auto_assigned_admin_name": settings.auto_assigned_admin_name,
        "admin_assignment_time": settings.admin_assignment_time.isoformat() if settings.admin_assignment_time else None,
        "creator_admin_id": settings.creator_admin_id,
        "creator_admin_name": settings.creator_admin_name,
        "creator_assignment_time": settings.creator_assignment_time.isoformat() if settings.creator_assignment_time else None,
        "created_at": settings.created_at.isoformat(),
        "updated_at": settings.updated_at.isoformat(),
    }


@app.get("/api/threads/{thread_id}/admin")
async def api_get_thread_admin(thread_id: str):
    """Get current admin for a thread.
    
    Priority: creator_admin > auto_assigned_admin
    """
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        settings = await asyncio.wait_for(
            crud.thread_settings_get_or_create(db, thread_id),
            timeout=DB_TIMEOUT,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    
    # Priority: creator_admin > auto_assigned_admin
    if settings.creator_admin_id:
        return {
            "admin_id": settings.creator_admin_id,
            "admin_name": settings.creator_admin_name,
            "admin_type": "creator",
            "assigned_at": settings.creator_assignment_time.isoformat() if settings.creator_assignment_time else None,
        }
    
    if settings.auto_assigned_admin_id:
        return {
            "admin_id": settings.auto_assigned_admin_id,
            "admin_name": settings.auto_assigned_admin_name,
            "admin_type": "auto_assigned",
            "assigned_at": settings.admin_assignment_time.isoformat() if settings.admin_assignment_time else None,
        }
    
    return {"admin_id": None, "admin_name": None, "admin_type": None, "assigned_at": None}


@app.post("/api/threads/{thread_id}/admin/decision")
async def api_thread_admin_decision(thread_id: str, body: AdminDecisionRequest):
    """Apply a human decision for admin switch confirmation prompts.

    This endpoint is intended for the web UI: no admin change occurs until a human
    explicitly clicks a decision button.
    """
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        t = await asyncio.wait_for(crud.thread_get(db, thread_id), timeout=DB_TIMEOUT)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    if t is None:
        raise HTTPException(status_code=404, detail="Thread not found")

    try:
        settings = await asyncio.wait_for(
            crud.thread_settings_get_or_create(db, thread_id),
            timeout=DB_TIMEOUT,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")

    current_admin_id = settings.creator_admin_id or settings.auto_assigned_admin_id
    current_admin_name = settings.creator_admin_name or settings.auto_assigned_admin_name

    if body.action == "switch":
        if not body.candidate_admin_id:
            raise HTTPException(status_code=400, detail="candidate_admin_id is required for action='switch'")

        try:
            candidate = await asyncio.wait_for(crud.agent_get(db, body.candidate_admin_id), timeout=DB_TIMEOUT)
        except asyncio.TimeoutError:
            raise HTTPException(status_code=503, detail="Database operation timeout")
        if candidate is None:
            raise HTTPException(status_code=404, detail="Candidate admin agent not found")

        candidate_name = candidate.display_name or candidate.name or candidate.id
        try:
            await asyncio.wait_for(
                crud.thread_settings_switch_admin(db, thread_id, candidate.id, candidate_name),
                timeout=DB_TIMEOUT,
            )
        except asyncio.TimeoutError:
            raise HTTPException(status_code=503, detail="Database operation timeout")

        old_badge = f"{_agent_emoji(current_admin_id)} {current_admin_name or current_admin_id or 'Unknown'}"
        new_badge = f"{_agent_emoji(candidate.id)} {candidate_name}"
        confirmation = (
            f"Administrator switched by human decision: {old_badge} -> {new_badge}."
        )
        metadata = {
            "ui_type": "admin_switch_decision_result",
            "decision": "switch",
            "thread_id": thread_id,
            "source_message_id": body.source_message_id,
            "previous_admin_id": current_admin_id,
            "new_admin_id": candidate.id,
            "new_admin_name": candidate_name,
            "new_admin_emoji": _agent_emoji(candidate.id),
            "decided_at": datetime.now(timezone.utc).isoformat(),
        }

        try:
            await asyncio.wait_for(
                crud._msg_create_system(
                    db,
                    thread_id=thread_id,
                    content=confirmation,
                    metadata=metadata,
                    clear_auto_admin=False,
                ),
                timeout=DB_TIMEOUT,
            )
        except asyncio.TimeoutError:
            raise HTTPException(status_code=503, detail="Database operation timeout")

        return {
            "ok": True,
            "action": "switch",
            "thread_id": thread_id,
            "new_admin_id": candidate.id,
            "new_admin_name": candidate_name,
        }

    kept_badge = f"{_agent_emoji(current_admin_id)} {current_admin_name or current_admin_id or 'Unknown'}"
    confirmation = f"Administrator kept by human decision: {kept_badge}."
    metadata = {
        "ui_type": "admin_switch_decision_result",
        "decision": "keep",
        "thread_id": thread_id,
        "source_message_id": body.source_message_id,
        "kept_admin_id": current_admin_id,
        "kept_admin_name": current_admin_name,
        "kept_admin_emoji": _agent_emoji(current_admin_id),
        "decided_at": datetime.now(timezone.utc).isoformat(),
    }

    try:
        await asyncio.wait_for(
            crud._msg_create_system(
                db,
                thread_id=thread_id,
                content=confirmation,
                metadata=metadata,
                clear_auto_admin=False,
            ),
            timeout=DB_TIMEOUT,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")

    return {
        "ok": True,
        "action": "keep",
        "thread_id": thread_id,
        "kept_admin_id": current_admin_id,
        "kept_admin_name": current_admin_name,
    }



# ─────────────────────────────────────────────
# ──────────────────────────────────────────────────────────────────────────────
# Metrics (UP-22)
# ──────────────────────────────────────────────────────────────────────────────

@app.get("/api/metrics")
async def get_metrics():
    """Return bus-level observability metrics.

    Unlike /health (a lightweight liveness probe with no DB calls), this
    endpoint queries the database for real-time statistics about threads,
    messages, and agents.  All values are derived from existing tables —
    no schema changes are required.
    """
    db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
    metrics = await asyncio.wait_for(crud.get_bus_metrics(db), timeout=DB_TIMEOUT)

    uptime_seconds: float = 0.0
    started_at: str | None = None
    if _start_time is not None:
        delta = datetime.now(timezone.utc) - _start_time
        uptime_seconds = round(delta.total_seconds(), 1)
        started_at = _start_time.isoformat()

    return {
        "status": "ok",
        "uptime_seconds": uptime_seconds,
        "started_at": started_at,
        **metrics,
        "schema_version": SCHEMA_VERSION,
    }


# Health check
# ──────────────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "service": "AgentChatBus"}



# ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
# Web Console (served from /static or inline)
# ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

@app.get("/", response_class=HTMLResponse)
async def web_console():
    """Serve the built-in web console."""
    with open(STATIC_DIR / "index.html", "r", encoding="utf-8") as f:
        return f.read()


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
# Entry point
# ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

if __name__ == "__main__":
    uvicorn.run(
        "src.main:app",
        host=HOST,
        port=PORT,
        # development mode with hot-reload controlled by AGENTCHATBUS_RELOAD env var
        # Set AGENTCHATBUS_RELOAD=0 to disable if a client is sensitive to
        # short reconnect windows during hot reload restarts.
        reload=RELOAD_ENABLED,
        reload_includes=["src/*.py", "src/db/*.py"],
        reload_excludes=["src/tools/*.py"],
        log_level="info",
        # Force-close lingering SSE / long-poll connections after 3 s when
        # Ctrl+C (SIGINT) is received. Without this, uvicorn waits forever
        # for the MCP SSE stream to disconnect naturally.
        timeout_graceful_shutdown=3,
    )