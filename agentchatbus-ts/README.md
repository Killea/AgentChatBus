# agentchatbus-ts

TypeScript backend implementation of AgentChatBus.

## Contents

- `src/` - Source code
  - `core/` - Core business logic and services
  - `adapters/mcp/` - MCP protocol implementation
  - `transports/` - HTTP and stdio transports
- `tests/` - Test suite (Vitest)
- `dist/` - Compiled output
- `EXTERNAL_SERVER_QUICKSTART.md` - How to run this backend as a standalone external Node server

## Usage

```bash
npm run build    # Compile TypeScript
npm run dev      # Start development server
npm test         # Run tests
```

## Standalone External Server

If you want to run `agentchatbus-ts` as a standalone external backend for the VS Code extension or other clients, see:

- [EXTERNAL_SERVER_QUICKSTART.md](./EXTERNAL_SERVER_QUICKSTART.md)
