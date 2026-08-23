import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Resolve a standalone ACP proxy script that ships as an ESM `.mjs` asset.
 *
 * The CLI is bundled as CJS (`dist/cli/index.js`), where `import.meta.url` is
 * empty. `new URL("...", import.meta.url).pathname` therefore produces unusable
 * paths (empty string, or `/C:/...` on Windows). These resolvers use
 * `process.argv[1]` + `cwd` candidates instead, mirroring the pattern used by
 * `resolveWorkerPath` in interactivePtyChildBridge.
 *
 * On Windows, `path.resolve` returns native `C:\...` paths (no leading `/`),
 * so the result is safe to pass to `spawn()` / `child_process`.
 */

/**
 * Resolve the V1 stdio MCP proxy (`mcpProxy.mjs`).
 * Bundled to `dist/workers/mcpProxy.mjs`; source at `src/transports/stdio/`.
 */
export function resolveAcpMcpProxyScript(): string {
  const entryFile = path.resolve(process.argv[1] || process.cwd());
  const entryDir = path.dirname(entryFile);
  const candidates = [
    path.resolve(entryDir, "../workers", "mcpProxy.mjs"),
    path.resolve(entryDir, "../../transports/stdio", "mcpProxy.mjs"),
    path.resolve(entryDir, "../../src/transports/stdio", "mcpProxy.mjs"),
    path.resolve(process.cwd(), "dist/workers", "mcpProxy.mjs"),
    path.resolve(process.cwd(), "src/transports/stdio", "mcpProxy.mjs"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Unable to locate ACP stdio MCP proxy 'mcpProxy.mjs'. ` +
      `Checked: ${candidates.join(", ")}`,
  );
}

/**
 * Resolve the V2 socket proxy (`proxy.mjs`).
 * Bundled to `dist/transports/socket/proxy.mjs`; source at `src/transports/socket/`.
 */
export function resolveAcpSocketProxyScript(): string {
  const entryFile = path.resolve(process.argv[1] || process.cwd());
  const entryDir = path.dirname(entryFile);
  const candidates = [
    path.resolve(entryDir, "../transports/socket", "proxy.mjs"),
    path.resolve(entryDir, "../../transports/socket", "proxy.mjs"),
    path.resolve(entryDir, "../../src/transports/socket", "proxy.mjs"),
    path.resolve(process.cwd(), "dist/transports/socket", "proxy.mjs"),
    path.resolve(process.cwd(), "src/transports/socket", "proxy.mjs"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Unable to locate ACP socket proxy 'proxy.mjs'. ` +
      `Checked: ${candidates.join(", ")}`,
  );
}
