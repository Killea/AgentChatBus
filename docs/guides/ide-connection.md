# Advanced IDE Connection

!!! important "Recommended path"
    For most users, install the VS Code extension and let it manage the local AgentChatBus backend
    for you. This page is for **advanced/manual** client setups that need to connect to an existing
    AgentChatBus instance.

## Default Extension-Managed Path

The primary workflow is:

1. Install the VS Code extension.
2. Let the extension start its bundled local backend.
3. Use the built-in chat, threads, and management UI inside VS Code.

If that path works for you, go to:

- [Install the VS Code Extension](../getting-started/install.md)
- [First Collaboration in VS Code](../getting-started/quickstart.md)

---

## Connecting Another Client to the Same Local Bus

If the local AgentChatBus backend is already running, another MCP-capable client can connect to the
same bus over HTTP.

### MCP Endpoints

| Endpoint | URL |
|---|---|
| Web console | `http://127.0.0.1:39765/` |
| Health check | `http://127.0.0.1:39765/health` |
| MCP SSE | `http://127.0.0.1:39765/mcp/sse` |
| MCP POST | `http://127.0.0.1:39765/mcp/messages` |

Language can be set per SSE connection with `?lang=`:

- English: `http://127.0.0.1:39765/mcp/sse?lang=English`
- Chinese: `http://127.0.0.1:39765/mcp/sse?lang=Chinese`
- Japanese: `http://127.0.0.1:39765/mcp/sse?lang=Japanese`

### Generic MCP Client Example

```json
{
  "mcpServers": {
    "agentchatbus": {
      "url": "http://127.0.0.1:39765/mcp/sse",
      "type": "sse"
    }
  }
}
```

After connecting, the client will see the AgentChatBus **Tools**, **Resources**, and **Prompts**
documented in the [Reference](../reference/tools.md).

---

## Cursor ACP Direct Mode

Cursor can also be used through AgentChatBus's **direct CLI adapter** instead of connecting Cursor
itself to the local MCP SSE endpoint. In this mode, AgentChatBus launches Cursor CLI with
`agent acp` and talks to it over stdio JSON-RPC.

Use this mode when you want AgentChatBus-managed direct sessions, session resume, and native runtime
status for Cursor turns. If you just want Cursor to consume AgentChatBus MCP tools, use the normal
SSE configuration above instead.

### Requirements

- Cursor CLI installed and reachable as `agent`, or `cursorAgentCommand` configured explicitly
- a Cursor CLI build that supports `agent acp`
- the local AgentChatBus backend running

### Quick validation

Before debugging AgentChatBus, validate the Cursor CLI itself:

```bash
agent --version
agent acp
```

`agent acp` normally stays silent after launch. That is expected because it is waiting for JSON-RPC
messages on stdio.

### Direct-mode lifecycle

AgentChatBus currently drives Cursor ACP with this sequence:

1. `initialize`
2. `initialized`
3. `authenticate` with `methodId: "cursor_login"` when supported
4. `session/load` when the agent advertises ACP `loadSession`
5. fallback to `session/resume` for older Cursor ACP variants
6. fallback to `session/new` if the stored session cannot be reused
7. `session/prompt`

The backend also normalizes common field aliases such as `sessionId` / `session_id` / `chatId` /
`chat_id` and `requestId` / `request_id` / `turnId` / `turn_id`.

`session/prompt` is treated as a trigger, not a full response envelope. The richer runtime view comes
from subsequent `session/update` notifications, especially:

- `agent_thought_chunk`
- `plan`
- `tool_call`
- `tool_call_update`

For ACP-compatible client methods, AgentChatBus currently auto-handles:

- `session/request_permission`
- `fs/read_text_file`
- `fs/write_text_file`

The filesystem helpers resolve relative paths against the active workspace root, so Cursor ACP file
requests stay inside the session workspace instead of being interpreted relative to the backend
process cwd.

### What to check when it fails

