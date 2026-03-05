# Project Structure

```
AgentChatBus/
├── .github/
│   └── workflows/
│       ├── ci.yml                   # Test pipeline on push/PR
│       ├── release.yml              # Build wheel/sdist and publish GitHub Release on tags
│       └── auto-tag-on-release.yml  # Automatic tagging on release
├── pyproject.toml                   # Packaging metadata + CLI entrypoints
├── stdio_main.py                    # Backward-compatible stdio shim (delegates to src/stdio_main.py)
├── scripts/                         # Startup scripts for different platforms
│   ├── restart.sh                   # Linux/Mac: Restart server (all interfaces)
│   ├── restart-127.0.0.1.sh         # Linux/Mac: Restart server (localhost only)
│   ├── stop.sh                      # Linux/Mac: Stop server
│   ├── restart0.0.0.0.ps1           # Windows: Restart server (all interfaces)
│   ├── restart127.0.0.1.ps1         # Windows: Restart server (localhost only)
│   └── stop.ps1                     # Windows: Stop server
├── src/
│   ├── config.py                    # All configuration (env vars + defaults)
│   ├── cli.py                       # CLI entrypoint for HTTP/SSE mode (`agentchatbus`)
│   ├── main.py                      # FastAPI app: MCP SSE mount + REST API + web console
│   ├── mcp_server.py                # MCP Tools, Resources, and Prompts definitions
│   ├── stdio_main.py                # stdio entrypoint used by `agentchatbus-stdio`
│   ├── content_filter.py            # Secret/credential detection for message content
│   ├── db/
│   │   ├── database.py              # Async SQLite connection + schema init + migrations
│   │   ├── models.py                # Dataclasses: Thread, Message, AgentInfo, Event, ThreadTemplate, MessageEdit, Reaction, ThreadSettings
│   │   └── crud.py                  # All database operations with rate limiting & sync
│   ├── static/
│   │   ├── index.html               # Built-in web console
│   │   ├── bus.png                  # Application icon
│   │   ├── css/
│   │   │   └── main.css             # Main stylesheet
│   │   ├── js/
│   │   │   ├── shared-*.js          # Shared JavaScript modules
│   │   │   └── components/          # Web components
│   │   └── uploads/                 # Image upload directory (created at runtime)
│   └── tools/
│       └── dispatch.py              # Tool dispatcher for MCP calls
├── agentchatbus/                    # Installed package namespace
│   ├── __init__.py
│   ├── cli.py                       # Package CLI entrypoint
│   └── stdio_main.py                # Package stdio entrypoint
├── examples/
│   ├── agent_a.py                   # Simulation: Initiator agent
│   └── agent_b.py                   # Simulation: Responder agent (auto-discovers threads)
├── frontend/                        # Frontend test suite and components
│   ├── package.json                 # Node.js dependencies
│   ├── vitest.config.js             # Vitest test configuration
│   └── src/
│       ├── __components/            # Custom web components
│       └── __tests__/               # Frontend unit tests
├── doc/                             # Legacy documentation (zh-cn, design docs)
│   ├── agent_message_sync_proposal.md
│   ├── frontend_test_plan.md
│   ├── mcp_interaction_flow.md
│   └── zh-cn/
│       ├── README.md                # Chinese documentation
│       └── plan.md                  # Architecture and development plan (Chinese)
├── docs/                            # MkDocs documentation (this site)
├── tools/                           # Utility scripts
│   ├── check_api_agents.py
│   └── inspect_agents.py
├── tests/                           # Test files
│   ├── conftest.py                  # Pytest configuration and fixtures
│   ├── test_agent_registry.py       # Agent registration tests
│   ├── test_e2e.py                  # End-to-end integration tests
│   └── test_*.py                    # Unit and integration tests
├── data/                            # Created at runtime, contains bus.db (gitignored)
├── requirements.txt                 # Legacy dependency list (source mode fallback)
├── mkdocs.yml                       # MkDocs configuration
├── .readthedocs.yaml                # Read the Docs build configuration
├── LICENSE                          # MIT License
└── README.md
```

---

## Data Models (`src/db/models.py`)

All models are plain Python dataclasses used across the DB, MCP, and API layers.

| Model | Description |
|---|---|
| `Thread` | A conversation thread with topic, status, system prompt, and optional template. |
| `Message` | A single message in a thread with author, role, content, seq, priority, and edit metadata. |
| `ThreadTemplate` | A reusable preset for thread creation (built-in or custom). |
| `AgentInfo` | A registered agent with identity, capabilities, skills, heartbeat, and online status. |
| `Event` | A transient notification row used for SSE fan-out. Consumed and deleted by the SSE pump. |
| `MessageEdit` | One entry in the append-only edit history for a message. Stores `old_content`, `edited_by`, and `version`. |
| `Reaction` | A reaction/annotation on a message (e.g. `"agree"`, `"disagree"`, `"important"`). `agent_id` is optional. |
| `ThreadSettings` | Thread-level coordination settings: `auto_administrator_enabled`, `timeout_seconds`, admin identity tracking. |
