# Monorepo Structure

AgentChatBus is now a **multi-component repository**, not just a Python server package. The active
user-facing product is the VS Code extension plus the TypeScript backend, while the Python backend
remains in the repo as a deprecated legacy path.

## High-Level Layout

```text
AgentChatBus/
├── vscode-agentchatbus/      # VS Code extension (primary user-facing product)
├── agentchatbus-ts/          # TypeScript backend used by the extension
├── deprecated_src/
│   └── python_standalone/    # Deprecated Python backend source root
├── web-ui/                   # Shared browser UI assets
├── docs/                     # MkDocs documentation
├── frontend/                 # Frontend/unit test assets
├── shared-contracts/         # Shared schemas/contracts across components
└── .github/workflows/        # CI, packaging, and release automation
```

---

## Current Product Direction

- **VS Code extension**: primary onboarding path and daily user experience
- **TypeScript backend**: primary runtime used by the extension's bundled local service
- **Python backend**: deprecated, retained for compatibility and legacy/self-hosted workflows
- **Docs/reference**: shared protocol and product documentation across the monorepo

---

## Component Roles

### `vscode-agentchatbus/`

Owns:

- the extension manifest and commands
- the activity bar views and embedded chat panel
- setup and management flows inside VS Code
- launching or connecting to a local AgentChatBus backend

### `agentchatbus-ts/`

Owns:

- the active backend implementation used by the extension
- transport handling and core runtime behavior in TypeScript
- TypeScript-side tests and build output

### `deprecated_src/python_standalone/`

Own:

- the deprecated Python backend package at `deprecated_src/python_standalone/agentchatbus/`
- the Python backend tests at `deprecated_src/python_standalone/tests/`
- the Python packaging entrypoint at `deprecated_src/python_standalone/pyproject.toml`
- historical HTTP/SSE and stdio startup paths
- legacy package entrypoints such as `agentchatbus` and `agentchatbus-stdio`

### `docs/`

Owns:

- extension-first onboarding
- MCP/reference material
- legacy Python backend documentation
- development-oriented monorepo documentation

---

## Practical Contributor Mental Model

When you touch this repo, first decide which component you are working on:

- extension UX or setup flow → `vscode-agentchatbus/`
- current backend/runtime behavior → `agentchatbus-ts/`
- legacy compatibility or Python maintenance → `deprecated_src/python_standalone/`
- shared product messaging or onboarding → `README.md` and `docs/`

This split is the most important architectural fact for new contributors.
