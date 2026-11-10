import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { callTool } from "../../src/adapters/mcp/tools.js";
import { MemoryStore } from "../../src/core/services/memoryStore.js";
import { registerStore } from "../../src/core/services/storeSingleton.js";
import { memoryStore } from "../../src/core/services/memoryStore.js";
import { eventBus } from "../../src/shared/eventBus.js";
import { redactTokens } from "../../src/shared/redactTokens.js";
import {
  createHttpServer,
  getMemoryStore,
  memoryStoreInstance,
} from "../../src/transports/http/server.js";
import { callMcpTool, parseMsgPostResult } from "./helpers/mcpIntegration.js";

function bootstrapThread(store: MemoryStore) {
  const agentA = store.registerAgent({ ide: "CLI", model: "agent-a-auth" });
  const agentB = store.registerAgent({ ide: "CLI", model: "agent-b-auth" });
  const { thread } = store.createThread("author-auth-thread");
  const syncA = store.issueSyncContext(thread.id, agentA.id, "bootstrap");
  return { agentA, agentB, thread, syncA };
}

describe("message author authentication integration", () => {
  beforeAll(() => {
    process.env.AGENTCHATBUS_TEST_DB = ":memory:";
  });

  beforeEach(() => {
    vi.unstubAllEnvs();
    process.env.AGENTCHATBUS_STRICT_AUTHOR_AUTH = "false";
    if (memoryStoreInstance) {
      memoryStoreInstance.reset();
      return;
    }
    memoryStore.reset();
    registerStore(memoryStore);
  });

  it("redactTokens redacts token values but not reply_token", () => {
    expect(redactTokens('{"token":"abc"}')).toBe('{"token":"[REDACTED]"}');
    expect(redactTokens('{\\"token\\":\\"abc\\"}')).toBe('{\\"token\\":\\"[REDACTED]\\"}');
    expect(redactTokens('{"reply_token":"x"}')).toBe('{"reply_token":"x"}');
  });

  it("MCP verified post stores author_verified and author_id", async () => {
    const store = getMemoryStore();
    const { agentA, thread, syncA } = bootstrapThread(store);

    const postResult = parseMsgPostResult(await callTool("msg_post", {
      thread_id: thread.id,
      agent_id: agentA.id,
      token: agentA.token,
      author: agentA.id,
      content: "verified hello",
      expected_last_seq: syncA.current_seq,
      reply_token: syncA.reply_token,
    }));
    expect(postResult.author_verified).toBe(true);
    expect(postResult.error).toBeUndefined();

    const getResult = (await callTool("msg_get", { message_id: postResult.msg_id })) as {
      found: boolean;
      message: Record<string, unknown>;
    };
    expect(getResult.found).toBe(true);
    expect(getResult.message.author_verified).toBe(true);
    expect(getResult.message.author_id).toBe(agentA.id);
  });

  it("MCP verified post with mentions keeps author_verified and metadata.mentions", async () => {
    const store = getMemoryStore();
    const { agentA, agentB, thread, syncA } = bootstrapThread(store);

    const postResult = parseMsgPostResult(await callTool("msg_post", {
      thread_id: thread.id,
      agent_id: agentA.id,
      token: agentA.token,
      author: agentA.id,
      content: "verified with mentions",
      mentions: [agentB.id, 42],
      expected_last_seq: syncA.current_seq,
      reply_token: syncA.reply_token,
    }));
    expect(postResult.author_verified).toBe(true);
    expect(postResult.error).toBeUndefined();

    const getResult = (await callTool("msg_get", { message_id: postResult.msg_id })) as {
      found: boolean;
      message: Record<string, unknown>;
    };
    expect(getResult.found).toBe(true);
    expect(getResult.message.author_verified).toBe(true);
    const metadata = getResult.message.metadata as Record<string, unknown> | null;
    expect(metadata).not.toBeNull();
    expect(metadata?.mentions).toEqual([agentB.id]);
  });

  it("MCP empty or whitespace token returns AUTHOR_TOKEN_INVALID", async () => {
    const store = getMemoryStore();
    const { agentA, thread, syncA } = bootstrapThread(store);

    const empty = parseMsgPostResult(await callTool("msg_post", {
      thread_id: thread.id,
      agent_id: agentA.id,
      token: "",
      author: agentA.id,
      content: "empty token",
      expected_last_seq: syncA.current_seq,
      reply_token: syncA.reply_token,
    }));
    expect(empty.error).toBe("AUTHOR_TOKEN_INVALID");

    const sync2 = store.issueSyncContext(thread.id, agentA.id, "ws-token");
    const whitespace = parseMsgPostResult(await callTool("msg_post", {
      thread_id: thread.id,
      agent_id: agentA.id,
      token: "   ",
      author: agentA.id,
      content: "whitespace token",
      expected_last_seq: sync2.current_seq,
      reply_token: sync2.reply_token,
    }));
    expect(whitespace.error).toBe("AUTHOR_TOKEN_INVALID");
  });

  it("MCP wrong token returns AUTHOR_TOKEN_INVALID without advancing seq", async () => {
    const store = getMemoryStore();
    const { agentA, thread, syncA } = bootstrapThread(store);
    const beforeSeq = store.getLatestSeq(thread.id);

    const postResult = parseMsgPostResult(await callTool("msg_post", {
      thread_id: thread.id,
      agent_id: agentA.id,
      token: "not-the-real-token",
      author: agentA.id,
      content: "should fail",
      expected_last_seq: syncA.current_seq,
      reply_token: syncA.reply_token,
    }));
    expect(postResult.error).toBe("AUTHOR_TOKEN_INVALID");
    expect(store.getLatestSeq(thread.id)).toBe(beforeSeq);
  });

  it("MCP AUTHOR_MISMATCH when agent_id and author disagree", async () => {
    const store = getMemoryStore();
    const { agentA, agentB, thread, syncA } = bootstrapThread(store);

    const postResult = parseMsgPostResult(await callTool("msg_post", {
      thread_id: thread.id,
      agent_id: agentA.id,
      token: agentA.token,
      author: agentB.id,
      content: "mismatch",
      expected_last_seq: syncA.current_seq,
      reply_token: syncA.reply_token,
    }));
    expect(postResult.error).toBe("AUTHOR_MISMATCH");
  });

  it("MCP free-text author with valid token uses agent id", async () => {
    const store = getMemoryStore();
    const { agentA, thread, syncA } = bootstrapThread(store);

    const postResult = parseMsgPostResult(await callTool("msg_post", {
      thread_id: thread.id,
      agent_id: agentA.id,
      token: agentA.token,
      author: "free text",
      content: "ignored author string",
      expected_last_seq: syncA.current_seq,
      reply_token: syncA.reply_token,
    }));
    expect(postResult.author_verified).toBe(true);

    const getResult = (await callTool("msg_get", { message_id: postResult.msg_id })) as {
      message: Record<string, unknown>;
    };
    expect(getResult.message.author_id).toBe(agentA.id);
  });

  it("MCP unverified post when no token and strict off", async () => {
    const store = getMemoryStore();
    const { agentA, thread, syncA } = bootstrapThread(store);

    const postResult = parseMsgPostResult(await callTool("msg_post", {
      thread_id: thread.id,
      author: agentA.id,
      content: "unverified claim",
      expected_last_seq: syncA.current_seq,
      reply_token: syncA.reply_token,
    }));
    expect(postResult.author_verified).toBe(false);

    const getResult = (await callTool("msg_get", { message_id: postResult.msg_id })) as {
      message: Record<string, unknown>;
    };
    expect(getResult.message.author_verified).toBe(false);
  });

  describe("REST with X-Agent-Token", () => {
    async function createThreadForRest(server: ReturnType<typeof createHttpServer>) {
      const auth = (await server.inject({
        method: "POST",
        url: "/api/agents/register",
        payload: { ide: "VSCode", model: "rest-auth" },
      })).json();
      const thread = (await server.inject({
        method: "POST",
        url: "/api/threads",
        headers: { "x-agent-token": auth.token },
        payload: { topic: "rest-auth", creator_agent_id: auth.agent_id },
      })).json();
      return { auth, thread };
    }

    it("REST strict mode wrong token returns 401 with detail and error", async () => {
      vi.stubEnv("AGENTCHATBUS_STRICT_AUTHOR_AUTH", "true");
      const server = createHttpServer();
      const { auth, thread } = await createThreadForRest(server);
      const sync = (await server.inject({
        method: "POST",
        url: `/api/threads/${thread.id}/sync-context`,
        payload: {},
      })).json();

      const wrong = await server.inject({
        method: "POST",
        url: `/api/threads/${thread.id}/messages`,
        headers: { "x-agent-token": "   " },
        payload: {
          author: auth.agent_id,
          content: "strict whitespace token",
          expected_last_seq: sync.current_seq,
          reply_token: sync.reply_token,
        },
      });
      expect(wrong.statusCode).toBe(401);
      const body = wrong.json();
      expect(body.error).toBe("AUTHOR_TOKEN_INVALID");
      expect(typeof body.detail).toBe("string");
      expect(body.detail.length).toBeGreaterThan(0);

      await server.close();
    });

    it("REST verified and unverified plus wrong token 401", async () => {
      const server = createHttpServer();
      const { auth, thread } = await createThreadForRest(server);

      const verified = await server.inject({
        method: "POST",
        url: `/api/threads/${thread.id}/messages`,
        headers: { "x-agent-token": auth.token },
        payload: {
          author: auth.agent_id,
          content: "rest verified",
          expected_last_seq: thread.current_seq,
          reply_token: thread.reply_token,
        },
      });
      expect(verified.statusCode).toBe(201);
      expect(verified.json().author_verified).toBe(true);

      const sync = (await server.inject({
        method: "POST",
        url: `/api/threads/${thread.id}/sync-context`,
        payload: {},
      })).json();

      const wrong = await server.inject({
        method: "POST",
        url: `/api/threads/${thread.id}/messages`,
        headers: { "x-agent-token": "bad" },
        payload: {
          author: auth.agent_id,
          content: "bad token",
          expected_last_seq: sync.current_seq,
          reply_token: sync.reply_token,
        },
      });
      expect(wrong.statusCode).toBe(401);
      expect(wrong.json().error).toBe("AUTHOR_TOKEN_INVALID");

      const nextSync = (await server.inject({
        method: "POST",
        url: `/api/threads/${thread.id}/sync-context`,
        payload: {},
      })).json();

      const unverified = await server.inject({
        method: "POST",
        url: `/api/threads/${thread.id}/messages`,
        payload: {
          author: auth.agent_id,
          content: "no header",
          expected_last_seq: nextSync.current_seq,
          reply_token: nextSync.reply_token,
        },
      });
      expect(unverified.statusCode).toBe(201);
      expect(unverified.json().author_verified).toBe(false);

      await server.close();
    });
  });

  describe("strict author auth", () => {
    it("rejects padded author and padded agent_id claims", async () => {
      vi.stubEnv("AGENTCHATBUS_STRICT_AUTHOR_AUTH", "true");
      const store = getMemoryStore();
      const { agentA, thread, syncA } = bootstrapThread(store);

      const paddedAuthor = parseMsgPostResult(await callTool("msg_post", {
        thread_id: thread.id,
        author: `  ${agentA.id}  `,
        content: "padded author",
        expected_last_seq: syncA.current_seq,
        reply_token: syncA.reply_token,
      }));
      expect(paddedAuthor.error).toBe("AUTHOR_TOKEN_REQUIRED");

      const sync2 = store.issueSyncContext(thread.id, agentA.id, "padded-agent");
      const paddedAgent = parseMsgPostResult(await callTool("msg_post", {
        thread_id: thread.id,
        agent_id: `  ${agentA.id}  `,
        content: "padded agent_id",
        expected_last_seq: sync2.current_seq,
        reply_token: sync2.reply_token,
      }));
      expect(paddedAgent.error).toBe("AUTHOR_TOKEN_REQUIRED");
    });

    it("rejects display_name impersonation", async () => {
      vi.stubEnv("AGENTCHATBUS_STRICT_AUTHOR_AUTH", "true");
      const store = getMemoryStore();
      const agent = store.registerAgent({
        ide: "CLI",
        model: "display-name-auth",
        display_name: "Ledger Bot",
      });
      const { thread, syncA } = bootstrapThread(store);

      const spoof = parseMsgPostResult(await callTool("msg_post", {
        thread_id: thread.id,
        author: agent.display_name!,
        content: "display name spoof",
        expected_last_seq: syncA.current_seq,
        reply_token: syncA.reply_token,
      }));
      expect(spoof.error).toBe("AUTHOR_TOKEN_REQUIRED");
    });

    it("rejects impersonation and accepts human labels", async () => {
      vi.stubEnv("AGENTCHATBUS_STRICT_AUTHOR_AUTH", "true");
      const store = getMemoryStore();
      const { agentA, thread, syncA } = bootstrapThread(store);

      const required = parseMsgPostResult(await callTool("msg_post", {
        thread_id: thread.id,
        author: agentA.id,
        content: "strict no token",
        expected_last_seq: syncA.current_seq,
        reply_token: syncA.reply_token,
      }));
      expect(required.error).toBe("AUTHOR_TOKEN_REQUIRED");
      expect(required.detail).toContain("X-Agent-Token");

      const sync2 = store.issueSyncContext(thread.id, agentA.id, "strict-retry");
      const upperName = parseMsgPostResult(await callTool("msg_post", {
        thread_id: thread.id,
        author: agentA.name.toUpperCase(),
        content: "name spoof",
        expected_last_seq: sync2.current_seq,
        reply_token: sync2.reply_token,
      }));
      expect(upperName.error).toBe("AUTHOR_TOKEN_REQUIRED");

      const sync3 = store.issueSyncContext(thread.id, agentA.id, "human");
      const humanOk = parseMsgPostResult(await callTool("msg_post", {
        thread_id: thread.id,
        author: "human",
        content: "human ok",
        expected_last_seq: sync3.current_seq,
        reply_token: sync3.reply_token,
      }));
      expect(humanOk.error).toBeUndefined();
      expect(humanOk.author_verified).toBe(false);

      const sync4 = store.issueSyncContext(thread.id, agentA.id, "someone");
      const someoneOk = parseMsgPostResult(await callTool("msg_post", {
        thread_id: thread.id,
        author: "someone",
        content: "someone ok",
        expected_last_seq: sync4.current_seq,
        reply_token: sync4.reply_token,
      }));
      expect(someoneOk.error).toBeUndefined();
      expect(someoneOk.author_verified).toBe(false);
    });
  });

  it("author_verified appears across MCP reads and eventBus", async () => {
    const server = createHttpServer();
    const store = getMemoryStore();
    const { agentA, thread, syncA } = bootstrapThread(store);

    const seen: Array<Record<string, unknown>> = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === "msg.new") {
        seen.push(event.payload as Record<string, unknown>);
      }
    });

    const post = parseMsgPostResult(await callTool("msg_post", {
      thread_id: thread.id,
      agent_id: agentA.id,
      token: agentA.token,
      author: agentA.id,
      content: "presence check",
      expected_last_seq: syncA.current_seq,
      reply_token: syncA.reply_token,
    }));

    expect(seen[0]?.author_verified).toBe(true);

    const listMessages = await callMcpTool(server, "msg_list", {
      thread_id: thread.id,
      return_format: "json",
    }) as Array<Record<string, unknown>>;
    const posted = listMessages.find((m) => m.msg_id === post.msg_id);
    expect(posted?.author_verified).toBe(true);

    const getResult = (await callTool("msg_get", { message_id: post.msg_id })) as {
      message: Record<string, unknown>;
    };
    expect(typeof getResult.message.author_verified).toBe("boolean");

    const waitBody = await callMcpTool(server, "msg_wait", {
      thread_id: thread.id,
      after_seq: 0,
      timeout_ms: 50,
      return_format: "json",
    }) as { messages: Array<Record<string, unknown>> };
    const waitMsg = waitBody.messages.find((m) => m.msg_id === post.msg_id);
    expect(typeof waitMsg?.author_verified).toBe("boolean");

    const restList = await server.inject({
      method: "GET",
      url: `/api/threads/${thread.id}/messages`,
      query: { after_seq: "0", limit: "20" },
    });
    const restMessages = restList.json() as Array<Record<string, unknown>>;
    const restMsg = restMessages.find((m) => m.id === post.msg_id);
    expect(restMsg?.author_verified).toBe(true);

    unsubscribe();
    await server.close();
  });

  it("legacy DB migration adds author_verified default false", () => {
    const dir = mkdtempSync(join(tmpdir(), "acb-legacy-author-"));
    const dbPath = join(dir, "legacy.db");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS threads (
          id TEXT PRIMARY KEY,
          topic TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          priority TEXT NOT NULL,
          author TEXT NOT NULL,
          author_id TEXT,
          author_name TEXT,
          author_emoji TEXT,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          metadata TEXT,
          reply_to_msg_id TEXT,
          created_at TEXT NOT NULL,
          edited_at TEXT,
          edit_version INTEGER
        );
        INSERT INTO threads (id, topic, status, created_at, updated_at)
        VALUES ('t1', 'legacy', 'discuss', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
        INSERT INTO messages (
          id, thread_id, seq, priority, author, role, content, created_at
        ) VALUES (
          'm1', 't1', 1, 'normal', 'human', 'user', 'old row', '2020-01-01T00:00:00.000Z'
        );
      `);
      db.close();

      const store = new MemoryStore(dbPath);
      const old = store.getMessage("m1");
      expect(old).toBeDefined();
      expect(old?.author_verified).toBe(false);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore teardown errors
      }
    }
  });

  it("msg_search includes author_verified", async () => {
    const store = getMemoryStore();
    const { agentA, thread, syncA } = bootstrapThread(store);

    await callTool("msg_post", {
      thread_id: thread.id,
      agent_id: agentA.id,
      token: agentA.token,
      author: agentA.id,
      content: "searchable verified content",
      expected_last_seq: syncA.current_seq,
      reply_token: syncA.reply_token,
    });

    const search = (await callTool("msg_search", {
      query: "searchable verified",
      thread_id: thread.id,
    })) as { results: Array<Record<string, unknown>> };
    expect(search.results.length).toBeGreaterThan(0);
    expect(search.results[0]?.author_verified).toBe(true);
  });

  it("REST MCP tool debug file stores redacted token values", async () => {
    const server = createHttpServer();
    const dir = mkdtempSync(join(tmpdir(), "acb-mcp-debug-"));
    const previousCwd = process.cwd();
    process.chdir(dir);
    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/mcp/tool/agent_register",
        payload: { ide: "VSCode", model: "redact-debug-file" },
      });
      expect(response.statusCode).toBe(200);
      const filePath = join(dir, "tmp_last_mcp_response.json");
      expect(existsSync(filePath)).toBe(true);
      const text = readFileSync(filePath, "utf8");
      const payload = JSON.parse(response.payload);
      const rawToken = JSON.parse(String(payload[0].text)).token as string;
      expect(text).toContain("[REDACTED]");
      expect(text).not.toContain(rawToken);
    } finally {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true });
      await server.close();
    }
  });

  it("streamable MCP tools/call logs do not leak tokens", async () => {
    const server = createHttpServer();
    const store = getMemoryStore();
    const { agentA, thread, syncA } = bootstrapThread(store);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.addresses()[0];
    const baseUrl = `http://${address.address}:${address.port}`;

    try {
      const initializeResponse = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "vitest", version: "1.0.0" },
          },
        }),
      });
      const sessionId = initializeResponse.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();
      await initializeResponse.body?.cancel();

      const callResponse = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "msg_post",
            arguments: {
              thread_id: thread.id,
              agent_id: agentA.id,
              token: agentA.token,
              author: agentA.id,
              content: "streamable redact post",
              expected_last_seq: syncA.current_seq,
              reply_token: syncA.reply_token,
            },
          },
        }),
      });
      expect(callResponse.ok).toBe(true);
      await callResponse.text();

      let sawStreamableLog = false;
      for (const call of logSpy.mock.calls) {
        const line = String(call.join(" "));
        if (!line.includes("[mcp-streamable]")) {
          continue;
        }
        sawStreamableLog = true;
        expect(line).not.toContain(agentA.token);
      }
      expect(sawStreamableLog).toBe(true);
    } finally {
      logSpy.mockRestore();
      await server.close();
    }
  });

  it("legacy MCP route logs do not leak tokens", async () => {
    const server = createHttpServer();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const connect = await server.inject({
      method: "POST",
      url: "/mcp/messages",
      payload: {
        id: 1,
        method: "tools/call",
        params: {
          name: "bus_connect",
          arguments: { thread_name: "t-redact", ide: "VSCode", model: "redact-me" },
        },
      },
    });
    const connectJson = connect.json();
    const connectText = JSON.stringify(connectJson.result);
    expect(connectText).not.toMatch(/"token":"[A-Za-z0-9_-]{8,}"/);

    const register = await server.inject({
      method: "POST",
      url: "/mcp/messages",
      payload: {
        id: 2,
        method: "tools/call",
        params: {
          name: "agent_register",
          arguments: { ide: "VSCode", model: "redact-agent" },
        },
      },
    });
    const registerPayload = register.json().result as { agent_id: string; token: string };
    const agentToken = registerPayload.token;

    const thread = (await server.inject({
      method: "POST",
      url: "/api/threads",
      headers: { "x-agent-token": agentToken },
      payload: { topic: "redact-thread", creator_agent_id: registerPayload.agent_id },
    })).json();

    await server.inject({
      method: "POST",
      url: "/mcp/messages",
      payload: {
        id: 3,
        method: "tools/call",
        params: {
          name: "msg_post",
          arguments: {
            thread_id: thread.id,
            agent_id: registerPayload.agent_id,
            token: agentToken,
            author: registerPayload.agent_id,
            content: "redact post",
            expected_last_seq: thread.current_seq,
            reply_token: thread.reply_token,
          },
        },
      },
    });

    for (const call of logSpy.mock.calls) {
      const line = String(call.join(" "));
      expect(line).not.toContain(agentToken);
    }

    const list = await server.inject({
      method: "POST",
      url: "/mcp/messages",
      payload: {
        id: 4,
        method: "tools/call",
        params: {
          name: "msg_list",
          arguments: { thread_id: thread.id, return_format: "json" },
        },
      },
    });
    expect(JSON.stringify(list.json())).not.toContain(agentToken);

    logSpy.mockRestore();
    await server.close();
  });
});
