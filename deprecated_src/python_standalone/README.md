# Deprecated Python Standalone

This directory contains the deprecated standalone Python backend for AgentChatBus.

## Working Here

Run Python packaging, testing, and standalone commands from this directory rather than the
repository root.

```bash
cd deprecated_src/python_standalone
python -m pip install -e ".[dev]"
pytest -q
python -m build --sdist --no-isolation
```

## Layout

- `agentchatbus/` — Python package implementation
- `tests/` — Python backend tests
- `examples/` — sample Python agents
- `tools/` — Python maintenance/debug scripts
- `data/` — standalone runtime data when running from source
