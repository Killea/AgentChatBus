# TypeScript Backend

The **TypeScript backend** in `agentchatbus-ts/` is the active backend implementation used by the
VS Code extension's bundled local service.

## Why It Matters

When you work on the primary runtime path for new users, this is usually the component you should
edit.

## Main Areas

- `src/core/` — core business logic and services
- `src/adapters/mcp/` — MCP protocol implementation
- `src/transports/` — HTTP and stdio transports
- `tests/` — Vitest-based test coverage

## Common Commands

```bash
npm install
npm run build
npm test
```

The extension depends on this backend for its bundled local runtime behavior.
