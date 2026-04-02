import { describe, expect, it } from "vitest";
import {
  collectClaudeDirectStream,
  parseClaudeDirectResult,
} from "../../src/core/services/adapters/claudeDirectAdapter.js";

describe("parseClaudeDirectResult", () => {
  it("extracts Claude resume session id and final text from stream-json events", () => {
    const result = parseClaudeDirectResult([
      "{\"type\":\"session.started\",\"session_id\":\"claude-session-1\",\"request_id\":\"req-claude-1\"}",
      "{\"type\":\"message_start\",\"message\":{\"id\":\"msg-1\"}}",
      "{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\"}}",
      "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}",
      "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" world\"}}",
      "{\"type\":\"message_stop\"}",
    ].join("\n"));

    expect(result.sessionId).toBe("claude-session-1");
    expect(result.requestId).toBe("req-claude-1");
    expect(result.resultText).toBe("Hello world");
    expect(result.rawResult).toMatchObject({
      session_id: "claude-session-1",
      request_id: "req-claude-1",
      event_count: 6,
      errors: [],
      ignored_line_count: 0,
    });
  });

  it("uses explicit result event when present and preserves errors", () => {
    const result = parseClaudeDirectResult([
      "{\"type\":\"session.started\",\"session_id\":\"claude-session-2\"}",
      "{\"type\":\"error\",\"message\":\"permission warning\"}",
      "{\"type\":\"result\",\"result\":\"Final answer\"}",
    ].join("\n"));

    expect(result.sessionId).toBe("claude-session-2");
    expect(result.resultText).toBe("Final answer");
    expect(result.rawResult).toMatchObject({
      result: "Final answer",
      errors: ["permission warning", "Final answer"],
    });
  });

  it("preserves partial text ordering without duplicating prior deltas", () => {
    const result = parseClaudeDirectResult([
      "{\"type\":\"session.started\",\"session_id\":\"claude-session-3\",\"request_id\":\"req-claude-3\"}",
      "{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\"}}",
      "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"First\"}}",
      "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" second\"}}",
      "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" third\"}}",
      "{\"type\":\"message_stop\"}",
    ].join("\n"));

    expect(result.resultText).toBe("First second third");
  });

  it("ignores control requests while still extracting final output", () => {
    const result = parseClaudeDirectResult([
      "{\"type\":\"control_request\",\"request_id\":\"ctrl-1\",\"request\":{\"subtype\":\"can_use_tool\",\"tool_name\":\"mcp__agentchatbus__bus_connect\",\"input\":{}}}",
      "{\"type\":\"session.started\",\"session_id\":\"claude-session-4\",\"request_id\":\"req-claude-4\"}",
      "{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\"}}",
      "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Connected.\"}}",
      "{\"type\":\"message_stop\"}",
    ].join("\n"));

    expect(result.sessionId).toBe("claude-session-4");
    expect(result.requestId).toBe("ctrl-1");
    expect(result.resultText).toBe("Connected.");
    expect(result.rawResult).toMatchObject({
      event_count: 5,
    });
  });

  it("extracts final text from official SDK assistant messages", () => {
    const result = parseClaudeDirectResult([
      "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"claude-session-5\",\"model\":\"claude-sonnet\",\"tools\":[],\"mcp_servers\":[],\"apiKeySource\":\"oauth\",\"claude_code_version\":\"1.0.108\",\"cwd\":\"C:/repo\",\"permissionMode\":\"default\",\"slash_commands\":[],\"output_style\":\"default\",\"skills\":[],\"plugins\":[],\"uuid\":\"sys-1\"}",
      "{\"type\":\"assistant\",\"session_id\":\"claude-session-5\",\"parent_tool_use_id\":null,\"uuid\":\"asst-1\",\"message\":{\"content\":[{\"type\":\"thinking\",\"thinking\":\"Inspecting the thread state\"},{\"type\":\"text\",\"text\":\"Joined the thread and ready to help.\"}]}}",
      "{\"type\":\"system\",\"subtype\":\"session_state_changed\",\"state\":\"idle\",\"session_id\":\"claude-session-5\",\"uuid\":\"state-1\"}",
      "{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"Joined the thread and ready to help.\",\"duration_ms\":10,\"duration_api_ms\":5,\"is_error\":false,\"num_turns\":1,\"stop_reason\":null,\"total_cost_usd\":0,\"usage\":{\"input_tokens\":0,\"output_tokens\":0,\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":0},\"modelUsage\":{},\"permission_denials\":[],\"uuid\":\"res-1\",\"session_id\":\"claude-session-5\"}",
    ].join("\n"));

    expect(result.sessionId).toBe("claude-session-5");
    expect(result.resultText).toBe("Joined the thread and ready to help.");
  });

  it("extracts text from official stream_event wrapper messages", () => {
    const result = parseClaudeDirectResult([
      "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"claude-session-6\",\"model\":\"claude-sonnet\",\"tools\":[],\"mcp_servers\":[],\"apiKeySource\":\"oauth\",\"claude_code_version\":\"1.0.108\",\"cwd\":\"C:/repo\",\"permissionMode\":\"default\",\"slash_commands\":[],\"output_style\":\"default\",\"skills\":[],\"plugins\":[],\"uuid\":\"sys-2\"}",
      "{\"type\":\"stream_event\",\"session_id\":\"claude-session-6\",\"uuid\":\"evt-1\",\"parent_tool_use_id\":null,\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\"}}}",
      "{\"type\":\"stream_event\",\"session_id\":\"claude-session-6\",\"uuid\":\"evt-2\",\"parent_tool_use_id\":null,\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello from \"}}}",
      "{\"type\":\"stream_event\",\"session_id\":\"claude-session-6\",\"uuid\":\"evt-3\",\"parent_tool_use_id\":null,\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"stream events\"}}}",
      "{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"Hello from stream events\",\"duration_ms\":10,\"duration_api_ms\":5,\"is_error\":false,\"num_turns\":1,\"stop_reason\":null,\"total_cost_usd\":0,\"usage\":{\"input_tokens\":0,\"output_tokens\":0,\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":0},\"modelUsage\":{},\"permission_denials\":[],\"uuid\":\"res-2\",\"session_id\":\"claude-session-6\"}",
    ].join("\n"));

    expect(result.sessionId).toBe("claude-session-6");
    expect(result.resultText).toBe("Hello from stream events");
  });

  it("keeps a tool active until its tool_result arrives on the same tool_use_id", () => {
    const collected = collectClaudeDirectStream([
      "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"claude-session-7\",\"uuid\":\"sys-7\"}",
      "{\"type\":\"stream_event\",\"session_id\":\"claude-session-7\",\"uuid\":\"evt-1\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tool-1\",\"name\":\"Bash\"}}}",
      "{\"type\":\"stream_event\",\"session_id\":\"claude-session-7\",\"uuid\":\"evt-2\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"command\\\":\\\"npm test\\\",\\\"cwd\\\":\\\"C:/repo\\\"}\"}}}",
      "{\"type\":\"stream_event\",\"session_id\":\"claude-session-7\",\"uuid\":\"evt-3\",\"event\":{\"type\":\"content_block_stop\",\"index\":0}}",
      "{\"type\":\"tool_progress\",\"session_id\":\"claude-session-7\",\"uuid\":\"tool-progress-1\",\"tool_use_id\":\"tool-1\",\"tool_name\":\"Bash\",\"parent_tool_use_id\":null,\"elapsed_time_seconds\":3}",
      "{\"type\":\"user\",\"session_id\":\"claude-session-7\",\"uuid\":\"user-1\",\"parent_tool_use_id\":null,\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"tool-1\",\"is_error\":false,\"content\":\"Command completed successfully\"}]}}",
    ].join("\n"));

    const toolEvents = collected.activities.filter((event) => event.item_id === "tool:tool-1");
    expect(toolEvents.length).toBeGreaterThanOrEqual(2);
    expect(toolEvents.slice(0, -1).every((event) => event.status === "in_progress")).toBe(true);
    expect(toolEvents.at(-1)).toMatchObject({
      status: "completed",
      kind: "command_execution",
      command: "npm test",
      cwd: "C:/repo",
    });
  });

  it("does not treat message_stop as the authoritative completed signal", () => {
    const collected = collectClaudeDirectStream([
      "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"claude-session-8\",\"uuid\":\"sys-8\"}",
      "{\"type\":\"message_start\",\"message\":{\"id\":\"msg-8\"}}",
      "{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\"}}",
      "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Working\"}}",
      "{\"type\":\"message_stop\"}",
    ].join("\n"));

    const completedRuntime = collected.runtimeEvents.find((event) => event.phase === "completed");
    expect(completedRuntime).toBeUndefined();
    expect(collected.envelope.resultText).toBe("Working");
  });

  it("extracts command hints from partial input_json_delta before the JSON fully closes", () => {
    const collected = collectClaudeDirectStream([
      "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"claude-session-9\",\"uuid\":\"sys-9\"}",
      "{\"type\":\"stream_event\",\"session_id\":\"claude-session-9\",\"uuid\":\"evt-1\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tool-9\",\"name\":\"Bash\"}}}",
      "{\"type\":\"stream_event\",\"session_id\":\"claude-session-9\",\"uuid\":\"evt-2\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"command\\\":\\\"node --check web-ui/js/shared-chat.js\\\",\\\"cwd\\\":\\\"C:/repo\\\"\"}}}",
    ].join("\n"));

    const toolEvent = collected.activities.find((event) => event.item_id === "tool:tool-9");
    expect(toolEvent).toMatchObject({
      kind: "command_execution",
      status: "in_progress",
      command: "node --check web-ui/js/shared-chat.js",
      cwd: "C:/repo",
    });
  });

  it("captures richer Claude task progress and persisted file summaries", () => {
    const collected = collectClaudeDirectStream([
      "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"claude-session-10\",\"uuid\":\"sys-10\"}",
      "{\"type\":\"system\",\"subtype\":\"task_progress\",\"session_id\":\"claude-session-10\",\"uuid\":\"task-1\",\"task_id\":\"task-10\",\"tool_use_id\":\"tool-10\",\"description\":\"Checking files\",\"summary\":\"Reviewing the updated web UI files\",\"last_tool_name\":\"FileEditTool\",\"usage\":{\"total_tokens\":1200,\"tool_uses\":3,\"duration_ms\":4200}}",
      "{\"type\":\"system\",\"subtype\":\"files_persisted\",\"session_id\":\"claude-session-10\",\"uuid\":\"files-1\",\"files\":[{\"filename\":\"web-ui/js/shared-chat.js\",\"file_id\":\"file-1\"}],\"failed\":[{\"filename\":\"web-ui/css/main.css\",\"error\":\"permission denied\"}],\"processed_at\":\"2026-04-02T14:00:00.000Z\"}",
    ].join("\n"));

    expect(collected.activities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "task",
        label: "Task progress",
        summary: expect.stringContaining("4s"),
      }),
      expect.objectContaining({
        kind: "file_change",
        label: "Files",
        summary: expect.stringContaining("Persisted 1 file"),
      }),
      expect.objectContaining({
        kind: "task",
        status: "failed",
        label: "File persist issue",
        summary: expect.stringContaining("permission denied"),
      }),
    ]));
  });
});
