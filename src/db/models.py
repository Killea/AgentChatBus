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
    status: str          # discuss | implement | review | done | closed | archived
    created_at: datetime
    updated_at: Optional[datetime] = None  # last activity time, used for sorting
    closed_at: Optional[datetime] = None
    summary: Optional[str] = None
    metadata: Optional[str] = None  # JSON string for arbitrary extra data
    system_prompt: Optional[str] = None
    template_id: Optional[str] = None   # Template used at creation (UP-18)


@dataclass
class ThreadTemplate:
    """A reusable preset for thread creation (UP-18)."""
    id: str
    name: str
    description: Optional[str]
    system_prompt: Optional[str]
    default_metadata: Optional[str]  # JSON string
    created_at: datetime
    is_builtin: bool


@dataclass
class Message:
    id: str
    thread_id: str
    author: str          # legacy fallback field
    role: str            # user | assistant | system
    content: str
    seq: int             # monotonically increasing per-bus sequence number
    created_at: datetime
    metadata: Optional[str]  # JSON string
    author_id: Optional[str] = None
    author_name: Optional[str] = None
    reply_to_msg_id: Optional[str] = None
    priority: str = "normal"  # normal | urgent | system (UP-16)


@dataclass
class Reaction:
    """A reaction/annotation on a message (UP-13)."""
    id: str
    message_id: str
    agent_id: Optional[str]
    agent_name: Optional[str]
    reaction: str        # free-form string, e.g. "agree", "disagree", "important"
    created_at: datetime


@dataclass
class AgentInfo:
    id: str
    name: str              # auto-generated: "IDE (Model)" or "IDE (Model) 2"
    ide: str               # e.g. "Cursor", "Claude Desktop", "CLI"
    model: str             # e.g. "GPT-4", "claude-3-5-sonnet-20241022"
    description: str
    capabilities: Optional[str]   # JSON list of capability tags e.g. '["code", "review"]'
    registered_at: datetime
    last_heartbeat: datetime
    is_online: bool               # derived: last_heartbeat within timeout window
    token: str                    # simple auth token for heartbeat/unregister calls
    display_name: Optional[str] = None    # human-readable alias (auto-generated or user-provided)
    alias_source: Optional[str] = None    # 'auto' or 'user'
    last_activity: Optional[str] = None    # activity type: 'registered', 'heartbeat', 'msg_wait', 'msg_post', etc.
    last_activity_time: Optional[datetime] = None  # when the last activity occurred
    skills: Optional[str] = None          # JSON list of A2A-compatible skill objects (UP-15)


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


@dataclass
class ThreadSettings:
    """Settings for thread-level coordination and automation."""
    id: int
    thread_id: str
    auto_coordinator_enabled: bool = False
    timeout_seconds: int = 60               # 10-300 seconds
    last_activity_time: datetime = field(default_factory=lambda: datetime.now())
    auto_assigned_admin_id: Optional[str] = None
    auto_assigned_admin_name: Optional[str] = None
    admin_assignment_time: Optional[datetime] = None
    creator_admin_id: Optional[str] = None          # Thread creator as admin
    creator_admin_name: Optional[str] = None
    creator_assignment_time: Optional[datetime] = None
    created_at: datetime = field(default_factory=lambda: datetime.now())
    updated_at: datetime = field(default_factory=lambda: datetime.now())
