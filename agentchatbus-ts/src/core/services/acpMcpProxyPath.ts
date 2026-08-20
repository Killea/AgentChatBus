import { existsSync } from "node:fs";
import path from "node:path";

const PROXY_FILE_NAME = "mcpProxy.mjs";

/**
 * Resolve the standalone ACP stdio MCP proxy script.
 *
 * The CLI is bundled as CJS (`dist/cli/index.js`), where `import.meta.url` is
 * empty. The proxy stays an ESM `.mjs` asset spawned as a child process, copied
 * next to the bundle as `dist/workers/mcpProxy.mjs` (same pattern as
 * `resolveWorkerPath` in interactivePtyChildBridge).
 */
export function resolveAcpMcpProxyScript(): string {
  const entryFile = path.resolve(process.argv[1] || process.cwd());
  const entryDir = path.dirname(entryFile);
  const candidates = [
    path.resolve(entryDir, "../workers", PROXY_FILE_NAME),
    path.resolve(entryDir, "../../transports/stdio", PROXY_FILE_NAME),
    path.resolve(entryDir, "../../src/transports/stdio", PROXY_FILE_NAME),
    path.resolve(process.cwd(), "dist/workers", PROXY_FILE_NAME),
    path.resolve(process.cwd(), "src/transports/stdio", PROXY_FILE_NAME),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Unable to locate ACP stdio MCP proxy '${PROXY_FILE_NAME}'. ` +
      `Checked: ${candidates.join(", ")}`,
  );
}
