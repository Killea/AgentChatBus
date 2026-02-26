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
import time
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, Request
from starlette.responses import Response
from fastapi.responses import HTMLResponse, StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from mcp.server.sse import SseServerTransport
from starlette.routing import Mount

from src.config import HOST, PORT
from src.db.database import get_db, close_db
from src.db import crud
from src.mcp_server import server as mcp_server

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("agentchatbus")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: initialize DB
    await get_db()
    logger.info(f"AgentChatBus running at http://{HOST}:{PORT}")
    yield
    # Shutdown: close DB
    await close_db()


app = FastAPI(
    title="AgentChatBus",
    description="Multi-agent communication bus supporting MCP and A2A protocols.",
    version="0.1.0",
    lifespan=lifespan,
)

# ─────────────────────────────────────────────
# MCP SSE Transport (mounted at /mcp)
# ─────────────────────────────────────────────

sse_transport = SseServerTransport("/mcp/messages")


class _SseCompletedResponse:
    """
    Sentinel returned from mcp_sse_endpoint after connect_sse() exits.

    The SSE transport sends the full HTTP response (http.response.start +
    http.response.body chunks) directly to uvicorn via request._send.
    If we return a real Response(), FastAPI calls it with send, which tries
    to emit a SECOND http.response.start — uvicorn rejects this with:
      "Unexpected ASGI message 'http.response.start'"  (normal close), or
      "Expected 'http.response.body', got 'http.response.start'"  (abrupt close).

    This no-op sentinel lets FastAPI complete its routing without sending
    any additional ASGI messages.
    """
    async def __call__(self, scope, receive, send):
        pass  # intentional no-op — SSE transport already sent the response


@app.get("/mcp/sse")
async def mcp_sse_endpoint(request: Request):
    """MCP SSE endpoint consumed by MCP clients (Claude Desktop, Cursor, …)."""
    try:
        async with sse_transport.connect_sse(
            request.scope, request.receive, request._send
        ) as streams:
            await mcp_server.run(
                streams[0], streams[1],
                mcp_server.create_initialization_options(),
            )
    except Exception as exc:
        # Most are normal disconnects (anyio.ClosedResourceError, CancelledError…).
        # Log at DEBUG to avoid polluting the terminal.
        logger.debug("MCP SSE session ended: %s: %s", type(exc).__name__, exc)
    return _SseCompletedResponse()


# Mount handle_post_message as a raw ASGI app — NOT a FastAPI route.
# The transport sends its own 202 Accepted internally; a FastAPI route wrapper
# would attempt a second response and produce ASGI errors.
app.mount("/mcp/messages/", app=sse_transport.handle_post_message)


# ── Suppress leftover ASGI RuntimeErrors caused by client disconnects ──────────
class _AsgiDisconnectFilter(logging.Filter):
    """
    Filters uvicorn 'Exception in ASGI application' records that are caused
    by normal MCP client disconnects — not real bugs, just transport noise.
    """
    _NOISE = (
        "Unexpected ASGI message 'http.response.start'",
        "Expected ASGI message 'http.response.body'",
    )
    def filter(self, record: logging.LogRecord) -> bool:
        return not any(n in record.getMessage() for n in self._NOISE)

for _ln in ("uvicorn.error", "uvicorn"):
    logging.getLogger(_ln).addFilter(_AsgiDisconnectFilter())



# ─────────────────────────────────────────────
# Public SSE broadcast for the web console
# ─────────────────────────────────────────────

@app.get("/events")
async def global_sse_stream(request: Request):
    """
    SSE broadcast stream consumed by the web console.
    Polls the `events` table and fans out new rows as SSE messages.
    """
    async def event_generator():
        db = await get_db()
        last_id = 0
        while True:
            if await request.is_disconnected():
                break
            events = await crud.events_since(db, after_id=last_id)
            for ev in events:
                last_id = ev.id
                data = json.dumps({"type": ev.event_type, "payload": json.loads(ev.payload)})
                yield f"id: {ev.id}\nevent: {ev.event_type}\ndata: {data}\n\n"
            await asyncio.sleep(0.5)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


