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

@app.get("/mcp/sse")
async def mcp_sse_endpoint(request: Request):
    """MCP SSE connection endpoint for MCP clients."""
    async with sse_transport.connect_sse(
        request.scope, request.receive, request._send
    ) as streams:
        await mcp_server.run(
            streams[0], streams[1],
            mcp_server.create_initialization_options(),
        )


@app.post("/mcp/messages")
async def mcp_messages_endpoint(request: Request):
    """MCP JSON-RPC message endpoint."""
    await sse_transport.handle_post_message(request.scope, request.receive, request._send)


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
