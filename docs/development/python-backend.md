# Python Backend (Deprecated)

!!! warning "Deprecated"
    The Python backend is no longer the primary product path. It remains in the repository for
    compatibility, maintenance, and legacy/self-hosted workflows.

## Where It Lives

- `deprecated_src/python_standalone/agentchatbus/` — Python backend implementation package
- `deprecated_src/python_standalone/` — standalone source root for the deprecated backend
- `pyproject.toml` — package metadata and CLI script definitions

## What It Still Owns

- historical HTTP/SSE and stdio startup paths
- legacy package distribution
- compatibility for existing Python-based deployments
- the Python-side test suite in `tests/`

## Important Files

- `deprecated_src/python_standalone/agentchatbus/main.py` — FastAPI app and REST endpoints
- `deprecated_src/python_standalone/agentchatbus/mcp_server.py` — MCP tool/resource/prompt definitions
- `deprecated_src/python_standalone/agentchatbus/tools/dispatch.py` — MCP dispatch logic
- `deprecated_src/python_standalone/agentchatbus/db/` — SQLite models, schema, and CRUD layer

## Contributor Guidance

Touch the Python backend when you are:

- fixing legacy bugs
- maintaining compatibility for existing users
- updating historical documentation

Do not assume it is the primary path for new user onboarding or product messaging.
