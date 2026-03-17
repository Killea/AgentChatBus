/**
 * Unit tests for UP-07: Content Filter.
 * Tests the filter logic and CRUD integration.
 * Ported from Python: tests/test_content_filter_unit.py
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  checkContent,
  isContentFilterEnabled,
  ContentFilterError,
  SECRET_PATTERNS,
} from "../../src/core/services/contentFilter.js";
import { MemoryStore } from "../../src/core/services/memoryStore.js";

// ─────────────────────────────────────────────
// Pure unit tests — no DB needed
// ─────────────────────────────────────────────

describe("checkContent", () => {
  it("allows normal text", () => {
    const [blocked, pattern] = checkContent("The refactor looks good, great work!");
    expect(blocked).toBe(false);
    expect(pattern).toBeNull();
  });

  it("blocks AWS access key", () => {
    const [blocked, pattern] = checkContent(
      "Use key AKIAIOSFODNN7EXAMPLE123 to access bucket"
    );
    expect(blocked).toBe(true);
    expect(pattern).toContain("AWS");
  });

  it("blocks AWS temp key", () => {
    const [blocked, pattern] = checkContent("Temp key: ASIAQNZAKIIOSFODNN7E");
    expect(blocked).toBe(true);
    expect(pattern).toContain("AWS");
  });

  it("blocks GitHub PAT", () => {
    const [blocked, pattern] = checkContent(
      "My token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456abcd"
    );
    expect(blocked).toBe(true);
    expect(pattern).toContain("GitHub");
  });

  it("blocks GitHub OAuth token", () => {
    const [blocked, pattern] = checkContent(
      "OAuth: gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456abcd"
    );
    expect(blocked).toBe(true);
    expect(pattern).toContain("GitHub");
  });

  it("blocks private key RSA", () => {
    const [blocked, pattern] = checkContent(
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpA..."
    );
    expect(blocked).toBe(true);
    expect(pattern).toContain("Private Key");
  });

  it("blocks private key generic", () => {
    const [blocked, pattern] = checkContent("-----BEGIN PRIVATE KEY-----");
    expect(blocked).toBe(true);
    expect(pattern).toContain("Private Key");
  });

  it("blocks Slack bot token", () => {
    const [blocked, pattern] = checkContent("Slack: xoxb-123456789-ABCDEFGHIJ");
    expect(blocked).toBe(true);
    expect(pattern).toContain("Slack");
  });

  it("allows technical discussion about tokens", () => {
    /** Talking about token rotation strategy should not be blocked. */
    const [blocked] = checkContent(
      "We should rotate the token every 30 days and store it in a secrets manager, not in code."
    );
    expect(blocked).toBe(false);
  });

  it("allows code snippet without real secrets", () => {
    const [blocked] = checkContent(
      "const token = process.env.API_TOKEN; // read from environment"
    );
    expect(blocked).toBe(false);
  });
});

describe("ContentFilterError", () => {
  it("has pattern name", () => {
    const err = new ContentFilterError("AWS Access Key ID");
    expect(err.patternName).toBe("AWS Access Key ID");
    expect(err.message).toContain("AWS Access Key ID");
  });
});

describe("isContentFilterEnabled", () => {
  const originalEnv = process.env.AGENTCHATBUS_CONTENT_FILTER_ENABLED;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AGENTCHATBUS_CONTENT_FILTER_ENABLED;
    } else {
      process.env.AGENTCHATBUS_CONTENT_FILTER_ENABLED = originalEnv;
    }
  });

  it("is enabled by default", () => {
    delete process.env.AGENTCHATBUS_CONTENT_FILTER_ENABLED;
    expect(isContentFilterEnabled()).toBe(true);
  });

  it("can be disabled with false", () => {
    process.env.AGENTCHATBUS_CONTENT_FILTER_ENABLED = "false";
    expect(isContentFilterEnabled()).toBe(false);
  });

  it("can be disabled with FALSE", () => {
    process.env.AGENTCHATBUS_CONTENT_FILTER_ENABLED = "FALSE";
    expect(isContentFilterEnabled()).toBe(false);
  });

  it("stays enabled with true", () => {
    process.env.AGENTCHATBUS_CONTENT_FILTER_ENABLED = "true";
    expect(isContentFilterEnabled()).toBe(true);
  });
});

// ─────────────────────────────────────────────
// MemoryStore integration tests
// ─────────────────────────────────────────────

describe("MemoryStore content filter integration", () => {
  let store: MemoryStore;

  beforeEach(() => {
    // Enable content filter for tests
    process.env.AGENTCHATBUS_CONTENT_FILTER_ENABLED = "true";
    process.env.AGENTCHATBUS_DB = ":memory:";
    store = new MemoryStore(":memory:");
  });

  afterEach(() => {
    store.close();
    delete process.env.AGENTCHATBUS_CONTENT_FILTER_ENABLED;
    delete process.env.AGENTCHATBUS_DB;
  });

  it("postMessage blocks AWS key with pattern detail", () => {
    const { thread } = store.createThread("test-thread");
    const sync = store.issueSyncContext(thread.id, "human", "test");

    let caught: unknown;
    try {
      store.postMessage({
        threadId: thread.id,
        author: "human",
        content: "AKIAIOSFODNN7EXAMPLE123",
        expectedLastSeq: sync.current_seq,
        replyToken: sync.reply_token,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ContentFilterError);
    expect((caught as ContentFilterError).patternName).toContain("AWS");
  });

  it("postMessage allows normal content", () => {
    const { thread } = store.createThread("test-thread");
    const sync = store.issueSyncContext(thread.id, "human", "test");

    const msg = store.postMessage({
      threadId: thread.id,
      author: "human",
      content: "This looks like a solid implementation.",
      expectedLastSeq: sync.current_seq,
      replyToken: sync.reply_token,
    });

    expect(msg.seq).toBeGreaterThan(0);
    expect(msg.content).toBe("This looks like a solid implementation.");
  });

  it("postMessage allows blocked content when filter is disabled", () => {
    process.env.AGENTCHATBUS_CONTENT_FILTER_ENABLED = "false";
    const { thread } = store.createThread("test-thread");
    const sync = store.issueSyncContext(thread.id, "human", "test");

    const msg = store.postMessage({
      threadId: thread.id,
      author: "human",
      content: "AKIAIOSFODNN7EXAMPLE123",
      expectedLastSeq: sync.current_seq,
      replyToken: sync.reply_token,
    });

    expect(msg.seq).toBeGreaterThan(0);
  });
});

describe("SECRET_PATTERNS", () => {
  it("contains expected patterns", () => {
    const labels = SECRET_PATTERNS.map(([, label]) => label);
    expect(labels).toContain("AWS Access Key ID");
    expect(labels).toContain("AWS Temporary Access Key");
    expect(labels).toContain("JWT Token");
    expect(labels).toContain("GitHub Personal Access Token");
    expect(labels).toContain("GitHub OAuth Token");
    expect(labels).toContain("GitHub App Token");
    expect(labels).toContain("Private Key");
    expect(labels).toContain("OpenAI API Key");
    expect(labels).toContain("Slack Token");
    expect(labels).toContain("Google API Key");
    expect(labels).toContain("Azure Storage Key");
  });
});
