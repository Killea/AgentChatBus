# bus_connect / msg_wait Flow Matrix (Planned V3.1)

## Scope
This document defines the **planned target behavior**:
- Every `bus_connect` call returns a sync context: `current_seq`, `reply_token`, `reply_window`.
- If client ignores that token and still calls `msg_wait`, server should **return immediately** (no long wait) when a valid unused `bus_connect` token is present.
- Outside this fast-return condition, `msg_wait` keeps normal long-poll semantics.

## Decision Priority (Authoritative)

`msg_wait` must use this exact priority order to avoid ambiguous behavior:

1. `new_messages` available for current wait scope -> return messages immediately.
2. `bus_connect_token_pending` -> immediate sync-only return (empty `messages`).
3. `no_issued_token` (`wants_sync_only`) -> immediate sync-only return (empty `messages`).
4. otherwise -> enter normal long-poll wait until message arrival or timeout.

This prevents empty fast-return from masking real pending messages.

## Comparison: First Connect vs Non-First Connect

| Scenario | Thread Created by This `bus_connect`? | `bus_connect` Returns Sync Context? | Recommended Next Step | Server Intent |
|---|---|---|---|---|
| First connect to topic (thread auto-created) | Yes | Yes (`bus_connect` token) | Client may post directly; if it calls `msg_wait`, server fast-returns | Reduce first-turn latency and LLM cognitive load |
| Non-first connect (thread already exists) | No | Yes (`bus_connect` token) | Client may post directly; if it calls `msg_wait`, server fast-returns while token remains valid/unused | Same low-cognitive-load flow for all joins |

## `msg_wait` Behavior Matrix (Planned)

| Condition | Immediate Return? | What `msg_wait` Returns | Notes |
|---|---|---|---|
| Valid unused `bus_connect` token exists for this `(thread_id, agent_id)` | Yes | Empty `messages` + fresh sync context | Client miscalled `msg_wait`; server absorbs mistake |
| No issued token for this agent in this thread | Yes | Empty `messages` + fresh sync context | Existing `wants_sync_only` behavior |
| New messages already exist and no `for_agent` filter | Usually yes | New messages + fresh sync context | Normal polling wake-up |
| `for_agent` is set and matching message exists | Usually yes | Filtered matching messages + fresh sync context | Directed handoff wake-up |
| `for_agent` is set, only non-matching messages exist | No immediate return | Keep waiting; timeout or match | Do not wake on irrelevant traffic |
| None of the above | No | Wait until timeout, then empty `messages` + fresh sync context | Standard long-poll behavior |

## Token Validity Definition

For this document, a token is considered `valid unused bus_connect token` only when all conditions are true:

1. `status='issued'`
2. `source='bus_connect'`
3. `thread_id` and `agent_id` both match current request
4. token not already marked fast-return-consumed (if one-time fast-return state exists)

## When Fast Return Happens

| Trigger | Timing | Typical Latency |
|---|---|---|
| `bus_connect` token fast-return check | Before wait loop | Milliseconds |
| No-issued-token check | Before wait loop | Milliseconds |
| Message arrival check | During poll loop | Usually sub-second |
| Timeout | After `timeout_ms` | Approximately `timeout_ms` |

## Error / Timeout Matrix

| Operation | Case | Planned Result |
|---|---|---|
| `bus_connect` | Missing `thread_name` | Return error: `thread_name is required` |
| `msg_wait` | Missing required fields (`thread_id`/`after_seq`) | Request/tool validation error |
| `msg_wait` | Valid unused `bus_connect` token exists | Immediate return; empty `messages` + fresh sync context |
| `msg_wait` | No new messages and not in fast-return branches | Long wait until timeout; return empty `messages` + sync context |
| `msg_post` | Missing `expected_last_seq`/`reply_token` | Reject with missing-sync-fields error |
| `msg_post` | Token replay/invalid/stale seq | Reject with token/seq mismatch class error |

## Server-State Rules (Implementation Contract)

| Rule ID | Rule |
|---|---|
| R1 | `bus_connect` always issues sync context for the current `(thread_id, agent_id)`. |
| R2 | Reply tokens carry a source marker (for example `source=bus_connect|msg_wait|thread_create`) so fast-return can be scoped safely. |
| R3 | `msg_wait` checks `new_messages` first, then checks for valid unused `source=bus_connect` token; if found, return immediately without entering long wait. |
| R4 | Fast-return must be one-time per bus-connect token. After first fast-return and/or first successful `msg_post`, that token can no longer trigger fast-return. |
| R5 | Normal long-poll semantics remain unchanged when no valid unused bus-connect token exists. |
| R6 | On new `bus_connect`, server should invalidate previous `source=bus_connect` issued token(s) for same `(thread_id, agent_id)` before issuing a new one. |

## Schema Requirements

Minimum schema updates required for implementability:

1. `reply_tokens.source` (TEXT) with allowed values: `bus_connect`, `msg_wait`, `thread_create`.
2. Optional but recommended: `reply_tokens.fast_returned_at` (TEXT nullable) to enforce one-time fast-return cleanly.

If `fast_returned_at` is not added, equivalent one-time fast-return state must still exist in persistent storage.

## Suggested Acceptance Tests

| Test Case | Expected Result |
|---|---|
| First `bus_connect` creates thread | Response includes `current_seq` + `reply_token` + `reply_window` |
| Non-first `bus_connect` joins existing thread | Response also includes `current_seq` + `reply_token` + `reply_window` |
| Any connect, client directly `msg_post` with bus_connect token | Post succeeds |
| Any connect, client ignores bus_connect token and calls `msg_wait` | `msg_wait` immediate return (ms-level), no long wait |
| After token is consumed/invalidated, `msg_wait` with no new messages | Follows normal wait/timeout behavior |
| New messages exist and bus_connect token is pending | `msg_wait` returns messages first (not empty fast-return) |
| Same pending bus_connect token, two consecutive `msg_wait` calls | First call fast-returns; second call follows normal behavior |
| Reconnect with new `bus_connect` on same thread/agent | Old bus_connect token no longer triggers fast-return |

## Error Semantics Clarification

| Case | Required Behavior |
|---|---|
| `msg_wait` with invalid `agent_id/token` | Must return explicit auth error or explicit degraded-mode response; behavior must be documented and test-covered |
| Unknown `thread_id` | Must return explicit not-found/invalid-thread error (not implicit DB failure path) |

## Rollout Notes

| Topic | Recommendation |
|---|---|
| Backward compatibility | Treat as behavior change; update README and tool docs together |
| Client simplicity | Keep SDK/client flow simple: prefer `bus_connect` token directly; `msg_wait` fallback remains safe and immediate when token is unused |
| Observability | Log reason for `msg_wait` immediate return (`bus_connect_token_pending` vs `no_issued_token`) |
