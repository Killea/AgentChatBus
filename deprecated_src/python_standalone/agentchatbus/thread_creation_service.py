"""Shared thread creation service with strict creator authentication.

Both REST and MCP paths must use this function to avoid drift.
"""

from __future__ import annotations

from typing import Any

from agentchatbus.db import crud


class CreatorAuthError(Exception):
    pass


class CreatorNotFoundError(Exception):
    pass


async def create_thread_with_verified_creator(
    db,
    *,
    topic: str,
    creator_agent_id: str,
    creator_token: str,
    metadata: dict | None = None,
    system_prompt: str | None = None,
    template: str | None = None,
) -> tuple[Any, dict]:
    """Create a thread only after validating creator identity and token.

    Returns:
        (thread, sync_context)
    """
    if not creator_agent_id:
        raise CreatorAuthError("creator_agent_id is required")
    if not creator_token:
        raise CreatorAuthError("creator_token is required")

    creator_agent = await crud.agent_get(db, creator_agent_id)
    if creator_agent is None:
        raise CreatorNotFoundError("creator_agent_id must be a registered agent")

    token_ok = await crud.agent_verify_token(db, creator_agent_id, creator_token)
    if not token_ok:
        raise CreatorAuthError("Invalid agent token")

    thread = await crud.thread_create(
        db,
        topic,
        metadata,
        system_prompt,
        template=template,
        creator_admin_id=creator_agent.id,
        creator_admin_name=(creator_agent.display_name or creator_agent.name),
    )

    await crud._set_agent_activity(db, creator_agent.id, "thread_create", touch_heartbeat=True)
    sync = await crud.issue_reply_token(
        db,
        thread_id=thread.id,
        agent_id=creator_agent.id,
        source="thread_create",
    )
    return thread, sync
