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
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

import uvicorn
from fastapi import FastAPI, Request, HTTPException
from starlette.responses import Response
from fastapi.responses import HTMLResponse, StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict
from mcp.server.sse import SseServerTransport
from starlette.routing import Mount

from src.config import HOST, PORT, get_config_dict, save_config_dict
from src.db.database import get_db, close_db
from src.db import crud
from src.mcp_server import server as mcp_server, _session_language

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("agentchatbus")
STATIC_DIR = Path(__file__).resolve().parent / "static"

# Database operation timeout (seconds)
DB_TIMEOUT = 5


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

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: initialize DB
    try:
        await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
    except asyncio.TimeoutError:
        logger.error("Startup timeout: Unable to connect to database")
        raise
    cleanup_task = asyncio.create_task(_cleanup_events_loop())
    logger.info(f"AgentChatBus running at http://{HOST}:{PORT}")
    yield
    # Shutdown: close DB
    cleanup_task.cancel()
    try:
        await cleanup_task
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
    from src.mcp_server import init_session_id
    
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
        # Log at DEBUG to avoid polluting the terminal.
        logger.debug("MCP SSE session ended: %s: %s", type(exc).__name__, exc)
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
async def api_threads(status: str | None = None, include_archived: bool = False):
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        threads = await asyncio.wait_for(
            crud.thread_list(db, status=status, include_archived=include_archived),
            timeout=DB_TIMEOUT
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    return [{"id": t.id, "topic": t.topic, "status": t.status, "system_prompt": t.system_prompt,
             "created_at": t.created_at.isoformat()} for t in threads]


@app.get("/api/threads/{thread_id}/messages")
async def api_messages(thread_id: str, after_seq: int = 0, limit: int = 200, include_system_prompt: bool = False):
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
            ),
            timeout=DB_TIMEOUT
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    return [{"id": m.id, "author": m.author, "author_id": m.author_id, "author_name": m.author_name, "role": m.role, "content": m.content,
             "seq": m.seq, "created_at": m.created_at.isoformat(), "metadata": m.metadata} for m in msgs]


# ─────────────────────────────────────────────
# Image Upload API
# ─────────────────────────────────────────────

UPLOAD_DIR = Path(__file__).resolve().parent / "static" / "uploads"

@app.post("/api/upload/image")
async def api_upload_image(request: Request):
    """Upload an image and return its URL."""
    try:
        form = await request.form()
        file = form.get("file")
        if not file or not file.filename:
            raise HTTPException(status_code=400, detail="No file provided")
        
        # Validate file type
        if not file.content_type.startswith("image/"):
            raise HTTPException(status_code=400, detail="File must be an image")
        
        # Create upload directory if it doesn't exist
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        
        # Generate unique filename
        ext = Path(file.filename).suffix or ".png"
        unique_name = f"{uuid.uuid4()}{ext}"
        file_path = UPLOAD_DIR / unique_name
        
        # Save file
        contents = await file.read()
        with open(file_path, "wb") as f:
            f.write(contents)
        
        # Return URL
        file_url = f"/static/uploads/{unique_name}"
        return {"url": file_url, "name": file.filename}
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
    for a in agents:
        result.append({
            "id": a.id, "name": a.name, "display_name": a.display_name, "alias_source": a.alias_source,
            "description": a.description, "ide": a.ide, "model": a.model,
            "is_online": a.is_online, "last_heartbeat": a.last_heartbeat.isoformat(),
            "last_activity": a.last_activity,
            "last_activity_time": a.last_activity_time.isoformat() if a.last_activity_time else None,
            "token": a.token
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
async def api_update_settings(body: SettingsUpdate):
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
    mentions: list[str] | None = None
    metadata: dict | None = None
    images: list[dict] | None = None  # [{url: str, name: str}, ...]

@app.post("/api/threads", status_code=201)
async def api_create_thread(body: ThreadCreate):
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        t = await asyncio.wait_for(
            crud.thread_create(db, body.topic, body.metadata, body.system_prompt),
            timeout=DB_TIMEOUT
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    return {"id": t.id, "topic": t.topic, "status": t.status, "system_prompt": t.system_prompt,
            "created_at": t.created_at.isoformat()}

@app.post("/api/threads/{thread_id}/messages", status_code=201)
async def api_post_message(thread_id: str, body: MessageCreate):
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        t = await asyncio.wait_for(crud.thread_get(db, thread_id), timeout=DB_TIMEOUT)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    if t is None:
        raise HTTPException(status_code=404, detail="Thread not found")
        
    msg_metadata = body.metadata or {}
    if body.mentions:
        msg_metadata["mentions"] = body.mentions
    if body.images:
        msg_metadata["images"] = body.images

    try:
        m = await asyncio.wait_for(
            crud.msg_post(db, thread_id=thread_id, author=body.author,
                         content=body.content, role=body.role,
                         metadata=msg_metadata if msg_metadata else None),
            timeout=DB_TIMEOUT
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    
    # Return the full message with metadata
    result = {"id": m.id, "seq": m.seq, "author": m.author,
            "role": m.role, "content": m.content, "created_at": m.created_at.isoformat()}
    
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
    display_name: str | None = None

class AgentToken(BaseModel):
    agent_id: str
    token: str


@app.post("/api/agents/register", status_code=200)
async def api_agent_register(body: AgentRegister):
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
            ),
            timeout=DB_TIMEOUT
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")
    return {
        "agent_id": a.id,
        "name": a.name,
        "display_name": a.display_name,
        "alias_source": a.alias_source,
        "token": a.token,
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
async def api_agent_resume(body: AgentToken):
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


@app.delete("/api/threads/{thread_id}")
async def api_thread_delete(thread_id: str):
    try:
        db = await asyncio.wait_for(get_db(), timeout=DB_TIMEOUT)
        ok = await asyncio.wait_for(
            crud.thread_delete(db, thread_id),
            timeout=DB_TIMEOUT
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Database operation timeout")

    if not ok:
        raise HTTPException(status_code=404, detail="Thread not found")
    return {"ok": True}


# ─────────────────────────────────────────────
# Health check
# ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

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
    reload_enabled = os.getenv("AGENTCHATBUS_RELOAD", "1") in {"1", "true", "True"}
    uvicorn.run(
        "src.main:app",
        host=HOST,
        port=PORT,
        # Keep reload ON by default for development workflow.
        # Set AGENTCHATBUS_RELOAD=0 to disable if a client is sensitive to
        # short reconnect windows during hot reload restarts.
        reload=reload_enabled,
        reload_includes=["src/*.py", "src/db/*.py"],
        reload_excludes=["src/tools/*.py"],
        log_level="info",
        # Force-close lingering SSE / long-poll connections after 3 s when
        # Ctrl+C (SIGINT) is received. Without this, uvicorn waits forever
        # for the MCP SSE stream to disconnect naturally.
        timeout_graceful_shutdown=3,
    )