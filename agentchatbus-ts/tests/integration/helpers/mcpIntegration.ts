import { expect } from "vitest";
import { createHttpServer } from "../../../src/transports/http/server.js";

export type TextBlock = { type: "text"; text: string };

export function parseMcpTextPayload(response: { json: () => { result: Array<{ type: string; text?: string }> } }) {
  const result = response.json().result;
  expect(Array.isArray(result)).toBe(true);
  expect(result[0]?.type).toBe("text");
  return JSON.parse(String(result[0].text || "{}"));
}

export async function callMcpTool(
  server: ReturnType<typeof createHttpServer>,
  name: string,
  args: Record<string, unknown>,
) {
  const response = await server.inject({
    method: "POST",
    url: "/mcp/messages/",
    payload: {
      method: "tools/call",
      params: {
        name,
        arguments: args,
      },
    },
  });
  expect(response.statusCode).toBe(200);
  return parseMcpTextPayload(response);
}

export async function listMessagesJson(
  server: ReturnType<typeof createHttpServer>,
  threadId: string,
) {
  const response = await server.inject({
    method: "POST",
    url: "/mcp/messages/",
    payload: {
      method: "tools/call",
      params: {
        name: "msg_list",
        arguments: {
          thread_id: threadId,
          return_format: "json",
        },
      },
    },
  });
  expect(response.statusCode).toBe(200);
  const blocks = response.json().result as Array<{ type: string; text: string }>;
  return JSON.parse(blocks[0].text) as Array<{ msg_id: string; author_name?: string; content?: string }>;
}

export function parseMsgPostResult<T = Record<string, unknown>>(result: unknown): T {
  const blocks = result as Array<{ type: string; text: string }>;
  expect(blocks).toHaveLength(1);
  expect(blocks[0]?.type).toBe("text");
  return JSON.parse(blocks[0].text) as T;
}

export function parseMsgListJson(result: unknown): Array<Record<string, unknown>> {
  const blocks = result as Array<{ type: string; text: string }>;
  expect(blocks).toHaveLength(1);
  return JSON.parse(blocks[0].text) as Array<Record<string, unknown>>;
}

export function asTextBlocks(result: unknown): TextBlock[] {
  expect(Array.isArray(result)).toBe(true);
  return result as TextBlock[];
}

export function parseJsonTextBlock(result: unknown): unknown {
  const blocks = asTextBlocks(result);
  expect(blocks[0]?.type).toBe("text");
  return JSON.parse(blocks[0].text);
}
