"""
Data models (dataclasses) for AgentChatBus.
These are plain Python objects used across the DB, MCP, and API layers.
"""
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional, Any


@dataclass
class Thread:
    id: str
    topic: str
    status: str          # discuss | implement | review | done | closed
    created_at: datetime
    closed_at: Optional[datetime]
    summary: Optional[str]
    metadata: Optional[str]  # JSON string for arbitrary extra data


@dataclass
class Message:
    id: str
    thread_id: str
    author: str          # agent_id or "system" or "human"
    role: str            # user | assistant | system
    content: str
    seq: int             # monotonically increasing per-bus sequence number
    created_at: datetime
    metadata: Optional[str]  # JSON string


@dataclass
class AgentInfo:
    id: str
    name: str
    description: str
    capabilities: Optional[str]   # JSON list of capability tags
    registered_at: datetime
    last_heartbeat: datetime
    is_online: bool               # derived: last_heartbeat within timeout window
    token: str                    # simple auth token for heartbeat/unregister calls


@dataclass
class Event:
    """
    Transient notification row used to fan-out SSE events to subscribers.
    Rows are written by any mutating operation and consumed+deleted by the SSE pump.
    """
    id: int
    event_type: str      # msg.new | thread.state | agent.online | agent.offline | agent.typing
    thread_id: Optional[str]
    payload: str         # JSON string
    created_at: datetime
