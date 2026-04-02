import { describe, expect, it } from "vitest";
import {
  CopilotDirectAdapter,
  parseCopilotDirectResult,
  selectCopilotPermissionOptionId,
} from "../../src/core/services/adapters/copilotDirectAdapter.js";
import { COPILOT_SESSION_ID_ENV_VAR } from "../../src/core/services/adapters/copilotHeadlessAdapter.js";

describe("parseCopilotDirectResult", () => {
  it("extracts session id, request id, and streamed assistant text from ACP updates", () => {
    const result = parseCopilotDirectResult([
      "{\"id\":\"1\",\"result\":{\"sessionId\":\"copilot-session-1\"}}",
      "{\"method\":\"sessionUpdate\",\"params\":{\"sessionId\":\"copilot-session-1\",\"update\":{\"updateType\":\"agent_message_chunk\",\"content\":[{\"type\":\"text\",\"text\":\"Hello from \"}]}}}",
      "{\"method\":\"sessionUpdate\",\"params\":{\"requestId\":\"turn-1\",\"update\":{\"updateType\":\"agent_message_chunk\",\"content\":[{\"type\":\"text\",\"text\":\"Copilot ACP\"}]}}}",
      "{\"id\":\"2\",\"result\":{\"stopReason\":\"end_turn\"}}",
    ].join("\n"));

    expect(result.sessionId).toBe("copilot-session-1");
    expect(result.requestId).toBe("turn-1");
    expect(result.resultText).toBe("Hello from Copilot ACP");
    expect(result.rawResult).toMatchObject({
      completed: true,
      ignored_line_count: 0,
      last_assistant_text: "Hello from Copilot ACP",
    });
  });

  it("collects errors and ignores non-json lines", () => {
    const result = parseCopilotDirectResult([
      "{\"method\":\"error\",\"params\":{\"message\":\"permission warning\"}}",
      "{\"id\":\"3\",\"error\":{\"message\":\"prompt failed\"}}",
      "non-json-line",
      "{\"method\":\"agentMessage\",\"params\":{\"text\":\"Recovered answer\"}}",
    ].join("\n"));

    expect(result.resultText).toBe("Recovered answer");
    expect(result.rawResult).toMatchObject({
      errors: ["permission warning", "prompt failed"],
      ignored_line_count: 1,
      last_assistant_text: "Recovered answer",
    });
  });
});

describe("selectCopilotPermissionOptionId", () => {
  it("prefers allow-once, then allow-always, then the first allow-like option", () => {
    expect(selectCopilotPermissionOptionId([
      { optionId: "reject-once", kind: "reject_once" },
      { optionId: "allow-always", kind: "allow_always" },
      { optionId: "allow-once", kind: "allow_once" },
    ])).toBe("allow-once");

    expect(selectCopilotPermissionOptionId([
      { optionId: "reject", kind: "reject_once" },
      { optionId: "approve", kind: "allow_custom" },
    ])).toBe("approve");
  });
});

describe("CopilotDirectAdapter.run", () => {
  it("uses parsed session/request ids and preserves parsed output", async () => {
    const adapter = new CopilotDirectAdapter(
      {
        run: async () => ({
          exitCode: 0,
          stdout: [
            "{\"id\":\"1\",\"result\":{\"sessionId\":\"copilot-session-7\"}}",
            "{\"method\":\"agentMessage\",\"params\":{\"text\":\"done\"}}",
            "{\"method\":\"sessionUpdate\",\"params\":{\"requestId\":\"req-77\"}}",
            "{\"id\":\"4\",\"result\":{\"stopReason\":\"end_turn\"}}",
          ].join("\n"),
          stderr: "",
        }),
      },
      "copilot",
    );

    const result = await adapter.run(
      {
        prompt: "hello",
        workspace: ".",
        cols: 120,
        rows: 40,
      },
      {
        signal: new AbortController().signal,
        onOutput: () => {},
        onProcessStart: () => {},
        onControls: () => {},
      },
    );

    expect(result.externalSessionId).toBe("copilot-session-7");
    expect(result.externalRequestId).toBe("req-77");
    expect(result.resultText).toBe("done");
    expect(result.rawResult).toMatchObject({
      completed: true,
      last_assistant_text: "done",
    });
  });

  it("falls back to persisted session id when parsed output omits it", async () => {
    const adapter = new CopilotDirectAdapter(
      {
        run: async () => ({
          exitCode: 0,
          stdout: "{\"method\":\"agentMessage\",\"params\":{\"text\":\"ok\"}}",
          stderr: "",
        }),
      },
      "copilot",
    );

    const result = await adapter.run(
      {
        prompt: "hello",
        workspace: ".",
        cols: 120,
        rows: 40,
        env: {
          [COPILOT_SESSION_ID_ENV_VAR]: "persisted-copilot-session-1",
        },
      },
      {
        signal: new AbortController().signal,
        onOutput: () => {},
        onProcessStart: () => {},
        onControls: () => {},
      },
    );

    expect(result.externalSessionId).toBe("persisted-copilot-session-1");
    expect(result.resultText).toBe("ok");
  });
});
