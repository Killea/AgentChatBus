import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveAcpMcpProxyScript, resolveAcpSocketProxyScript } from "../../src/core/services/acpMcpProxyPath.js";

const SOURCE_MCP_PROXY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/transports/stdio/mcpProxy.mjs",
);

const SOURCE_SOCKET_PROXY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/transports/socket/proxy.mjs",
);

describe("ACP stdio MCP proxy path", () => {
  it("resolves an existing mcpProxy.mjs", () => {
    const resolved = resolveAcpMcpProxyScript();
    expect(existsSync(resolved)).toBe(true);
    expect(path.basename(resolved)).toBe("mcpProxy.mjs");
    expect(resolved).not.toMatch(/^\/[A-Za-z]:/);
  });

  it("finds the source script when the bundled worker copy is absent", () => {
    const originalArgv1 = process.argv[1];
    process.argv[1] = path.join(path.dirname(SOURCE_MCP_PROXY), "not-the-cli.js");
    try {
      const resolved = resolveAcpMcpProxyScript();
      expect(path.normalize(resolved)).toBe(path.normalize(SOURCE_MCP_PROXY));
    } finally {
      process.argv[1] = originalArgv1;
    }
  });
});

describe("ACP socket proxy path", () => {
  it("resolves an existing proxy.mjs", () => {
    const resolved = resolveAcpSocketProxyScript();
    expect(existsSync(resolved)).toBe(true);
    expect(path.basename(resolved)).toBe("proxy.mjs");
    expect(resolved).not.toMatch(/^\/[A-Za-z]:/);
  });

  it("finds the source script when the bundled copy is absent", () => {
    const originalArgv1 = process.argv[1];
    process.argv[1] = path.join(path.dirname(SOURCE_SOCKET_PROXY), "not-the-cli.js");
    try {
      const resolved = resolveAcpSocketProxyScript();
      expect(path.normalize(resolved)).toBe(path.normalize(SOURCE_SOCKET_PROXY));
    } finally {
      process.argv[1] = originalArgv1;
    }
  });
});
