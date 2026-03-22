# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AgentChatBus is a persistent local collaboration bus for AI agents. Multiple independent AI agents across IDEs, terminals, and frameworks can chat, collaborate, and delegate tasks via MCP (Model Context Protocol) and HTTP/SSE transports. The primary experience is the VS Code extension with a bundled TypeScript backend. The Python backend in `src/` is deprecated.

Default server address: `http://127.0.0.1:39765`

## Monorepo Structure

| Directory | What it is |
|---|---|
| `agentchatbus-ts/` | TypeScript backend (primary). Fastify HTTP, MCP protocol, SQLite via `node:sqlite`. Node ≥ 20, ES modules. |
| `vscode-agentchatbus/` | VS Code extension. Sidebar UI, chat panel, server lifecycle, MCP provider. CommonJS output. |
| `agentchatbus-server/` | Standalone Node.js server wrapper. Packages TS backend + web-ui for npm distribution. Node ≥ 22. |
| `web-ui/` | Shared web console (vanilla HTML/JS/CSS, Web Components with `acb-*` prefix). Copied into the extension at build time. |
| `frontend/` | Frontend test harness (Vitest + jsdom) for web-ui JS modules. |
| `src/` | Legacy Python backend (deprecated). FastAPI + aiosqlite. |
| `tests/` | Python test suite (pytest). |
| `shared-contracts/` | Contract/spec documents defining HTTP API, MCP tool fields, and parity test matrices. |
| `docs/` | MkDocs documentation site. |
| `scripts/` | Utility scripts: version bumping, restart, stop, release bundling. |

## Build & Test Commands

### TypeScript Backend (`agentchatbus-ts/`)
```bash
cd agentchatbus-ts
npm run build          # type-check + esbuild bundle
npm run check          # tsc --noEmit only
npm run dev            # run with tsx (HTTP mode)
npm run dev:stdio      # run with tsx (stdio mode)
npm test               # vitest run (all tests)
npx vitest run tests/unit/memoryStore.test.ts   # single test file
```

### VS Code Extension (`vscode-agentchatbus/`)
```bash
cd vscode-agentchatbus
npm run compile        # sync web-ui assets + type-check + esbuild bundle
npm run check          # tsc --noEmit only
npm test               # compile then node --test test/**/*.test.js
```

### Frontend Tests (`frontend/`)
```bash
cd frontend
npm test               # vitest (jsdom)
```

### Standalone Server (`agentchatbus-server/`)
```bash
cd agentchatbus-server
npm test               # prepare-package + smoke-test
```

### Python Backend (deprecated)
```bash
pip install -e ".[dev]"
pytest -q                              # all tests
pytest tests/test_msg_sync_unit.py -v  # single test file
ruff check .                           # lint (E9, F63, F7, F82 only)
```

### CI
GitHub Actions runs Python-only: ruff check + pytest on Python 3.11 (ubuntu-latest).

## Architecture

The system is layered:

1. **Transport Layer** — Two modes:
   - HTTP/SSE via Fastify (`agentchatbus-ts/src/transports/http/server.ts`) — REST API + SSE event streaming + legacy SSE MCP transport
   - Stdio via MCP SDK (`agentchatbus-ts/src/transports/stdio/server.ts`)
   - Streamable HTTP MCP (`agentchatbus-ts/src/transports/mcp/streamableHttp.ts`)

2. **MCP Protocol Layer** — Tool definitions and dispatch in `agentchatbus-ts/src/adapters/mcp/tools.ts`. Handlers in `agentchatbus-ts/src/transports/mcp/handlers.ts`. Core tools: `bus_connect`, `msg_wait`, `msg_post`, `thread_create`, etc.

3. **Core Services** (`agentchatbus-ts/src/core/`):
   - `services/memoryStore.ts` — Central data store. SQLite (DatabaseSync from `node:sqlite`). Manages threads, messages, agents, reply tokens, rate limiting, FTS5 search. Uses `AsyncEvent` for `msg_wait` blocking.
   - `config/registry.ts` — Typed configuration system with env vars and persisted config.
   - `types/models.ts` — Core data types (ThreadRecord, MessageRecord, AgentRecord, SyncContext).
   - `types/errors.ts` — Typed error hierarchy (BusError, SeqMismatchError, ReplyTokenExpiredError).

4. **VS Code Extension** (`vscode-agentchatbus/src/extension.ts`):
   - `BusServerManager` — auto-starts bundled TS backend or detects external instance.
   - `ChatPanel` — webview-based chat UI.
   - Registers MCP server definition provider, tree data providers for threads/agents/settings/logs.
   - `CursorMcpConfigManager` — configures Cursor IDE to use the same MCP endpoint.

5. **Web UI** — Vanilla JS with Web Components (`acb-*` custom elements). Shared modules: `shared-api.js`, `shared-chat.js`, `shared-sse.js`, `shared-threads.js`. Copied into extension resources at build time.

**Data flow**: MCP clients → Transport layer → MCP handlers → MemoryStore (SQLite) → EventBus → SSE fan-out to web console / extension UI.

## Message Sync Mechanism

`msg_post` requires strict synchronization:
- `expected_last_seq` — the caller's last known sequence number
- `reply_token` — obtained from `msg_wait` or `bus_connect`

`msg_wait` returns immediately when the agent is behind (has unseen messages) or after a failed `msg_post` (one-time recovery). Otherwise it blocks until new messages arrive or timeout.

## Key Conventions

- TypeScript backend uses strict mode, ES2022 target, NodeNext module resolution.
- VS Code extension outputs CommonJS (ES2022 target).
- Commit messages: concise imperative style (`add msg.wait timeout validation`, `fix reply token lease edge case`).
- Thread lifecycle: discuss → implement → review → done → closed → archived.
- Python lint rules are intentionally minimal (high-signal errors only).
- The `web-ui/` directory is the source of truth; it gets copied into `vscode-agentchatbus/resources/web-ui/` during extension build.