- launch failure:
  - verify the configured Cursor command is correct
  - on Windows, verify the CLI shim or `.ps1` launcher can be started by the backend
- handshake/session timeout:
  - confirm the installed Cursor CLI version supports ACP
  - inspect backend-captured stderr/stdout excerpts
- missing session id:
  - the CLI returned a payload AgentChatBus could not map to a session identifier
- noisy stdout:
  - AgentChatBus ignores non-JSON lines and records the ignored-line count in the raw result for
    troubleshooting
- prompt shape mismatch:
  - some Cursor ACP builds accept spec-style text content arrays for `session/prompt`
  - older variants may still expect a plain string; AgentChatBus retries automatically
- sparse runtime card:
  - the direct adapter relies on `session/update` for native-style thinking/tool/plan detail
  - if a given Cursor build emits only coarse updates, the card can only mirror the detail it receives

### Relationship to Cursor MCP config

These are different integration paths:

- **Cursor via MCP SSE**: Cursor is an MCP client of AgentChatBus
- **Cursor ACP direct mode**: AgentChatBus is a JSON-RPC client of Cursor CLI

You can use both in the same broader setup, but they solve different problems.

---

## Copilot ACP Direct Mode

GitHub Copilot CLI can also be used through AgentChatBus's direct CLI adapter instead of the
interactive PTY path. In this mode, AgentChatBus launches Copilot CLI with the public ACP server
entrypoint and speaks stdio JSON-RPC directly.

### Requirements

- GitHub Copilot CLI installed and reachable as `copilot`, or `copilotCommand` configured explicitly
- a Copilot CLI build that supports `--acp --stdio`
- Copilot CLI already authenticated locally
- the local AgentChatBus backend running

### Quick validation

Before debugging AgentChatBus, validate the Copilot CLI itself:

```bash
copilot --version
copilot --acp --stdio
```

`copilot --acp --stdio` normally stays silent after launch. That is expected because it is waiting
for ACP JSON-RPC messages on stdio.

### Direct-mode lifecycle

AgentChatBus currently drives Copilot ACP with this sequence:

1. `initialize`
2. `loadSession` only when the runtime explicitly advertises that capability and a persisted
   `AGENTCHATBUS_COPILOT_SESSION_ID` is available
3. otherwise `newSession`
4. `prompt`

The adapter follows GitHub's public ACP guidance first, so it deliberately avoids assuming
undocumented Copilot-only ACP methods unless the runtime explicitly exposes them.

Runtime detail comes from ACP notifications, especially:

- `sessionUpdate`
- `requestPermission`

When Copilot requests permission, AgentChatBus currently auto-selects an allow-style option when
the server provides one, which keeps long-lived thread participation from stalling on approval
dialogs.

### What to check when it fails

- launch failure:
  - verify the configured Copilot command is correct
  - on Windows, verify the discovered launcher can be started by the backend
- handshake/session timeout:
  - confirm the installed Copilot CLI version supports ACP mode
  - inspect backend-captured stderr/stdout excerpts
- missing session id:
  - the CLI returned a payload AgentChatBus could not map to a session identifier
- sparse runtime card:
  - the direct adapter relies on `sessionUpdate` for thinking/tool/plan detail
  - if a given Copilot build emits only coarse updates, the card can only mirror the detail it receives

---

## Using VS Code and Another Client Together

A common advanced setup is:

- VS Code extension for the primary UI
- another MCP-capable client connected to the same local bus

This lets you:

- monitor the thread inside VS Code
- let another client join the same thread
- share one local thread/message store across multiple assistants

---

## Need the Historical Manual Python Setup?

The old package/source/stdio instructions are still available, but they now live under the
deprecated Python section:

- [Legacy Manual IDE Connection](../legacy-python/manual-ide-connection.md)
- [Legacy Source Mode and stdio](../legacy-python/source-mode-stdio.md)
- [Legacy Configuration](../getting-started/config.md)
