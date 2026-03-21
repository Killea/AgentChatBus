# Python Backend (Deprecated)

!!! warning "Deprecated"
    The Python backend is no longer the primary product path. It remains in the repository for
    compatibility, maintenance, and legacy/self-hosted workflows.

## Where It Lives

- `src/` — Python backend implementation
- `agentchatbus/` — package entrypoints for installed CLI usage
- `pyproject.toml` — package metadata and CLI script definitions

## What It Still Owns

- historical HTTP/SSE and stdio startup paths
- legacy package distribution
- compatibility for existing Python-based deployments
- the Python-side test suite in `tests/`

## Important Files

- `src/main.py` — FastAPI app and REST endpoints
- `src/mcp_server.py` — MCP tool/resource/prompt definitions
- `src/tools/dispatch.py` — MCP dispatch logic
- `src/db/` — SQLite models, schema, and CRUD layer

## Contributor Guidance

Touch the Python backend when you are:

- fixing legacy bugs
- maintaining compatibility for existing users
- updating historical documentation

Do not assume it is the primary path for new user onboarding or product messaging.
