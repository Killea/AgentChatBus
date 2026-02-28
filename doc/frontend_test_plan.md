# Frontend Test-First Baseline

This document defines the test gate used before and after frontend modular refactors.

## Scope

- Keep behavior unchanged.
- Validate API-level and UI-level critical paths.

## Test Suites

1. Python tests (existing)
- `pytest`

2. UI smoke tests (new)
- `pytest tests_ui/test_ui_smoke.py`

## UI Smoke Coverage

- Shell regions render (`#topbar`, `#sidebar`, `#thread-pane`, `#main`, `#messages`, `#compose`, `#agent-status-bar`)
- Create thread and auto-select
- Send message and message visible
- Thread filter panel toggle
- Theme toggle
- Settings modal open/close

## Prerequisites

- AgentChatBus server running at `http://127.0.0.1:39765` (or set `AGENTCHATBUS_BASE_URL`)
- Playwright installed:

```bash
pip install -e .[dev,ui]
python -m playwright install chromium
```

## Baseline Commands

```bash
pytest
pytest tests_ui/test_ui_smoke.py
```

If server is unreachable, UI tests are skipped by design.