# ─────────────────────────────────────────────
# Simple REST API for the web console
# ─────────────────────────────────────────────

@app.get("/api/threads")
async def api_threads(status: str | None = None):
    db = await get_db()
    threads = await crud.thread_list(db, status=status)
    return [{"id": t.id, "topic": t.topic, "status": t.status,
             "created_at": t.created_at.isoformat()} for t in threads]


@app.get("/api/threads/{thread_id}/messages")
async def api_messages(thread_id: str, after_seq: int = 0, limit: int = 200):
    db = await get_db()
    msgs = await crud.msg_list(db, thread_id, after_seq=after_seq, limit=limit)
    return [{"id": m.id, "author": m.author, "role": m.role, "content": m.content,
             "seq": m.seq, "created_at": m.created_at.isoformat()} for m in msgs]


@app.get("/api/agents")
async def api_agents():
    db = await get_db()
    agents = await crud.agent_list(db)
    return [{"id": a.id, "name": a.name, "description": a.description,
             "is_online": a.is_online, "last_heartbeat": a.last_heartbeat.isoformat()} for a in agents]


from pydantic import BaseModel

class ThreadCreate(BaseModel):
    topic: str
    metadata: dict | None = None

class MessageCreate(BaseModel):
    author: str = "human"
    role: str = "system"
    content: str

@app.post("/api/threads", status_code=201)
async def api_create_thread(body: ThreadCreate):
    db = await get_db()
    t = await crud.thread_create(db, body.topic, body.metadata)
    return {"id": t.id, "topic": t.topic, "status": t.status,
            "created_at": t.created_at.isoformat()}

@app.post("/api/threads/{thread_id}/messages", status_code=201)
async def api_post_message(thread_id: str, body: MessageCreate):
    db = await get_db()
    m = await crud.msg_post(db, thread_id=thread_id, author=body.author,
                            content=body.content, role=body.role)
    return {"id": m.id, "seq": m.seq, "author": m.author,
            "role": m.role, "content": m.content}


# ─────────────────────────────────────────────
# Agent REST API (for simulation scripts)
# ─────────────────────────────────────────────

class AgentRegister(BaseModel):
    ide: str
    model: str
    description: str = ""
    capabilities: list[str] | None = None

class AgentToken(BaseModel):
    agent_id: str
    token: str

@app.post("/api/agents/register", status_code=200)
async def api_agent_register(body: AgentRegister):
    db = await get_db()
    a = await crud.agent_register(db, body.ide, body.model, body.description, body.capabilities)
    return {"agent_id": a.id, "name": a.name, "token": a.token}

@app.post("/api/agents/heartbeat")
async def api_agent_heartbeat(body: AgentToken):
    db = await get_db()
    ok = await crud.agent_heartbeat(db, body.agent_id, body.token)
    return {"ok": ok}

@app.post("/api/agents/unregister")
async def api_agent_unregister(body: AgentToken):
    db = await get_db()
    ok = await crud.agent_unregister(db, body.agent_id, body.token)
    return {"ok": ok}





# ─────────────────────────────────────────────
# Thread state management REST (for web console)
# ─────────────────────────────────────────────

class StateChange(BaseModel):
    state: str

class ThreadClose(BaseModel):
    summary: str | None = None

@app.post("/api/threads/{thread_id}/state")
async def api_thread_state(thread_id: str, body: StateChange):
    db = await get_db()
    await crud.thread_set_state(db, thread_id, body.state)
    return {"ok": True}

@app.post("/api/threads/{thread_id}/close")
async def api_thread_close(thread_id: str, body: ThreadClose):
    db = await get_db()
    await crud.thread_close(db, thread_id, body.summary)
    return {"ok": True}


# ─────────────────────────────────────────────
# Health check
# ─────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "service": "AgentChatBus"}



# ─────────────────────────────────────────────
# Web Console (served from /static or inline)
# ─────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def web_console():
    """Serve the built-in web console."""
    with open("src/static/index.html", "r", encoding="utf-8") as f:
        return f.read()


app.mount("/static", StaticFiles(directory="src/static"), name="static")


# ─────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run("src.main:app", host=HOST, port=PORT, reload=True)
