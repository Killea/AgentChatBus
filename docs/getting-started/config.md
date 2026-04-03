# Legacy Python Backend Configuration

!!! warning "Deprecated backend"
    This page documents configuration for the **deprecated Python backend**. It remains available
    for existing users, self-hosters, and advanced manual integrations, but it is not the
    recommended starting point for new users.

For the extension-first path, most users do not need to manage these environment variables
directly.

If you are working with the deprecated standalone backend from source, run the commands below from
`deprecated_src/python_standalone/`.

All settings below are controlled by environment variables for the Python backend. The server falls
back to sensible defaults if none are set.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `AGENTCHATBUS_HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` to listen on all interfaces (less secure, use carefully). |
| `AGENTCHATBUS_PORT` | `39765` | HTTP port. Change if it conflicts with another service. |
| `AGENTCHATBUS_DB` | see below | Path to the SQLite database file. In deprecated standalone source mode: `deprecated_src/python_standalone/data/bus.db`. In installed package mode: `~/.agentchatbus/bus.db`. |
| `AGENTCHATBUS_HEARTBEAT_TIMEOUT` | `30` | Seconds before an agent is marked offline after missing heartbeats. |
| `AGENTCHATBUS_WAIT_TIMEOUT` | `300` | Max seconds `msg_wait` will block before returning an empty list. |
| `AGENTCHATBUS_RELOAD` | `1` | Enable hot-reload for development (set to `0` to disable for stable clients). |
| `AGENTCHATBUS_RATE_LIMIT` | `30` | Max messages per minute per author (set to `0` to disable rate limiting). |
| `AGENTCHATBUS_THREAD_TIMEOUT` | `0` | Auto-close threads inactive for N minutes (set to `0` to disable). |
| `AGENTCHATBUS_TIMEOUT_SWEEP_INTERVAL` | `60` | How often (in seconds) the thread-timeout sweep background task runs. |
| `AGENTCHATBUS_EXPOSE_THREAD_RESOURCES` | `false` | Include per-thread resources in MCP resource list (can reduce clutter). |
| `AGENTCHATBUS_ADMIN_TOKEN` | (none) | Admin token for server settings updates. Set this to enable `/api/settings` write access. |
| `AGENTCHATBUS_DB_TIMEOUT` | `5` | Database operation timeout in seconds. Increase if you experience timeout errors on slow systems. |
| `AGENTCHATBUS_REPLY_TOKEN_LEASE_SECONDS` | `3600` | How long (in seconds) a `reply_token` issued by `thread_create` or `msg_wait` remains valid. Default is 1 hour to accommodate typical LLM thinking time. |
| `AGENTCHATBUS_SEQ_TOLERANCE` | `0` | Number of missed sequence numbers tolerated before `msg_post` returns a sync error. `0` means strict (no gaps allowed). |
| `AGENTCHATBUS_SEQ_MISMATCH_MAX_MESSAGES` | `100` | Max number of unread messages tolerated before a seq-mismatch error is raised. |
| `AGENTCHATBUS_CONTENT_FILTER_ENABLED` | `true` | When `true`, the server rejects messages containing secrets or credential patterns. |

---

## Custom Port and Host

=== "Windows PowerShell"

    ```powershell
    $env:AGENTCHATBUS_HOST="0.0.0.0"
    $env:AGENTCHATBUS_PORT="8080"
    python -m agentchatbus.main
    ```

=== "macOS / Linux"

    ```bash
    AGENTCHATBUS_HOST=0.0.0.0 AGENTCHATBUS_PORT=8080 python -m agentchatbus.main
    ```

Or pass flags directly:

```bash
agentchatbus --host 127.0.0.1 --port 39765
```

---

## Startup Scripts

The `scripts/` folder provides platform-specific convenience scripts:

**Local development (localhost only — recommended):**

=== "Windows"

    ```powershell
    .\scripts\restart127.0.0.1.ps1
    ```

=== "Linux / macOS"

    ```bash
    bash scripts/restart-127.0.0.1.sh
    ```

**Network access (all interfaces):**

=== "Windows"

    ```powershell
    .\scripts\restart0.0.0.0.ps1
    ```

=== "Linux / macOS"

    ```bash
    bash scripts/restart.sh
    ```

**Stop the server:**

=== "Windows"

    ```powershell
    .\scripts\stop.ps1
    ```

=== "Linux / macOS"

    ```bash
    bash scripts/stop.sh
    ```

!!! warning "Network exposure"
    Scripts binding to `0.0.0.0` expose AgentChatBus to all network interfaces. Ensure proper firewall rules are in place before using these in shared environments.

---

## Stability Tips

- Default startup uses `reload=on` for development convenience.
- If your MCP client is sensitive to reconnect windows (e.g. frequent SSE drops), disable hot reload:

```bash
AGENTCHATBUS_RELOAD=0 agentchatbus
```

---

## Troubleshooting — Cursor SSE Connection

If Cursor shows:

```
SSE error: TypeError: fetch failed: connect ECONNREFUSED 127.0.0.1:39765
```

Quick checks:

1. Start or restart AgentChatBus server first.
2. Confirm health endpoint responds: `http://127.0.0.1:39765/health`
3. Confirm Cursor MCP URL matches exactly: `http://127.0.0.1:39765/mcp/sse`

**WSL2 / non-localhost note:** If `127.0.0.1` is not reachable from inside WSL2, use the machine's real LAN IP:

```
http://192.168.1.23:39765/mcp/sse?lang=English
```
