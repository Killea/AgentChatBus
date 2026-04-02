import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CursorDirectAdapter,
  handleReadTextFileRequest,
  handleWriteTextFileRequest,
  parseCursorDirectResult,
  selectCursorPermissionOptionId,
} from "../../src/core/services/adapters/cursorDirectAdapter.js";
import { CURSOR_SESSION_ID_ENV_VAR } from "../../src/core/services/adapters/cursorHeadlessAdapter.js";

describe("parseCursorDirectResult", () => {
  it("extracts session/request aliases and marks completed from done-style events", () => {
    const result = parseCursorDirectResult([
      "{\"id\":\"1\",\"result\":{\"chat_id\":\"cursor-chat-1\"}}",
      "{\"id\":\"2\",\"result\":{\"turn_id\":\"turn-44\"}}",
      "{\"method\":\"session/update\",\"params\":{\"chatId\":\"cursor-chat-1\"}}",
      "{\"method\":\"assistant_message_delta\",\"params\":{\"delta\":\"hello \"}}",
      "{\"method\":\"assistant_message_delta\",\"params\":{\"content\":\"world\"}}",
      "{\"method\":\"turn_done\",\"params\":{\"request_id\":\"turn-44\"}}",
    ].join("\n"));

    expect(result.sessionId).toBe("cursor-chat-1");
    expect(result.requestId).toBe("turn-44");
    expect(result.resultText).toBe("hello world");
    expect(result.rawResult).toMatchObject({
      session_id: "cursor-chat-1",
      request_id: "turn-44",
      completed: true,
      ignored_line_count: 0,
      errors: [],
    });
  });

  it("collects rpc errors and notification errors while ignoring non-json lines", () => {
    const result = parseCursorDirectResult([
      "{\"method\":\"error\",\"params\":{\"message\":\"resume mismatch\"}}",
      "{\"id\":\"3\",\"error\":{\"message\":\"session/prompt failed\"}}",
      "non-json-line",
      "{\"method\":\"assistant_message\",\"params\":{\"text\":\"Recovered answer\"}}",
    ].join("\n"));

    expect(result.resultText).toBe("Recovered answer");
    expect(result.rawResult).toMatchObject({
      last_assistant_text: "Recovered answer",
      ignored_line_count: 1,
      errors: ["resume mismatch", "session/prompt failed"],
    });
  });

  it("extracts assistant text from ACP session/update message chunks", () => {
    const result = parseCursorDirectResult([
      "{\"method\":\"session/update\",\"params\":{\"sessionId\":\"cursor-session-2\",\"update\":{\"updateType\":\"agent_message_chunk\",\"content\":[{\"type\":\"text\",\"text\":\"Hello from \"}]}}}",
      "{\"method\":\"session/update\",\"params\":{\"requestId\":\"turn-2\",\"update\":{\"updateType\":\"agent_message_chunk\",\"content\":[{\"type\":\"text\",\"text\":\"Cursor ACP\"}]}}}",
      "{\"id\":\"4\",\"result\":{\"stopReason\":\"end_turn\"}}",
    ].join("\n"));

    expect(result.sessionId).toBe("cursor-session-2");
    expect(result.requestId).toBe("turn-2");
    expect(result.resultText).toBe("Hello from Cursor ACP");
    expect(result.rawResult).toMatchObject({
      completed: true,
      last_assistant_text: "Hello from Cursor ACP",
    });
  });

  it("keeps thought and tool-call content out of the final assistant result text", () => {
    const result = parseCursorDirectResult([
      "{\"method\":\"session/update\",\"params\":{\"sessionId\":\"cursor-session-3\",\"update\":{\"sessionUpdate\":\"agent_thought_chunk\",\"content\":{\"type\":\"text\",\"text\":\"Thinking about the codebase\"}}}}",
      "{\"method\":\"session/update\",\"params\":{\"sessionId\":\"cursor-session-3\",\"update\":{\"sessionUpdate\":\"tool_call\",\"toolCallId\":\"tool-1\",\"title\":\"Read src/index.ts\",\"kind\":\"read\",\"status\":\"pending\",\"content\":[{\"type\":\"content\",\"content\":{\"type\":\"text\",\"text\":\"opening file\"}}]}}}",
      "{\"method\":\"session/update\",\"params\":{\"requestId\":\"turn-3\",\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":[{\"type\":\"text\",\"text\":\"Final answer\"}]}}}",
      "{\"id\":\"4\",\"result\":{\"stopReason\":\"end_turn\"}}",
    ].join("\n"));

    expect(result.sessionId).toBe("cursor-session-3");
    expect(result.requestId).toBe("turn-3");
    expect(result.resultText).toBe("Final answer");
    expect(result.rawResult).toMatchObject({
      completed: true,
      last_assistant_text: "Final answer",
      errors: [],
    });
  });
});

describe("CursorDirectAdapter helpers", () => {
  it("prefers an allow option when auto-approving permission requests", () => {
    expect(selectCursorPermissionOptionId([
      { optionId: "reject-once", kind: "reject_once" },
      { optionId: "allow-always", kind: "allow_always" },
      { optionId: "allow-once", kind: "allow_once" },
    ])).toBe("allow-once");

    expect(selectCursorPermissionOptionId([
      { optionId: "reject-once", kind: "reject_once" },
      { optionId: "approve", kind: "allow_custom" },
    ])).toBe("approve");
  });

  it("resolves workspace-relative ACP file operations inside the workspace boundary", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "cursor-direct-"));
    try {
      await handleWriteTextFileRequest(
        {
          path: "nested/output.txt",
          content: "line1\nline2\nline3",
        },
        workspace,
      );

      const written = await readFile(join(workspace, "nested", "output.txt"), "utf8");
      expect(written).toBe("line1\nline2\nline3");

      const partial = await handleReadTextFileRequest(
        {
          path: "nested/output.txt",
          line: 2,
          limit: 1,
        },
        workspace,
      );
      expect(partial).toEqual({ content: "line2" });

      await expect(handleReadTextFileRequest({ path: "../escape.txt" }, workspace)).rejects.toThrow(
        /outside the workspace boundary/i,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("CursorDirectAdapter.run", () => {
  it("uses parsed session/request ids and keeps parsed result payload", async () => {
    const adapter = new CursorDirectAdapter(
      {
        run: async () => ({
          exitCode: 0,
          stdout: [
            "{\"id\":\"1\",\"result\":{\"sessionId\":\"cursor-session-7\"}}",
            "{\"method\":\"assistant_message\",\"params\":{\"text\":\"done\"}}",
            "{\"method\":\"turn_finished\",\"params\":{\"requestId\":\"req-77\"}}",
          ].join("\n"),
          stderr: "",
        }),
      },
      "agent",
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

    expect(result.externalSessionId).toBe("cursor-session-7");
    expect(result.externalRequestId).toBe("req-77");
    expect(result.resultText).toBe("done");
    expect(result.rawResult).toMatchObject({
      completed: true,
      last_assistant_text: "done",
    });
  });

  it("falls back to persisted session id when parsed output does not include one", async () => {
    const adapter = new CursorDirectAdapter(
      {
        run: async () => ({
          exitCode: 0,
          stdout: "{\"method\":\"assistant_message\",\"params\":{\"text\":\"ok\"}}",
          stderr: "",
        }),
      },
      "agent",
    );

    const result = await adapter.run(
      {
        prompt: "hello",
        workspace: ".",
        cols: 120,
        rows: 40,
        env: {
          [CURSOR_SESSION_ID_ENV_VAR]: "persisted-session-1",
        },
      },
      {
        signal: new AbortController().signal,
        onOutput: () => {},
        onProcessStart: () => {},
        onControls: () => {},
      },
    );

    expect(result.externalSessionId).toBe("persisted-session-1");
    expect(result.resultText).toBe("ok");
  });
});
