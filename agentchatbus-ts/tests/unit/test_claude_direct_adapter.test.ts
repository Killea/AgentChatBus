import { describe, expect, it } from "vitest";
import {
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
});
