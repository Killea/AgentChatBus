import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHttpServer, getMemoryStore, memoryStoreInstance } from "../../src/transports/http/server.js";

async function waitForCondition(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("msg_wait abort integration", () => {
  beforeAll(() => {
    process.env.AGENTCHATBUS_TEST_DB = ":memory:";
  });

  beforeEach(() => {
    if (memoryStoreInstance) {
      memoryStoreInstance.reset();
    }
  });

  it("clears the active wait state when the HTTP client aborts an in-flight msg_wait", async () => {
    const server = createHttpServer();
    const address = await server.listen({ port: 0, host: "127.0.0.1" });

    try {
      const connectResponse = await server.inject({
        method: "POST",
        url: "/mcp/messages/",
        payload: {
          method: "tools/call",
          params: {
            name: "bus_connect",
            arguments: {
              thread_name: "abortable-msg-wait-thread",
              ide: "VSCode",
              model: "Codex",
            },
          },
        },
      });

      expect(connectResponse.statusCode).toBe(200);
      const connected = JSON.parse(connectResponse.json().result[0].text);
      const threadId = connected.thread.thread_id as string;
      const agentId = connected.agent.agent_id as string;
      const token = connected.agent.token as string;

      const controller = new AbortController();
      const waitPromise = fetch(`${address}/mcp/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          method: "tools/call",
          params: {
            name: "msg_wait",
            arguments: {
              thread_id: threadId,
              after_seq: connected.current_seq,
              agent_id: agentId,
              token,
              timeout_ms: 10_000,
              return_format: "json",
            },
          },
        }),
        signal: controller.signal,
      });

      await waitForCondition(() => getMemoryStore().getAgentWaitStatus(threadId, agentId).is_waiting);

      controller.abort();
      await expect(waitPromise).rejects.toThrow();

      await waitForCondition(() => {
        const status = getMemoryStore().getAgentWaitStatus(threadId, agentId);
        return !status.is_waiting && status.last_exit_reason === "client_abort";
      });

      const waitStatus = getMemoryStore().getAgentWaitStatus(threadId, agentId);
      expect(waitStatus.is_waiting).toBe(false);
      expect(waitStatus.status).toBe("canceled");
      expect(waitStatus.last_exit_reason).toBe("client_abort");
    } finally {
      await server.close();
    }
  }, 15_000);
});
