import pytest
import json
import os
import tempfile
import asyncio
from unittest.mock import patch, MagicMock
from src.tools.dispatch import _load_available_agents, handle_agent_invite

# Fake config files
DICT_CONFIG = {
    "copilot-cli": {
        "name": "copilot-cli",
        "invoke_command": "echo {thread_id} {session_id} {bus_address}",
        "enabled": True
    }
}

LIST_CONFIG = {
    "agents": [
        {
            "name": "copilot-cli",
            "invoke_command": "echo {thread_id} {session_id} {bus_address}",
            "enabled": True
        }
    ]
}

def test_load_available_agents_dict_format(monkeypatch):
    import src.tools.dispatch
    import pathlib

    def mock_exists(*args, **kwargs):
        return True

    class MockPath:
        def __init__(self, *args, **kwargs):
            pass
        def exists(self):
            return True

    monkeypatch.setattr(src.tools.dispatch.Path, "exists", lambda self: True)
    
    with patch("builtins.open", new_callable=MagicMock) as mock_open:
        mock_open.return_value.__enter__.return_value.read.return_value = json.dumps(DICT_CONFIG)
        agents = _load_available_agents()
        assert "copilot-cli" in agents
        assert agents["copilot-cli"]["name"] == "copilot-cli"

def test_load_available_agents_list_format(monkeypatch):
    import src.tools.dispatch

    monkeypatch.setattr(src.tools.dispatch.Path, "exists", lambda self: True)
    
    with patch("builtins.open", new_callable=MagicMock) as mock_open:
        mock_open.return_value.__enter__.return_value.read.return_value = json.dumps(LIST_CONFIG)
        agents = _load_available_agents()
        assert "copilot-cli" in agents
        assert agents["copilot-cli"]["name"] == "copilot-cli"

@pytest.mark.asyncio
async def test_handle_agent_invite(monkeypatch):
    import src.tools.dispatch

    # Mock _load_available_agents directly to avoid disk IO
    monkeypatch.setattr(src.tools.dispatch, "_load_available_agents", lambda: DICT_CONFIG)
    
    db = MagicMock()
    args = {
        "agent_name": "copilot-cli",
        "thread_id": "test-thread-id"
    }
    
    # We shouldn't hang on subprocess in test. But this runs the shell.
    # We will await it.
    result = await handle_agent_invite(db, args)
    assert len(result) == 1
    content = json.loads(result[0].text)
    assert content["ok"] is True
    assert content["agent_name"] == "copilot-cli"
    
    # Check that placeholders were correctly populated
    cmd_exec = content["command_executed"]
    assert "test-thread-id" in cmd_exec
    assert "http://" in cmd_exec
    # We assume '{session_id}' was replaced by a random uuid without braces
    assert "{" not in cmd_exec
    assert "}" not in cmd_exec
