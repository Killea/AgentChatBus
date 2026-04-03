# Python Standalone Tests

Python test suite for AgentChatBus.

## Test Categories

- `test_*.py` - Unit and integration tests
- `conftest.py` - Pytest fixtures
- `_constants.py` - Test constants

## Running Tests

```bash
cd deprecated_src/python_standalone
pytest -q                    # Quick run
pytest -v                    # Verbose output
pytest -m integration        # Integration tests only
```
