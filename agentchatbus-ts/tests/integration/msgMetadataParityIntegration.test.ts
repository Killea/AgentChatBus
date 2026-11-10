import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { callTool } from "../../src/adapters/mcp/tools.js";
import { registerStore } from "../../src/core/services/storeSingleton.js";
import { memoryStore } from "../../src/core/services/memoryStore.js";
import {
  asTextBlocks,
  parseJsonTextBlock,
  type TextBlock,
} from "./helpers/mcpIntegration.js";

function messageSegments(blocks: TextBlock[]): TextBlock[][] {
  const headerRe = /^\[\d+\] /;
  const segments: TextBlock[][] = [];
  let current: TextBlock[] = [];
  for (const block of blocks) {
    if (block.type === "text" && headerRe.test(block.text)) {
      if (current.length > 0) {
        segments.push(current);
      }
      current = [block];
      continue;
    }
    if (current.length > 0) {
      current.push(block);
    }
  }
  if (current.length > 0) {
    segments.push(current);
  }
  return segments;
}

function metadataLinesInSegment(segment: TextBlock[]): string[] {
  return segment
    .filter((b) => b.type === "text" && b.text.startsWith("metadata: "))
    .map((b) => b.text);
}

describe("MCP message metadata parity", () => {
  beforeAll(() => {
    process.env.AGENTCHATBUS_TEST_DB = ":memory:";
    vi.stubEnv("AGENTCHATBUS_ENABLE_HANDOFF_TARGET", "false");
    vi.stubEnv("AGENTCHATBUS_RATE_LIMIT_ENABLED", "false");
  });

  beforeEach(() => {
    if (memoryStore) {
      memoryStore.reset();
    }
    registerStore(memoryStore);
  });

  async function seedThread(): Promise<{
    threadId: string;
    agentId: string;
    token: string;
    sync: { current_seq: number; reply_token: string; reply_window: number };
  }> {
    const connected = parseJsonTextBlock(
      await callTool("bus_connect", {
        thread_name: `metadata-parity-${Date.now()}`,
        ide: "CLI",
        model: "test",
      }),
    ) as {
      agent: { agent_id: string; token: string };
      thread: { thread_id: string };
      current_seq: number;
      reply_token: string;
      reply_window: number;
    };

    const threadId = connected.thread.thread_id;
    const agentId = connected.agent.agent_id;
    const token = connected.agent.token;
    let sync = {
      current_seq: connected.current_seq,
      reply_token: connected.reply_token,
      reply_window: connected.reply_window,
    };

    const plainPost = parseJsonTextBlock(
      await callTool("msg_post", {
        thread_id: threadId,
        agent_id: agentId,
        token,
        content: "plain message",
        expected_last_seq: sync.current_seq,
        reply_token: sync.reply_token,
      }),
    ) as { current_seq: number; reply_token: string; reply_window?: number };

    sync = {
      current_seq: plainPost.current_seq ?? sync.current_seq,
      reply_token: plainPost.reply_token ?? sync.reply_token,
      reply_window: plainPost.reply_window ?? sync.reply_window,
    };

    const metaPost = parseJsonTextBlock(
      await callTool("msg_post", {
        thread_id: threadId,
        agent_id: agentId,
        token,
        content: "go message",
        metadata: {
          kind: "go",
          handoff_target: "other-agent",
          images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
        },
        expected_last_seq: sync.current_seq,
        reply_token: sync.reply_token,
      }),
    ) as { current_seq: number; reply_token: string; reply_window?: number };

    sync = {
      current_seq: metaPost.current_seq ?? sync.current_seq,
      reply_token: metaPost.reply_token ?? sync.reply_token,
      reply_window: metaPost.reply_window ?? sync.reply_window,
    };

    return { threadId, agentId, token, sync };
  }

  it("msg_wait json returns metadata as an object", async () => {
    const { threadId, agentId, token, sync } = await seedThread();

    const waitBody = parseJsonTextBlock(
      await callTool("msg_wait", {
        thread_id: threadId,
        after_seq: 0,
        agent_id: agentId,
        token,
        timeout_ms: 1000,
        return_format: "json",
      }),
    ) as { messages: Array<{ content?: string; metadata: unknown }> };

    const goMsg = waitBody.messages.find((m) => m.content === "go message");
    expect(goMsg).toBeDefined();
    expect(goMsg?.metadata).not.toBeNull();
    expect(typeof goMsg?.metadata).toBe("object");
    expect(goMsg?.metadata).toMatchObject({ kind: "go" });
    expect((goMsg?.metadata as Record<string, unknown>).handoff_target).toBeUndefined();
  });

  it("msg_list blocks include one metadata line only for messages with non-empty metadata", async () => {
    const { threadId } = await seedThread();

    const blocks = asTextBlocks(
      await callTool("msg_list", {
        thread_id: threadId,
        return_format: "blocks",
      }),
    );

    const userSegments = messageSegments(blocks).filter((seg) =>
      seg.some((b) => b.text.includes("plain message") || b.text.includes("go message")),
    );
    expect(userSegments.length).toBe(2);

    const plainSeg = userSegments.find((seg) => seg.some((b) => b.text === "plain message"));
    const goSeg = userSegments.find((seg) => seg.some((b) => b.text === "go message"));
    expect(plainSeg).toBeDefined();
    expect(goSeg).toBeDefined();
    expect(metadataLinesInSegment(plainSeg!)).toEqual([]);
    expect(metadataLinesInSegment(goSeg!)).toHaveLength(1);
    expect(metadataLinesInSegment(goSeg!)[0]).toBe('metadata: {"kind":"go"}');
    expect(metadataLinesInSegment(goSeg!)[0]).not.toMatch(/base64|aGVsbG8=/i);
  });

  it("msg_wait blocks include one metadata line only for messages with non-empty metadata", async () => {
    const { threadId, agentId, token } = await seedThread();

    const blocks = asTextBlocks(
      await callTool("msg_wait", {
        thread_id: threadId,
        after_seq: 0,
        agent_id: agentId,
        token,
        timeout_ms: 1000,
        return_format: "blocks",
      }),
    );

    const userSegments = messageSegments(blocks).filter((seg) =>
      seg.some((b) => b.text.includes("plain message") || b.text.includes("go message")),
    );
    expect(userSegments.length).toBe(2);

    const plainSeg = userSegments.find((seg) => seg.some((b) => b.text === "plain message"));
    const goSeg = userSegments.find((seg) => seg.some((b) => b.text === "go message"));
    expect(metadataLinesInSegment(plainSeg!)).toEqual([]);
    expect(metadataLinesInSegment(goSeg!)).toHaveLength(1);
    expect(metadataLinesInSegment(goSeg!)[0]).toBe('metadata: {"kind":"go"}');
  });

  it("bus_connect history messages carry filtered metadata", async () => {
    const { threadId, agentId, token } = await seedThread();

    const payload = parseJsonTextBlock(
      await callTool("bus_connect", {
        thread_id: threadId,
        agent_id: agentId,
        token,
      }),
    ) as { messages: Array<{ content?: string; metadata?: unknown }> };

    const goMsg = payload.messages.find((m) => m.content === "go message");
    expect(goMsg?.metadata).toMatchObject({ kind: "go" });
    expect((goMsg?.metadata as Record<string, unknown> | undefined)?.handoff_target).toBeUndefined();
  });
});
