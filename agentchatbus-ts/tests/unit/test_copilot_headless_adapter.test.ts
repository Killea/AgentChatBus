import { describe, expect, it } from "vitest";
import { parseCopilotHeadlessResult } from "../../src/core/services/adapters/copilotHeadlessAdapter.js";

describe("parseCopilotHeadlessResult", () => {
  it("extracts resumable session id and final agent message from JSONL output", () => {
    const result = parseCopilotHeadlessResult([
      "{\"type\":\"session.started\",\"session_id\":\"copilot-session-42\",\"request_id\":\"req-7\"}",
      "{\"type\":\"turn.started\"}",
      "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Ship it.\"}}",
    ].join("\n"));

    expect(result.sessionId).toBe("copilot-session-42");
    expect(result.requestId).toBe("req-7");
    expect(result.resultText).toBe("Ship it.");
    expect(result.rawResult).toMatchObject({
      session_id: "copilot-session-42",
      request_id: "req-7",
      event_count: 3,
      last_agent_message: "Ship it.",
      errors: [],
      ignored_line_count: 0,
    });
  });

  it("retains error items while preserving the latest agent message", () => {
    const result = parseCopilotHeadlessResult([
      "{\"type\":\"session.started\",\"session_id\":\"copilot-session-42\"}",
      "{\"type\":\"item.completed\",\"item\":{\"type\":\"error\",\"message\":\"resume warning\"}}",
      "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Recovered.\"}}",
    ].join("\n"));

    expect(result.sessionId).toBe("copilot-session-42");
    expect(result.resultText).toBe("Recovered.");
    expect(result.rawResult).toMatchObject({
      errors: ["resume warning"],
      last_agent_message: "Recovered.",
    });
  });
});
