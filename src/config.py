"""
AgentChatBus Configuration
"""
import os
import json
from pathlib import Path

# Project root
BASE_DIR = Path(__file__).resolve().parent.parent

# SQLite database file
_repo_default_db = BASE_DIR / "data" / "bus.db"
_user_default_db = Path.home() / ".agentchatbus" / "bus.db"

config_data = {}
_config_file = BASE_DIR / "data" / "config.json"
if _config_file.exists():
    try:
        with open(_config_file, "r", encoding="utf-8") as _f:
            config_data = json.load(_f)
    except Exception:
        pass

if os.getenv("AGENTCHATBUS_DB"):
	DB_PATH = os.getenv("AGENTCHATBUS_DB")
elif _repo_default_db.parent.exists():
	DB_PATH = str(_repo_default_db)
else:
	# Installed package mode normally runs outside repository checkout.
	DB_PATH = str(_user_default_db)

# HTTP server
HOST = os.getenv("AGENTCHATBUS_HOST", config_data.get("HOST", "0.0.0.0"))
PORT = int(os.getenv("AGENTCHATBUS_PORT", config_data.get("PORT", "39765")))

# Agent heartbeat timeout (seconds). Agents missing this window are marked offline.
AGENT_HEARTBEAT_TIMEOUT = int(os.getenv("AGENTCHATBUS_HEARTBEAT_TIMEOUT", config_data.get("AGENT_HEARTBEAT_TIMEOUT", "30")))

# SSE long-poll timeout for msg.wait (seconds)
MSG_WAIT_TIMEOUT = int(os.getenv("AGENTCHATBUS_WAIT_TIMEOUT", config_data.get("MSG_WAIT_TIMEOUT", "300")))
BUS_VERSION = "0.1.0"

# Rate limiting: max messages per minute per author identity (0 = disabled)
RATE_LIMIT_MSG_PER_MINUTE = int(os.getenv("AGENTCHATBUS_RATE_LIMIT", "30"))
RATE_LIMIT_ENABLED = RATE_LIMIT_MSG_PER_MINUTE > 0

def get_config_dict():
    return {
        "HOST": HOST,
        "PORT": PORT,
        "AGENT_HEARTBEAT_TIMEOUT": AGENT_HEARTBEAT_TIMEOUT,
        "MSG_WAIT_TIMEOUT": MSG_WAIT_TIMEOUT,
    }

def save_config_dict(new_data: dict):
    config_file = BASE_DIR / "data" / "config.json"
    config_file.parent.mkdir(parents=True, exist_ok=True)
    
    current = {}
    if config_file.exists():
        with open(config_file, "r", encoding="utf-8") as f:
            current = json.load(f)
            
    current.update(new_data)
    with open(config_file, "w", encoding="utf-8") as f:
        json.dump(current, f, indent=2)
