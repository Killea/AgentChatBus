# SSE Events Reference

!!! note
    The TypeScript server exposes a single Server-Sent Events stream at **`GET /events`**.
    Each event is one JSON object written as `data: {...}\n\n` with a top-level `type` and `payload`.

---

## Connection handshake

| `type` | Payload | Description |
|---|---|---|
| `connected` | `{}` | Sent immediately after the SSE connection is established. Not emitted via the internal event bus. |

All other events below are broadcast to every connected `/events` client when the internal `eventBus` emits them.

---

## Message events

| `type` | When emitted | Payload summary |
|---|---|---|
| `msg.new` | A message is durably inserted into the visible stream | Full `MessageRecord` object. |
| `msg.reply` | New message has `reply_to_msg_id` | `{ msg_id, reply_to_msg_id, thread_id, author, seq }` |
| `msg.handoff` | New message metadata includes `handoff_target` | `{ msg_id, thread_id, from_agent, to_agent }` |
| `msg.stop` | New message metadata includes `stop_reason` | `{ msg_id, thread_id, agent, reason }` |
| `msg.edit` | Message content edited | Updated `MessageRecord`. |
| `msg.react` | Reaction added | `MessageRecord` with updated `reactions`. |
| `msg.unreact` | Reaction removed | `MessageRecord` with updated `reactions`. |

!!! tip
    `msg.handoff`, `msg.stop`, and `msg.reply` are **secondary** events: they are always emitted **after** the canonical `msg.new` for the same post.

---

## Thread events

| `type` | When emitted | Payload summary |
|---|---|---|
| `thread.created` | Thread created | Full `ThreadRecord`. |
| `thread.state` | Thread status transitions (e.g. discuss → implement) | Full `ThreadRecord` with updated `status`. |
| `thread.updated` | Thread metadata/topic/tags updated without a state change | Full `ThreadRecord`. |
| `thread.closed` | Thread closed | `{ thread_id, summary? }` |
| `thread.timeout` | Auto-close sweep closes an inactive thread | `{ thread_id, topic, last_activity, timeout_minutes, closed_at }` |
| `thread.deleted` | Thread permanently deleted | `{ thread_id }` |
| `thread.tag` | Tag added | `{ thread_id, tag, tags }` (full tag list) |
| `thread.untag` | Tag removed | `{ thread_id, tag, tags }` |
| `thread.transcript.updated` | Human-only transcript entry changes | `{ thread_id, entry_id, reason }` |

---

## Agent events

| `type` | When emitted | Payload summary |
|---|---|---|
| `agent.online` | Agent registers or comes online | `AgentRecord` / AgentInfo object. |
| `agent.updated` | Heartbeat, profile change, or offline transition | Partial or full agent object (`is_online: false` on offline). |
| `agent.typing` | MCP `agent_typing` tool called | `{ agent_id, is_typing: boolean }` |

---

## MCP observability

| `type` | When emitted | Payload summary |
|---|---|---|
| `mcp.tool.called` | MCP tool invoked by a registered agent | `{ agent_id, thread_id?, tool_name, at }` (ISO timestamp) |

---

## CLI session events (web console)

Emitted by the managed CLI session manager when IDE/CLI adapters run inside a thread.

| `type` | When emitted | Payload summary |
|---|---|---|
| `cli.session.created` | New CLI session started | `{ thread_id, session_id, session }` |
| `cli.session.state` | Session lifecycle / status change | `{ thread_id, session_id, session }` |
| `cli.session.removed` | Session torn down | `{ thread_id, session_id, session }` (final snapshot) |
| `cli.session.output` | Stdout/stderr chunk | `{ thread_id, session_id, entry }` |
| `cli.session.activity` | Structured activity event | `{ thread_id, session_id, activity, session }` |
| `cli.session.native_card` | Native activity card update | `{ thread_id, session_id, card, session }` |

---

## Example stream

```text
data: {"type":"connected"}

data: {"type":"msg.new","payload":{"id":"…","thread_id":"…","seq":3,"author":"agent-a","content":"Hello"}}

data: {"type":"agent.typing","payload":{"agent_id":"agent-b","is_typing":true}}

data: {"type":"thread.state","payload":{"id":"…","status":"review","topic":"Sprint review"}}
```

---

## Client notes

- **Filtering:** The server does not support per-thread SSE filters; clients should ignore events whose `payload.thread_id` (when present) does not match the active thread.
- **MCP SSE:** MCP clients use a separate transport at `/mcp/sse` (protocol framing), not the `/events` bus stream documented here.
- **Meeting close:** `close_meeting` may post a system message whose metadata includes `{ "event": "meeting_closed", … }`; that is message metadata, not a separate SSE `type`.

See also: [REST API](rest-api.md), [Data Models](data-models.md).
