import { describe, expect, it } from "vitest";
import {
  buildCodexDirectElicitationResponse,
  buildCodexDirectActivityFromItem,
  parseCodexDirectAppServerResult,
} from "../../src/core/services/adapters/codexDirectAdapter.js";

describe("parseCodexDirectAppServerResult", () => {
  it("normalizes structured MCP and file-change items into chat activity events", () => {
    const toolActivity = buildCodexDirectActivityFromItem({
      id: "tool-1",
      type: "mcpToolCall",
      status: "inProgress",
      server: "agentchatbus",
      tool: "bus_connect",
    }, "turn-1");
    const fileActivity = buildCodexDirectActivityFromItem({
      id: "patch-1",
      type: "fileChange",
      status: "completed",
      changes: [
        {
          path: "src/app.ts",
          diff: "@@ -1 +1 @@",
          kind: { type: "update" },
        },
      ],
    }, "turn-1");

    expect(toolActivity).toMatchObject({
      turn_id: "turn-1",
      item_id: "tool-1",
      kind: "mcp_tool_call",
      status: "in_progress",
      label: "Using tool",
      server: "agentchatbus",
      tool: "bus_connect",
    });
    expect(fileActivity).toMatchObject({
      turn_id: "turn-1",
      item_id: "patch-1",
      kind: "file_change",
      status: "completed",
      label: "Editing files",
      files: [
        {
          path: "src/app.ts",
          change_type: "update",
        },
      ],
    });
    expect(fileActivity?.diff).toContain("@@ -1 +1 @@");
  });

  it("extracts thread and turn ids while aggregating streamed agent message deltas", () => {
    const result = parseCodexDirectAppServerResult([
      "{\"id\":\"1\",\"result\":{\"threadId\":\"thread-42\"}}",
      "{\"id\":\"2\",\"result\":{\"turnId\":\"turn-7\"}}",
      "{\"method\":\"thread/started\",\"params\":{\"threadId\":\"thread-42\"}}",
      "{\"method\":\"turn/started\",\"params\":{\"threadId\":\"thread-42\",\"turnId\":\"turn-7\"}}",
      "{\"method\":\"item/agentMessage/delta\",\"params\":{\"itemId\":\"msg-1\",\"delta\":\"Hello\"}}",
      "{\"method\":\"item/agentMessage/delta\",\"params\":{\"itemId\":\"msg-1\",\"delta\":\" world\"}}",
      "{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"thread-42\",\"turnId\":\"turn-7\",\"turn\":{\"status\":\"completed\"}}}",
    ].join("\n"));

    expect(result.threadId).toBe("thread-42");
    expect(result.turnId).toBe("turn-7");
    expect(result.resultText).toBe("Helloworld");
    expect(result.rawResult).toMatchObject({
      thread_id: "thread-42",
      turn_id: "turn-7",
      last_agent_message: "Helloworld",
      errors: [],
      ignored_line_count: 0,
    });
  });

  it("prefers the completed item text when the full agent message arrives after deltas", () => {
    const result = parseCodexDirectAppServerResult([
      "{\"method\":\"thread/started\",\"params\":{\"threadId\":\"thread-84\"}}",
      "{\"method\":\"turn/started\",\"params\":{\"threadId\":\"thread-84\",\"turnId\":\"turn-9\"}}",
      "{\"method\":\"item/agentMessage/delta\",\"params\":{\"itemId\":\"msg-2\",\"delta\":\"Part\"}}",
      "{\"method\":\"item/agentMessage/delta\",\"params\":{\"itemId\":\"msg-2\",\"delta\":\"ial\"}}",
      "{\"method\":\"item/completed\",\"params\":{\"item\":{\"id\":\"msg-2\",\"type\":\"agentMessage\",\"text\":\"Partial answer, finalized.\"}}}",
    ].join("\n"));

    expect(result.threadId).toBe("thread-84");
    expect(result.turnId).toBe("turn-9");
    expect(result.resultText).toBe("Partial answer, finalized.");
    expect(result.rawResult).toMatchObject({
      last_agent_message: "Partial answer, finalized.",
      errors: [],
    });
  });

  it("understands codex/event aliases for conversation lifecycle and agent message streaming", () => {
    const result = parseCodexDirectAppServerResult([
      "{\"method\":\"codex/event/task_started\",\"params\":{\"conversationId\":\"thread-200\",\"turnId\":\"turn-4\"}}",
      "{\"method\":\"codex/event/agent_message_delta\",\"params\":{\"conversationId\":\"thread-200\",\"turnId\":\"turn-4\",\"delta\":\"Native\"}}",
      "{\"method\":\"codex/event/agent_message_delta\",\"params\":{\"conversationId\":\"thread-200\",\"turnId\":\"turn-4\",\"delta\":\" card\"}}",
      "{\"method\":\"codex/event/task_complete\",\"params\":{\"conversationId\":\"thread-200\",\"turnId\":\"turn-4\"}}",
    ].join("\n"));

    expect(result.threadId).toBe("thread-200");
    expect(result.turnId).toBe("turn-4");
    expect(result.resultText).toBe("Nativecard");
    expect(result.rawResult).toMatchObject({
      thread_id: "thread-200",
      turn_id: "turn-4",
      turn_status: null,
      last_agent_message: "Nativecard",
      errors: [],
    });
  });

  it("does not treat codex/event/task_complete as the authoritative completed signal", () => {
    const result = parseCodexDirectAppServerResult([
      "{\"method\":\"codex/event/task_started\",\"params\":{\"conversationId\":\"thread-201\",\"turnId\":\"turn-5\"}}",
      "{\"method\":\"codex/event/agent_message_delta\",\"params\":{\"conversationId\":\"thread-201\",\"turnId\":\"turn-5\",\"delta\":\"Still\"}}",
      "{\"method\":\"codex/event/task_complete\",\"params\":{\"conversationId\":\"thread-201\",\"turnId\":\"turn-5\",\"summary\":\"Task stage finished\"}}",
    ].join("\n"));

    expect(result.threadId).toBe("thread-201");
    expect(result.turnId).toBe("turn-5");
    expect(result.resultText).toBe("Still");
    expect(result.rawResult).toMatchObject({
      thread_id: "thread-201",
      turn_id: "turn-5",
      turn_status: null,
      last_agent_message: "Still",
      errors: [],
    });
  });

  it("still captures an explicit task_complete failure without waiting for turn/completed", () => {
    const result = parseCodexDirectAppServerResult([
      "{\"method\":\"codex/event/task_started\",\"params\":{\"conversationId\":\"thread-202\",\"turnId\":\"turn-6\"}}",
      "{\"method\":\"codex/event/task_complete\",\"params\":{\"conversationId\":\"thread-202\",\"turnId\":\"turn-6\",\"success\":false,\"error\":{\"message\":\"approval denied\"}}}",
    ].join("\n"));

    expect(result.threadId).toBe("thread-202");
    expect(result.turnId).toBe("turn-6");
    expect(result.rawResult).toMatchObject({
      thread_id: "thread-202",
      turn_id: "turn-6",
      turn_status: "failed",
      last_error: "approval denied",
    });
  });

  it("retains error notifications and ignores malformed lines", () => {
    const result = parseCodexDirectAppServerResult([
      "{\"method\":\"thread/started\",\"params\":{\"threadId\":\"thread-99\"}}",
      "{\"method\":\"error\",\"params\":{\"error\":{\"message\":\"approval required\"}}}",
      "{\"id\":\"3\",\"error\":{\"message\":\"turn/start failed\",\"code\":-32001}}",
      "not-json",
    ].join("\n"));

    expect(result.threadId).toBe("thread-99");
    expect(result.resultText).toBe("");
    expect(result.rawResult).toMatchObject({
      thread_id: "thread-99",
      last_agent_message: null,
      errors: ["approval required", "turn/start failed\ncode: -32001"],
      ignored_line_count: 1,
    });
  });

  it("captures failed turn status and nested Codex error details", () => {
    const result = parseCodexDirectAppServerResult([
      "{\"method\":\"thread/started\",\"params\":{\"threadId\":\"thread-13\"}}",
      "{\"method\":\"turn/started\",\"params\":{\"threadId\":\"thread-13\",\"turnId\":\"turn-2\"}}",
      "{\"method\":\"error\",\"params\":{\"error\":{\"message\":\"Reconnecting... 1/5\",\"codexErrorInfo\":{\"httpStatusCode\":401,\"additionalDetails\":\"unexpected status 401 Unauthorized: Encountered invalidated oauth token for user, failing request, url: https://api2.tabcode.cc/openai/responses\",\"type\":\"api_error\"}}}}",
      "{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"thread-13\",\"turnId\":\"turn-2\",\"turn\":{\"status\":\"failed\",\"error\":{\"message\":\"We're currently experiencing high demand, which may cause temporary errors.\",\"codexErrorInfo\":{\"httpStatusCode\":401,\"additionalDetails\":\"unexpected status 401 Unauthorized: Encountered invalidated oauth token for user, failing request, url: https://api2.tabcode.cc/openai/responses\",\"type\":\"api_error\"}}}}}",
    ].join("\n"));

    expect(result.threadId).toBe("thread-13");
    expect(result.turnId).toBe("turn-2");
    expect(result.rawResult).toMatchObject({
      thread_id: "thread-13",
      turn_id: "turn-2",
      turn_status: "failed",
      last_error: expect.stringContaining("high demand"),
      error_count: 2,
    });

    const errors = Array.isArray(result.rawResult?.errors)
      ? result.rawResult.errors.map((entry) => String(entry))
      : [];
    expect(errors.some((entry) => entry.includes("HTTP status: 401"))).toBe(true);
    expect(errors.some((entry) => entry.includes("details: unexpected status 401 Unauthorized"))).toBe(true);
    expect(errors.some((entry) => entry.includes("type: api_error"))).toBe(true);
    expect(errors.some((entry) => entry.includes("We're currently experiencing high demand"))).toBe(true);
  });

  it("builds an auto-accept response for form-based MCP elicitations", () => {
    const response = buildCodexDirectElicitationResponse({
      serverName: "AgentChatBus",
      mode: "form",
      message: "Approve calling bus_connect?",
      requestedSchema: {
        type: "object",
        properties: {
          approved: { type: "boolean" },
          tool_name: { type: "string", enum: ["bus_connect", "msg_post"] },
          reason: { type: "string", minLength: 3 },
          retries: { type: "integer", minimum: 1 },
        },
        required: ["approved", "tool_name"],
      },
    });

    expect(response.action).toBe("accept");
    expect(response.summary).toContain("Auto-accepted MCP elicitation");
    expect(response.content).toEqual({
      approved: true,
      tool_name: "bus_connect",
      reason: "yes",
      retries: 1,
    });
  });
});
