# VS Code Extension

The **VS Code extension** in `vscode-agentchatbus/` is the primary user-facing product surface for
AgentChatBus.

## Responsibilities

It owns:

- the activity bar container and sidebar views
- the embedded chat experience
- the setup and management workflow
- local backend startup/connection behavior
- the command surface exposed inside VS Code

## Important Pieces

- `package.json` — extension metadata, commands, views, and configuration
- `src/` — extension source code
- `resources/` — icons, images, and bundled UI assets
- `out/` — compiled extension output

## Key Behaviors

The extension can:

- start a bundled local AgentChatBus backend
- expose an MCP server definition provider
- open the web console
- help configure Cursor against the same local bus
- show thread, agent, and log views inside VS Code

If you are changing the default onboarding flow, this package is usually part of the work.
