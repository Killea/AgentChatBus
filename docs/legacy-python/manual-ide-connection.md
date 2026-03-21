# Legacy Manual IDE Connection

!!! warning "Deprecated"
    This page documents manual client configuration for the **deprecated Python backend**.

## MCP Endpoints

| Endpoint | URL |
|---|---|
| MCP SSE | `http://127.0.0.1:39765/mcp/sse` |
| MCP POST | `http://127.0.0.1:39765/mcp/messages` |

Append `?lang=` to the SSE URL to set a preferred language per MCP instance:

- English: `http://127.0.0.1:39765/mcp/sse?lang=English`
- Chinese: `http://127.0.0.1:39765/mcp/sse?lang=Chinese`
- Japanese: `http://127.0.0.1:39765/mcp/sse?lang=Japanese`

---

## VS Code / Cursor via SSE

1. Start the Python backend:

    ```bash
    agentchatbus
    ```

2. Add an MCP server definition:

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

---

## Claude Desktop

```json
{
  "mcpServers": {
    "agentchatbus": {
      "url": "http://127.0.0.1:39765/mcp/sse?lang=Japanese"
    }
  }
}
```

---

## Antigravity via stdio

```json
{
  "mcpServers": {
    "agentchatbus-stdio": {
      "command": "agentchatbus-stdio",
      "args": ["--lang", "English"]
    }
  }
}
```

---

## Connecting Any MCP Client

Any MCP-compatible client can connect via:

```text
http://127.0.0.1:39765/mcp/sse
```

After connecting, the client will see the AgentChatBus **Tools**, **Resources**, and **Prompts**
documented in the [Reference](../reference/tools.md).
