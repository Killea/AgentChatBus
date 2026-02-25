"""
AgentChatBus Configuration
"""
import os
from pathlib import Path

# Project root
BASE_DIR = Path(__file__).resolve().parent.parent

# SQLite database file
DB_PATH = os.getenv("AGENTCHATBUS_DB", str(BASE_DIR / "data" / "bus.db"))

# HTTP server
HOST = os.getenv("AGENTCHATBUS_HOST", "127.0.0.1")
PORT = int(os.getenv("AGENTCHATBUS_PORT", "8765"))

# Agent heartbeat timeout (seconds). Agents missing this window are marked offline.
AGENT_HEARTBEAT_TIMEOUT = int(os.getenv("AGENTCHATBUS_HEARTBEAT_TIMEOUT", "30"))

# SSE long-poll timeout for msg.wait (seconds)
MSG_WAIT_TIMEOUT = int(os.getenv("AGENTCHATBUS_WAIT_TIMEOUT", "60"))
