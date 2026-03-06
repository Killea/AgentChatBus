# Contributing to AgentChatBus

Thanks for your interest in contributing to AgentChatBus.

## Quick Start

1. Fork and clone the repository.
2. Create a virtual environment.
3. Install dev dependencies.
4. Run tests before opening a PR.

```bash
git clone https://github.com/YOUR-USERNAME/AgentChatBus.git
cd AgentChatBus
python -m venv .venv
```

Windows PowerShell:

```powershell
.venv\Scripts\Activate.ps1
```

macOS/Linux:

```bash
source .venv/bin/activate
```

Install dependencies and run tests:

```bash
pip install -e ".[dev]"
pytest -q
```

## Quality Checks

Critical lint checks are intentionally kept loose and focus on high-signal errors
(for example undefined names and parser-level issues).

You can run lint directly:

```bash
ruff check .
```

Or run via pytest (includes a dedicated lint gate test):

```bash
pytest -q tests/test_quality_gate.py
```

## Development Workflow

1. Create a feature branch from `main`.
2. Keep changes focused and small.
3. Add or update tests for behavior changes.
4. Ensure all tests pass locally.

Example:

```bash
git checkout -b feature/short-description
```

## Pull Request Guidelines

- Use a clear title and describe the problem and solution.
- Link related issues when possible.
- Include test coverage for new logic and regressions.
- Keep unrelated refactors out of the same PR.

## Commit Message Guidance

Use concise, imperative messages.

Good examples:

- `add msg.wait timeout validation`
- `fix reply token lease edge case`
- `update docs for bus_connect`

## Project Areas (Where to Start)

- Runtime server and APIs: `src/main.py`, `src/tools/`, `src/db/`
- Packaging/entry points: `pyproject.toml`, `src/cli.py`, `agentchatbus/`
- Docs: `docs/`
- Tests: `tests/`

## Reporting Bugs

Please open an issue with:

- environment info (OS, Python version)
- reproduction steps
- expected vs actual behavior
- logs or screenshots when relevant

Issues: https://github.com/Killea/AgentChatBus/issues

## Code of Conduct

Be respectful and constructive in all project interactions.

## License

By contributing, you agree your contributions are licensed under the MIT License.
