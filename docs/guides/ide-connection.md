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
