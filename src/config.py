"""
AgentChatBus Configuration
"""
import os
from pathlib import Path

# Project root
BASE_DIR = Path(__file__).resolve().parent.parent

# SQLite database file
_repo_default_db = BASE_DIR / "data" / "bus.db"
_user_default_db = Path.home() / ".agentchatbus" / "bus.db"

if os.getenv("AGENTCHATBUS_DB"):
	DB_PATH = os.getenv("AGENTCHATBUS_DB")
elif _repo_default_db.parent.exists():
	DB_PATH = str(_repo_default_db)
else:
	# Installed package mode normally runs outside repository checkout.
	DB_PATH = str(_user_default_db)

# HTTP server
HOST = os.getenv("AGENTCHATBUS_HOST", "0.0.0.0")
PORT = int(os.getenv("AGENTCHATBUS_PORT", "39765"))

# Agent heartbeat timeout (seconds). Agents missing this window are marked offline.
AGENT_HEARTBEAT_TIMEOUT = int(os.getenv("AGENTCHATBUS_HEARTBEAT_TIMEOUT", "30"))

# SSE long-poll timeout for msg.wait (seconds)
MSG_WAIT_TIMEOUT = int(os.getenv("AGENTCHATBUS_WAIT_TIMEOUT", "300"))
BUS_VERSION = "0.1.0"
