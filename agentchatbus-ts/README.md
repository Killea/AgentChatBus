# agentchatbus-ts

TypeScript backend implementation of AgentChatBus.

## Contents

- `src/` - Source code
  - `core/` - Core business logic and services
  - `adapters/mcp/` - MCP protocol implementation
  - `transports/` - HTTP and stdio transports
- `tests/` - Test suite (Vitest)
- `dist/` - Compiled output
- `EXTERNAL_SERVER_QUICKSTART.md` - How to run this backend as a standalone external Node server

## Usage

```bash
npm run build    # Compile TypeScript
npm run dev      # Start development server
npm test         # Run tests
```

## Cursor ACP Direct Mode

AgentChatBus includes a Cursor direct adapter that talks to `agent acp` over stdio JSON-RPC.
This path is intended for direct CLI-session execution inside the TypeScript backend, separate
from Cursor's MCP-over-SSE configuration.

### What it does

- starts Cursor with `agent acp`
- performs `initialize -> initialized -> authenticate(cursor_login) -> session/load|session/resume|session/new -> session/prompt`
- persists the returned session id in `AGENTCHATBUS_CURSOR_SESSION_ID` for later resume attempts
- records lightweight runtime state and parsed raw results for diagnostics
- handles ACP-side `session/request_permission`, `fs/read_text_file`, and `fs/write_text_file`
- treats `session/prompt` as an async turn trigger and consumes real progress from `session/update`
- maps ACP-native `agent_thought_chunk`, `plan`, `tool_call`, and `tool_call_update` into AgentChatBus activity cards
- resolves ACP filesystem requests relative to the active workspace root instead of the backend process cwd

### Prerequisites

- Cursor CLI available on `PATH`, or `cursorAgentCommand` configured to the CLI shim/binary
- a Cursor CLI build that supports `agent acp`
- a valid Cursor authentication state via `agent login`, `CURSOR_API_KEY`, or `CURSOR_AUTH_TOKEN`
- Node 20+ for the backend itself

### Validate your CLI

```bash
agent --version
agent acp
```

`agent acp` is expected to stay quiet after launch because it starts a stdio JSON-RPC server.
That silent startup is normal.

### Common failure modes

- `Cursor direct ACP launch failed ...`:
  - verify the configured command resolves correctly
  - on Windows, check whether the discovered `agent` shim is a PowerShell `.ps1` launcher
- `Cursor ACP did not return a session id from initialize/session methods.`:
  - the CLI likely does not support the expected ACP lifecycle or returned an incompatible payload
- timeout waiting for `initialize`, `session/resume`, `session/new`, or `session/prompt`:
  - confirm the CLI version supports ACP
  - inspect stderr/stdout excerpts and ignored non-JSON line counts in the captured raw result
- direct prompt rejected due to payload shape:
  - AgentChatBus first sends the ACP-style text content array for `session/prompt`
  - if the installed Cursor CLI expects the legacy string form, the backend retries automatically
- activity card looks incomplete:
  - Cursor direct mode now expects the primary runtime detail to arrive through `session/update`
  - if the CLI only returns a final response and does not emit `agent_thought_chunk` / `tool_call_update`, the card can only show the reduced state that Cursor exposed
- resume does not stick:
  - the backend prefers ACP `session/load` when the agent advertises `loadSession`
  - if load/resume fails, it falls back to `session/new`

### Test coverage

Relevant unit coverage lives in:

- `tests/unit/test_cursor_direct_adapter.test.ts`

It covers alias parsing, completion-event variants, error aggregation, ignored non-JSON output,
and persisted-session fallback.

## Copilot ACP Direct Mode

AgentChatBus also includes a Copilot direct adapter that talks to GitHub Copilot CLI over ACP stdio
using the public `copilot --acp --stdio` flow documented by GitHub.

### What it does

- starts Copilot CLI with `copilot --acp --stdio`
- performs `initialize -> newSession -> prompt`
- consumes streamed runtime detail from ACP `sessionUpdate` notifications
- auto-approves ACP permission prompts by selecting an allow-style option when available
- preserves the returned external session id in `AGENTCHATBUS_COPILOT_SESSION_ID`
- maps thinking, plan, tool-call, and assistant message updates into AgentChatBus activity cards

### Compatibility notes

- the implementation intentionally follows GitHub's public ACP documentation first
- it only attempts `loadSession` when the runtime explicitly advertises that capability
- it does not currently assume any undocumented Copilot-specific ACP extensions for model selection

### Relevant tests

- `tests/unit/test_copilot_direct_adapter.test.ts`

## Standalone External Server

If you want to run `agentchatbus-ts` as a standalone external backend for the VS Code extension or other clients, see:

- [EXTERNAL_SERVER_QUICKSTART.md](./EXTERNAL_SERVER_QUICKSTART.md)
