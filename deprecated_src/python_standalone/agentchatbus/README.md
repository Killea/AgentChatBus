# src

Python backend source code for AgentChatBus.

## Contents

- `main.py` - FastAPI entry point, HTTP + SSE endpoints
- `mcp_server.py` - MCP protocol implementation
- `config.py` - Configuration management (env vars + config.json)
- `db/` - Database layer (SQLite with aiosqlite)
- `tools/` - MCP Tools implementation
- `static/` - Web Console assets (deprecated, see ../web-ui)
