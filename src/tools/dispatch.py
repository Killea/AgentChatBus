"""
Dynamic tool dispatch layer for AgentChatBus.
This module is hot-reloaded by `mcp_server.py` to allow live updates to tool logic
without dropping connections.
"""
import json
import asyncio
import logging
import base64
import mimetypes
from dataclasses import replace
from pathlib import Path
from typing import Any
from datetime import datetime, timezone

import mcp.types as types

from src.db.database import get_db
import sys
import importlib
if "src.config" in sys.modules:
    importlib.reload(sys.modules["src.config"])
if "src.db.models" in sys.modules:
    importlib.reload(sys.modules["src.db.models"])
if "src.db.crud" in sys.modules:
    importlib.reload(sys.modules["src.db.crud"])
from src.db import crud
from src.db.crud import (
    RateLimitExceeded,
    MissingSyncFieldsError,
    SeqMismatchError,
    ReplyTokenInvalidError,
    ReplyTokenExpiredError,
    ReplyTokenReplayError,
    MessageNotFoundError,
    MessageEditNoChangeError,
)
from src.db.models import Message
import src.mcp_server
from src.config import BUS_VERSION, HOST, PORT, MSG_WAIT_TIMEOUT, ENABLE_HANDOFF_TARGET, ENABLE_STOP_REASON, ENABLE_PRIORITY
from src.content_filter import ContentFilterError
from src.thread_creation_service import (
    create_thread_with_verified_creator,
    CreatorAuthError,
    CreatorNotFoundError,
)
import os

logger = logging.getLogger(__name__)
AGENT_HUMAN_ONLY_PLACEHOLDER = "[human-only content hidden]"
AGENT_HUMAN_ONLY_METADATA_KEYS = {
    "visibility",
    "audience",
    "ui_type",
    "handoff_target",
    "target_admin_id",
    "source_message_id",
    "decision_type",
}


def _safe_json_loads(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return value
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value:
        return None
    try:
        return json.loads(value)
    except Exception:
        return None


def _message_metadata_dict(value: Any) -> dict[str, Any] | None:
    meta = _safe_json_loads(value)
    return meta if isinstance(meta, dict) else None


def _is_human_only_metadata(value: Any) -> bool:
    meta = _message_metadata_dict(value)
    if not isinstance(meta, dict):
        return False
    visibility = str(meta.get("visibility") or "").strip().lower()
    audience = str(meta.get("audience") or "").strip().lower()
    return visibility == "human_only" or audience == "human"


def _project_metadata_json_for_agent(value: Any) -> str | None:
    if not _is_human_only_metadata(value):
        if value is None:
            return None
        if isinstance(value, str):
            return value
        if isinstance(value, dict):
            return json.dumps(value)
        return None

    meta = _message_metadata_dict(value) or {}
    projected_meta = {
        key: value
        for key, value in meta.items()
        if key in AGENT_HUMAN_ONLY_METADATA_KEYS
    }
    projected_meta["visibility"] = projected_meta.get("visibility") or "human_only"
    projected_meta["content_hidden"] = True
    projected_meta["content_hidden_reason"] = "human_only"
    return json.dumps(projected_meta)


def _project_content_for_agent(metadata: Any, content: str | None) -> str | None:
    if _is_human_only_metadata(metadata):
        return AGENT_HUMAN_ONLY_PLACEHOLDER
    return content


def _project_message_for_agent(msg: Message) -> Message:
    if not _is_human_only_metadata(getattr(msg, "metadata", None)):
        return msg
    return replace(
        msg,
        content=_project_content_for_agent(msg.metadata, msg.content),
        metadata=_project_metadata_json_for_agent(msg.metadata),
    )


def _project_message_dict_for_agent(message: dict[str, Any]) -> dict[str, Any]:
    if not _is_human_only_metadata(message.get("metadata")):
        return message
    projected = dict(message)
    projected["content"] = _project_content_for_agent(message.get("metadata"), message.get("content"))
    projected["metadata"] = _project_metadata_json_for_agent(message.get("metadata"))
    return projected


def _project_messages_for_agent(messages: list[Message]) -> list[Message]:
    return [_project_message_for_agent(message) for message in messages]


def _project_message_dicts_for_agent(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [_project_message_dict_for_agent(message) for message in messages]


def _project_edit_history_payload_for_agent(
    message: Message,
    edits: list[Any],
) -> dict[str, Any]:
    hidden = _is_human_only_metadata(message.metadata)
    return {
        "message_id": message.id,
        "current_content": _project_content_for_agent(message.metadata, message.content),
        "edit_version": message.edit_version,
        "edits": [
            {
                "version": edit.version,
                "old_content": AGENT_HUMAN_ONLY_PLACEHOLDER if hidden else edit.old_content,
                "edited_by": edit.edited_by,
                "created_at": edit.created_at.isoformat(),
            }
            for edit in edits
        ],
    }


def _project_search_results_for_agent(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    projected_results: list[dict[str, Any]] = []
    for result in results:
        projected = dict(result)
        if _is_human_only_metadata(projected.get("metadata")):
            projected["snippet"] = AGENT_HUMAN_ONLY_PLACEHOLDER
        projected.pop("metadata", None)
        projected_results.append(projected)
    return projected_results


def _strip_data_url(value: str) -> tuple[str | None, str | None]:
    """Parse a data URL like 'data:image/png;base64,AAAA' and return (mime, data)."""
    if not isinstance(value, str):
        return None, None
    if not value.startswith("data:"):
        return None, None
    header, sep, payload = value.partition(",")
    if not sep:
        return None, None
    mime_part = header[5:]  # strip 'data:'
    if ";" in mime_part:
        mime_part = mime_part.split(";", 1)[0]
    mime_part = mime_part.strip() or None
    payload = payload.strip() or None
    return mime_part, payload


def _url_to_local_upload_path(url: str) -> Path | None:
    """Map '/static/uploads/...' URLs to local files under src/static/uploads."""
    if not isinstance(url, str):
        return None
    if not url.startswith("/static/uploads/"):
        return None

    rel = url[len("/static/uploads/"):]
    
    # dispatch.py is in src/tools/.
    # So Path(__file__).resolve().parent is src/tools/
    # parent[0] is src/, parent[1] is project root
    tools_dir = Path(__file__).resolve().parent
    src_dir = tools_dir.parent  # src/
    uploads_root = src_dir / "static" / "uploads"
    
    candidate = (uploads_root / rel).resolve()

    # Validate that candidate is within uploads_root
    try:
        candidate.relative_to(uploads_root)
    except ValueError:
        return None

    return candidate


def _message_to_blocks(m: Message) -> list[types.Content]:
    m = _project_message_for_agent(m)
    author = m.author_name or m.author
    created = m.created_at.isoformat() if getattr(m, "created_at", None) else ""
    blocks: list[types.Content] = [
        types.TextContent(
            type="text",
            text=f"[{m.seq}] {author} ({m.role}) {created}",
        )
    ]

    if m.content:
        blocks.append(types.TextContent(type="text", text=m.content))

    meta = _safe_json_loads(m.metadata)
    if isinstance(meta, dict):
        attachments = meta.get("attachments")
        if attachments is None:
            attachments = meta.get("images")  # Web UI format: list of {"url": "/static/uploads/...", "name": "..."}
        if attachments is None:
            attachments = meta.get("image")

        if isinstance(attachments, dict):
            attachments = [attachments]

        if isinstance(attachments, list):
            for att in attachments:
                if not isinstance(att, dict):
                    continue
                kind = (att.get("type") or att.get("kind") or "").lower()
                mime_type = att.get("mimeType") or att.get("mime_type")
                data = att.get("data") or att.get("base64") or att.get("b64") or att.get("data_url")
                url = att.get("url") or att.get("src")

                if isinstance(data, str):
                    inferred_mime, stripped = _strip_data_url(data)
                    if stripped is not None:
                        data = stripped
                        if not mime_type and inferred_mime:
                            mime_type = inferred_mime

                if not mime_type and kind == "image":
                    mime_type = "image/png"

                if not data:
                    # Support URL-backed uploads from web UI metadata, e.g. {"url": "/static/uploads/.."}
                    if isinstance(url, str):
                        local_path = _url_to_local_upload_path(url)
                        if local_path and local_path.exists():
                            try:
                                raw = local_path.read_bytes()
                                data = base64.b64encode(raw).decode("ascii")
                                guessed_mime = mimetypes.guess_type(local_path.name)[0]
                                if not mime_type and guessed_mime:
                                    mime_type = guessed_mime
                                logger.info(f"[_message_to_blocks] Loaded image from {url}: {len(data)} bytes, mime={mime_type}")
                            except Exception as e:
                                logger.warning(f"[_message_to_blocks] Failed to read {local_path}: {e}")
                                data = None

                    # If still no embeddable bytes, keep image reference visible as text.
                    if not data and isinstance(url, str):
                        blocks.append(types.TextContent(type="text", text=f"[image] {url}"))
                        continue

                    if not data:
                        continue
                if kind and kind != "image" and not (mime_type and str(mime_type).startswith("image/")):
                    continue
                if mime_type and not str(mime_type).startswith("image/"):
                    continue

                blocks.append(
                    types.ImageContent(
                        type="image",
                        data=str(data),
                        mimeType=str(mime_type or "image/png"),
                    )
                )

    return blocks

async def handle_bus_connect(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    # ── Phase 1: Agent Identity (Register or Resume) ──
    agent = None
    
    # Route 1: Resume existing agent via agent_id + token
    agent_id = arguments.get("agent_id")
    token = arguments.get("token")
    if agent_id and token:
        try:
            agent = await crud.agent_resume(db, agent_id, token)
            logger.info(f"[bus_connect] client_type=bus_connect (resume) agent_id={agent.id}")
        except ValueError as e:
            return [types.TextContent(type="text", text=json.dumps({
                "error": f"Failed to resume agent: {str(e)}",
            }))]
    
    # Route 2/3: Register new agent (with or without metadata)
    if not agent:
        ide = arguments.get("ide", "Unknown IDE")
        model = arguments.get("model", "Unknown Model")
        description = arguments.get("description")
        capabilities = arguments.get("capabilities")
        if capabilities is not None and not isinstance(capabilities, list):
            return [types.TextContent(type="text", text=json.dumps({
                "error": "capabilities must be an array of strings",
            }))]

        display_name = arguments.get("display_name")
        skills = arguments.get("skills")
        if skills is not None and not isinstance(skills, list):
            return [types.TextContent(type="text", text=json.dumps({
                "error": "skills must be an array of objects",
            }))]
        
        agent = await crud.agent_register(
            db,
            ide=ide,
            model=model,
            description=description or "",
            capabilities=capabilities,
            display_name=display_name,
            skills=skills,
        )
        logger.info(f"[agent_register] client_type=bus_connect agent_id={agent.id}")

    src.mcp_server.set_connection_agent(agent.id, agent.token)
    src.mcp_server._current_agent_id.set(agent.id)
    src.mcp_server._current_agent_token.set(agent.token)

    # ── Phase 2: Find or Create Thread ──
    thread_name = arguments.get("thread_name")
    if not thread_name:
         return [types.TextContent(type="text", text=json.dumps({"error": "thread_name is required"}))]
         
    thread = await crud.thread_get_by_topic(db, thread_name)
    thread_created = False

    if thread is None:
        thread = await crud.thread_create(
            db,
            topic=thread_name,
            creator_admin_id=agent.id,
            creator_admin_name=(agent.display_name or agent.name),
            system_prompt=arguments.get("system_prompt"),
            template=arguments.get("template"),
        )
        thread_created = True

    # ── Phase 3: Fetch Messages + Bus-Connect Sync Context ──
    after_seq = arguments.get("after_seq", 0)
    msgs = await crud.msg_list(db, thread.id, after_seq=after_seq)
    msgs = _project_messages_for_agent(msgs)
    # Keep only one issued bus_connect token per (thread, agent).
    await crud.reply_tokens_invalidate_for_agent_source(
        db,
        thread_id=thread.id,
        agent_id=agent.id,
        source="bus_connect",
    )
    sync = await crud.issue_reply_token(
        db,
        thread_id=thread.id,
        agent_id=agent.id,
        source="bus_connect",
    )

    # ── Phase 4: Identify Administrator Role ──
    settings = await crud.thread_settings_get_or_create(db, thread.id)
    admin_id = settings.auto_assigned_admin_id or settings.creator_admin_id
    admin_name = settings.auto_assigned_admin_name or settings.creator_admin_name

    is_administrator = False
    role_assignment = "You are a PARTICIPANT in this thread. Please wait for the administrator to coordinate or assign you tasks."
    
    if admin_id:
        if admin_id == agent.id:
            is_administrator = True
            role_assignment = "You are the ADMINISTRATOR for this thread. You are responsible for coordination and task assignment."
        else:
            role_assignment = f"You are a PARTICIPANT in this thread. Please wait for the administrator (@{admin_id}) to coordinate or assign you tasks."

    # ── Assemble Result ──
    agent_payload: dict[str, Any] = {
        "agent_id": agent.id,
        "name": agent.name,
        "registered": True,
        "token": agent.token,
        "is_administrator": is_administrator,
        "role_assignment": role_assignment,
    }

    thread_payload: dict[str, Any] = {
        "thread_id": thread.id,
        "topic": thread.topic,
        "status": thread.status,
        "created": thread_created,
    }

    if thread_created and thread.system_prompt:
        thread_payload["system_prompt"] = thread.system_prompt
    
    if admin_id:
        thread_payload["administrator"] = {
            "agent_id": admin_id,
            "name": admin_name,
        }

    return [types.TextContent(type="text", text=json.dumps({
        "agent": agent_payload,
        "thread": thread_payload,
        "messages": [
            {
                "seq": m.seq,
                "author": m.author_name or m.author,
                "role": m.role,
                "content": m.content,
                "created_at": m.created_at.isoformat()
            }
            for m in msgs
        ],
        "current_seq": sync["current_seq"],
        "reply_token": sync["reply_token"],
        "reply_window": sync["reply_window"],
    }))]

async def handle_bus_get_config(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    session_lang = src.mcp_server._session_language.get()
    effective_lang = session_lang or "English"
    source = "url_param" if session_lang else "default"
    return [types.TextContent(type="text", text=json.dumps({
        "preferred_language": effective_lang,
        "language_source":    source,
        "language_note": (
            f"Please respond in {effective_lang} whenever possible. "
            "This is a soft preference ΓÇö use your best judgement."
        ),
        "bus_name": "AgentChatBus",
        "version":  BUS_VERSION,
        "endpoint": f"http://{HOST}:{PORT}",
        "auth_requirements": {
            "mcp_thread_create": {
                "required": True,
                "body": ["topic", "agent_id", "token"],
                "rule": "agent_id and token must be provided explicitly in thread_create input.",
            },
            "rest_thread_create": {
                "required": True,
                "body": ["topic", "creator_agent_id"],
                "headers": ["X-Agent-Token"],
            },
        },
        "recommended_workflow": {
            "join_or_create_thread": {
                "tool": "bus_connect",
                "input": {"thread_name": "My Topic", "ide": "Cursor", "model": "Claude"},
                "note": "One call: auto-registers agent, joins or creates thread, returns messages + sync context. For resuming an existing identity, use 'agent_resume' explicitly instead.",
            },
        },
    }))]

async def handle_thread_create(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    # Strict creator auth: explicit id/token are mandatory for thread_create.
    agent_id = arguments.get("agent_id")
    token = arguments.get("token")
    if not agent_id or not token:
        return [types.TextContent(type="text", text=json.dumps({
            "error": "thread_create requires explicit agent_id and token in input",
            "explanation": (
                "thread_create does not auto-read creator credentials from connection context. "
                "You must pass both agent_id and token in the thread_create input payload."
            ),
            "credential_source": {
                "from_agent_register": "Use the agent_id and token returned by agent_register.",
                "from_agent_resume": "Use the same agent_id/token you passed to agent_resume (or its returned agent_id + your token).",
            },
            "how_to_fix": [
                {
                    "tool": "agent_register",
                    "input": {"ide": "VS Code", "model": "GPT-5.3-Codex"},
                    "note": "Read agent_id and token from this response.",
                },
                {
                    "tool": "thread_create",
                    "input": {
                        "topic": arguments.get("topic", "Example topic"),
                        "agent_id": "<agent_register.result.agent_id>",
                        "token": "<agent_register.result.token>",
                    },
                },
            ],
            "alternative": [
                {
                    "tool": "agent_resume",
                    "input": {"agent_id": "<id>", "token": "<token>"},
                    "note": "After resume, reuse these same credentials for thread_create.",
                },
                {
                    "tool": "thread_create",
                    "input": {
                        "topic": arguments.get("topic", "Example topic"),
                        "agent_id": "<id>",
                        "token": "<token>",
                    },
                },
            ],
        }))]

    try:
        result, token_payload = await create_thread_with_verified_creator(
            db,
            topic=arguments["topic"],
            creator_agent_id=agent_id,
            creator_token=token,
            metadata=arguments.get("metadata"),
            system_prompt=arguments.get("system_prompt"),
            template=arguments.get("template"),
        )
    except CreatorAuthError as e:
        return [types.TextContent(type="text", text=json.dumps({
            "error": str(e),
            "hint": "Pass agent_id and token explicitly in thread_create input.",
        }))]
    except CreatorNotFoundError as e:
        return [types.TextContent(type="text", text=json.dumps({
            "error": str(e),
            "hint": "creator identity must map to an existing registered agent.",
        }))]
    except ValueError as e:
        return [types.TextContent(type="text", text=json.dumps({"error": str(e)}))]

    return [types.TextContent(type="text", text=json.dumps({
        "thread_id": result.id, "topic": result.topic, "status": result.status,
        "system_prompt": result.system_prompt, "template_id": result.template_id,
        "current_seq": token_payload["current_seq"],
        "reply_token": token_payload["reply_token"],
        "reply_window": token_payload["reply_window"],
    }))]


async def handle_template_list(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    templates = await crud.template_list(db)
    return [types.TextContent(type="text", text=json.dumps([
        {
            "id": t.id, "name": t.name, "description": t.description,
            "is_builtin": t.is_builtin,
            "created_at": t.created_at.isoformat(),
        }
        for t in templates
    ]))]


async def handle_template_get(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    t = await crud.template_get(db, arguments["template_id"])
    if t is None:
        return [types.TextContent(type="text", text=json.dumps({"error": "Template not found"}))]
    default_metadata = None
    if t.default_metadata:
        parsed = _safe_json_loads(t.default_metadata)
        default_metadata = parsed if parsed is not None else t.default_metadata
    return [types.TextContent(type="text", text=json.dumps({
        "id": t.id, "name": t.name, "description": t.description,
        "system_prompt": t.system_prompt, "default_metadata": default_metadata,
        "is_builtin": t.is_builtin, "created_at": t.created_at.isoformat(),
    }))]


async def handle_template_create(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    try:
        t = await crud.template_create(
            db,
            id=arguments["id"],
            name=arguments["name"],
            description=arguments.get("description"),
            system_prompt=arguments.get("system_prompt"),
            default_metadata=arguments.get("default_metadata"),
        )
    except ValueError as e:
        return [types.TextContent(type="text", text=json.dumps({"error": str(e)}))]
    return [types.TextContent(type="text", text=json.dumps({
        "id": t.id, "name": t.name, "description": t.description,
        "is_builtin": t.is_builtin, "created_at": t.created_at.isoformat(),
    }))]

async def handle_thread_list(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    try:
        status = arguments.get("status")
        include_archived = arguments.get("include_archived", False)
        limit = arguments.get("limit", 0)
        before = arguments.get("before")

        threads, total = await asyncio.gather(
            crud.thread_list(db, status=status, include_archived=include_archived, limit=limit, before=before),
            crud.thread_count(db, status=status, include_archived=include_archived),
        )
        has_more = limit > 0 and len(threads) == limit
        return [types.TextContent(type="text", text=json.dumps({
            "threads": [
                {"thread_id": t.id, "topic": t.topic, "status": t.status,
                 "created_at": t.created_at.isoformat()}
                for t in threads
            ],
            "total": total,
            "has_more": has_more,
            "next_cursor": threads[-1].created_at.isoformat() if has_more else None,
        }))]
    except Exception as e:
        logger.error(f"thread_list failed: {e}")
        return [types.TextContent(type="text", text=json.dumps({
            "error": "Failed to list threads",
            "details": str(e)
        }))]

async def handle_thread_delete(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    if not arguments.get("confirm"):
        return [types.TextContent(type="text", text=json.dumps({
            "error": "Deletion aborted: confirm must be true. This action is irreversible.",
        }))]
    result = await crud.thread_delete(db, arguments["thread_id"])
    if result is None:
        return [types.TextContent(type="text", text=json.dumps({"error": "Thread not found"}))]
    return [types.TextContent(type="text", text=json.dumps({"ok": True, "deleted": result}))]

async def handle_thread_get(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    t = await crud.thread_get(db, arguments["thread_id"])
    if t is None:
        return [types.TextContent(type="text", text=json.dumps({"error": "Thread not found"}))]
    return [types.TextContent(type="text", text=json.dumps({
        "thread_id": t.id, "topic": t.topic, "status": t.status,
        "created_at": t.created_at.isoformat(),
        "closed_at": t.closed_at.isoformat() if t.closed_at else None,
        "summary": t.summary,
    }))]

async def handle_thread_settings_get(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    thread_id = arguments["thread_id"]
    if await crud.thread_get(db, thread_id) is None:
        return [types.TextContent(type="text", text=json.dumps({"error": "Thread not found"}))]
    ts = await crud.thread_settings_get_or_create(db, thread_id)
    return [types.TextContent(type="text", text=json.dumps({
        "thread_id": ts.thread_id,
        "auto_administrator_enabled": ts.auto_administrator_enabled,
        "timeout_seconds": ts.timeout_seconds,
        "switch_timeout_seconds": ts.switch_timeout_seconds,
        "auto_assigned_admin_id": ts.auto_assigned_admin_id,
        "auto_assigned_admin_name": ts.auto_assigned_admin_name,
    }))]

async def handle_thread_settings_update(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    thread_id = arguments["thread_id"]
    if await crud.thread_get(db, thread_id) is None:
        return [types.TextContent(type="text", text=json.dumps({"error": "Thread not found"}))]
    try:
        ts = await crud.thread_settings_update(
            db,
            thread_id,
            auto_administrator_enabled=arguments.get("auto_administrator_enabled"),
            timeout_seconds=arguments.get("timeout_seconds"),
            switch_timeout_seconds=arguments.get("switch_timeout_seconds"),
        )
        return [types.TextContent(type="text", text=json.dumps({
            "ok": True,
            "auto_administrator_enabled": ts.auto_administrator_enabled,
            "timeout_seconds": ts.timeout_seconds,
            "switch_timeout_seconds": ts.switch_timeout_seconds,
        }))]
    except ValueError as e:
        return [types.TextContent(type="text", text=json.dumps({"error": str(e)}))]

async def handle_msg_post(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    thread_id = arguments["thread_id"]

    author_candidate = arguments.get("author")
    author_agent_id: str | None = None
    if isinstance(author_candidate, str) and author_candidate:
        try:
            author_agent = await crud.agent_get(db, author_candidate)
            if author_agent is not None:
                author_agent_id = author_agent.id
        except Exception:
            author_agent_id = None

    try:
        msg = await crud.msg_post(
            db,
            thread_id=thread_id,
            author=arguments["author"],
            content=arguments["content"],
            expected_last_seq=arguments.get("expected_last_seq"),
            reply_token=arguments.get("reply_token"),
            role=arguments.get("role", "user"),
            metadata=arguments.get("metadata"),
            priority=arguments.get("priority", "normal"),
            reply_to_msg_id=arguments.get("reply_to_msg_id"),
        )
        
        # Agent posted a message - exit wait state for this thread
        if author_agent_id:
            await crud.thread_wait_exit(db, thread_id, author_agent_id)
    except RateLimitExceeded as e:
        return [types.TextContent(type="text", text=json.dumps({
            "error": "Rate limit exceeded",
            "limit": e.limit,
            "window": e.window,
            "retry_after": e.retry_after,
        }))]
    except (MissingSyncFieldsError, SeqMismatchError, ReplyTokenInvalidError, ReplyTokenExpiredError, ReplyTokenReplayError) as e:
        error_type = type(e).__name__

        # Refresh-request ownership must follow the validated author agent.
        # Using connection context here can corrupt another agent's wait state.
        if author_agent_id:
            await crud.reply_tokens_invalidate_for_agent(db, thread_id, author_agent_id)
            await crud.msg_wait_refresh_request_set(db, thread_id, author_agent_id, reason=error_type)

        if isinstance(e, SeqMismatchError):
            return [types.TextContent(type="text", text=json.dumps({
                "error": error_type,
                "detail": str(e) if hasattr(e, "__str__") else error_type,
                "expected_last_seq": e.expected_last_seq,
                "current_seq": e.current_seq,
                "CRITICAL_REMINDER": (
                    "Your msg_post was rejected! "
                    "NEW context arrived while you were trying to post. "
                    "You MUST read the 'new_messages_1st_read' below NOW to understand what changed. "
                    "Do NOT blindly retry your old message! "
                    "Next, you MUST call 'msg_wait' to get a fresh reply_token. "
                    "When you do, you will receive these messages again (2nd read). "
                    "Only AFTER that, formulate a NEW response."
                ),
                "new_messages_1st_read": _project_message_dicts_for_agent(e.new_messages),
                "action": "READ_MESSAGES_THEN_CALL_MSG_WAIT"
            }))]

        payload = {
            "error": error_type,
            "detail": str(e) if hasattr(e, "__str__") else error_type,
            "REMINDER": (
                "Your reply_token is no longer usable. "
                "Call 'msg_wait' now to get a fresh reply_token before posting again."
            ),
            "action": "CALL_MSG_WAIT",
        }
        if isinstance(e, ReplyTokenExpiredError):
            payload["expires_at"] = e.expires_at
        if isinstance(e, ReplyTokenReplayError):
            payload["consumed_at"] = e.consumed_at
        return [types.TextContent(type="text", text=json.dumps(payload))]
    except ContentFilterError as e:
        return [types.TextContent(type="text", text=json.dumps({
            "error": "Content blocked by filter",
            "pattern": e.pattern_name,
        }))]
    except ValueError as e:
        return [types.TextContent(type="text", text=json.dumps({
            "error": "INVALID_ARGUMENT",
            "detail": str(e),
        }))]

    meta = _safe_json_loads(msg.metadata)
    result: dict[str, Any] = {
        "msg_id": msg.id,
        "seq": msg.seq,
        "reply_to_msg_id": msg.reply_to_msg_id,
    }
    if ENABLE_PRIORITY:
        result["priority"] = msg.priority
        
    if isinstance(meta, dict):
        if ENABLE_HANDOFF_TARGET and meta.get("handoff_target"):
            result["handoff_target"] = meta["handoff_target"]
        if ENABLE_STOP_REASON and meta.get("stop_reason"):
            result["stop_reason"] = meta["stop_reason"]
    return [types.TextContent(type="text", text=json.dumps(result))]

def _filter_metadata_fields(meta_str: str | None) -> str | None:
    # NOTE: `priority` is not part of the metadata string column in the database schema;
    # it is a top-level field on the Message model.
    # Therefore, while `handoff_target` and `stop_reason` are filtered here from the JSON metadata,
    # the attention-mechanism feature flag for `priority` (ENABLE_PRIORITY) is enforced
    # independently inside formatting functions (`handle_msg_get`, `handle_msg_list`, etc.).
    raw_meta = _safe_json_loads(meta_str) or {}
    if isinstance(raw_meta, dict):
        if not ENABLE_HANDOFF_TARGET and "handoff_target" in raw_meta:
             del raw_meta["handoff_target"]
        if not ENABLE_STOP_REASON and "stop_reason" in raw_meta:
             del raw_meta["stop_reason"]
    return json.dumps(raw_meta) if raw_meta else None

async def handle_msg_list(db, arguments: dict[str, Any]) -> list[types.Content]:
    msgs = await crud.msg_list(
        db,
        thread_id=arguments["thread_id"],
        after_seq=arguments.get("after_seq", 0),
        limit=arguments.get("limit", 100),
        include_system_prompt=arguments.get("include_system_prompt", True),
        priority=arguments.get("priority"),
    )
    msgs = _project_messages_for_agent(msgs)

    # Batch-fetch reactions for all real message IDs
    real_ids = [m.id for m in msgs if not m.id.startswith("sys-")]
    reactions_map = await crud.msg_reactions_bulk(db, real_ids)

    return_format = arguments.get("return_format", "blocks")
    if return_format == "blocks":
        blocks: list[types.Content] = []
        for m in msgs:
            blocks.extend(_message_to_blocks(m))
        return blocks

    def _filter_msg(m):
        filtered_meta = _filter_metadata_fields(m.metadata)
        
        msg_dict = {
            "msg_id": m.id,
            "author": m.author,
            "author_id": m.author_id,
            "author_name": m.author_name,
            "role": m.role,
            "content": m.content,
            "seq": m.seq,
            "created_at": m.created_at.isoformat(),
            "metadata": filtered_meta,
            "reply_to_msg_id": m.reply_to_msg_id,
            "reactions": reactions_map.get(m.id, []),
        }
        if ENABLE_PRIORITY:
            msg_dict["priority"] = m.priority
        return msg_dict

    return [types.TextContent(type="text", text=json.dumps([
        _filter_msg(m) for m in msgs
    ]))]


async def handle_msg_react(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    try:
        reaction = await crud.msg_react(
            db,
            message_id=arguments["message_id"],
            agent_id=arguments.get("agent_id"),
            reaction=arguments["reaction"],
        )
    except crud.MessageNotFoundError as e:
        return [types.TextContent(type="text", text=json.dumps({
            "error": "MESSAGE_NOT_FOUND",
            "message_id": e.message_id,
        }))]
    except ValueError as e:
        return [types.TextContent(type="text", text=json.dumps({"error": str(e)}))]
    return [types.TextContent(type="text", text=json.dumps({
        "reaction_id": reaction.id,
        "message_id": reaction.message_id,
        "agent_id": reaction.agent_id,
        "agent_name": reaction.agent_name,
        "reaction": reaction.reaction,
        "created_at": reaction.created_at.isoformat(),
    }))]


async def handle_msg_unreact(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    removed = await crud.msg_unreact(
        db,
        message_id=arguments["message_id"],
        agent_id=arguments.get("agent_id"),
        reaction=arguments["reaction"],
    )
    return [types.TextContent(type="text", text=json.dumps({
        "removed": removed,
        "message_id": arguments["message_id"],
        "reaction": arguments["reaction"],
    }))]


async def handle_msg_search(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    """Handle msg_search MCP tool — FTS5 full-text search (UI-02)."""
    query = str(arguments.get("query", "")).strip()
    if not query:
        return [types.TextContent(type="text", text=json.dumps({
            "error": "query must not be empty",
        }))]
    thread_id = arguments.get("thread_id")
    limit = int(arguments.get("limit", 50))
    results = await crud.msg_search(db, query, thread_id=thread_id, limit=limit)
    results = _project_search_results_for_agent(results)
    return [types.TextContent(type="text", text=json.dumps({
        "results": results,
        "total": len(results),
        "query": query,
    }))]


async def handle_msg_edit(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    """Handle msg_edit MCP tool (UP-21) — edit a message's content."""
    message_id = str(arguments.get("message_id", "")).strip()
    new_content = str(arguments.get("new_content", "")).strip()
    if not message_id or not new_content:
        return [types.TextContent(type="text", text=json.dumps({
            "error": "message_id and new_content are required",
        }))]

    # Deduce edited_by from the connected agent (same pattern as msg_post)
    connection_agent_id, _ = src.mcp_server.get_connection_agent()
    if not connection_agent_id:
        return [types.TextContent(type="text", text=json.dumps({
            "error": "AUTHENTICATION_REQUIRED",
            "detail": "msg_edit requires an authenticated agent connection.",
        }))]
    edited_by = connection_agent_id

    try:
        edit = await crud.msg_edit(db, message_id, new_content, edited_by)
    except MessageEditNoChangeError as e:
        return [types.TextContent(type="text", text=json.dumps({
            "no_change": True,
            "version": e.current_version,
        }))]
    except PermissionError as e:
        return [types.TextContent(type="text", text=json.dumps({
            "error": str(e),
        }))]
    except crud.MessageNotFoundError:
        return [types.TextContent(type="text", text=json.dumps({
            "error": f"Message '{message_id}' not found",
        }))]
    except ContentFilterError as e:
        return [types.TextContent(type="text", text=json.dumps({
            "error": f"Content blocked by filter: {e}",
        }))]

    return [types.TextContent(type="text", text=json.dumps({
        "msg_id": message_id,
        "version": edit.version,
        "edited_at": edit.created_at.isoformat(),
        "edited_by": edit.edited_by,
    }))]


async def handle_msg_edit_history(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    """Handle msg_edit_history MCP tool (UP-21) — retrieve full edit history of a message."""
    message_id = str(arguments.get("message_id", "")).strip()
    if not message_id:
        return [types.TextContent(type="text", text=json.dumps({
            "error": "message_id is required",
        }))]

    msg = await crud.msg_get(db, message_id)
    if msg is None:
        return [types.TextContent(type="text", text=json.dumps({
            "found": False,
            "message_id": message_id,
        }))]

    edits = await crud.msg_edit_history(db, message_id)
    return [types.TextContent(type="text", text=json.dumps(
        _project_edit_history_payload_for_agent(msg, edits)
    ))]


async def handle_msg_get(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    """Handle msg_get MCP tool (UP-24) — fetch a single message by ID."""
    message_id = str(arguments.get("message_id", "")).strip()
    msg = await crud.msg_get(db, message_id)
    if msg is None:
        return [types.TextContent(type="text", text=json.dumps({"found": False, "message": None}))]
    msg = _project_message_for_agent(msg)
    reactions = await crud.msg_reactions(db, msg.id)
    result = {
        "found": True,
        "message": {
            "msg_id": msg.id,
            "thread_id": msg.thread_id,
            "author": msg.author,
            "content": msg.content,
            "seq": msg.seq,
            "role": msg.role,
            "reply_to_msg_id": msg.reply_to_msg_id,
            "metadata": _filter_metadata_fields(msg.metadata),
            "created_at": msg.created_at.isoformat() if hasattr(msg.created_at, "isoformat") else msg.created_at,
            "edited_at": msg.edited_at.isoformat() if msg.edited_at else None,
            "edit_version": msg.edit_version,
            "reactions": [{"agent_id": r.agent_id, "reaction": r.reaction} for r in reactions],
        },
    }
    if ENABLE_PRIORITY:
        result["message"]["priority"] = msg.priority
    return [types.TextContent(type="text", text=json.dumps(result))]

def _metadata_targets(msg: Any, agent_id: str) -> bool:
    """Return True if the message metadata.handoff_target matches agent_id."""
    meta = _safe_json_loads(msg.metadata)
    if isinstance(meta, dict):
        return meta.get("handoff_target") == agent_id
    return False

def _is_human_only_message(msg: Any) -> bool:
    """True when message metadata marks this message as visible to humans only."""
    return _is_human_only_metadata(getattr(msg, "metadata", None))


async def handle_msg_wait(db, arguments: dict[str, Any]) -> list[types.Content]:
    thread_id = arguments["thread_id"]
    after_seq = arguments["after_seq"]
    timeout_s = arguments.get("timeout_ms", MSG_WAIT_TIMEOUT * 1000) / 1000.0
    timeout_ms = arguments.get("timeout_ms", MSG_WAIT_TIMEOUT * 1000)
    for_agent = arguments.get("for_agent")

    explicit_agent_id = arguments.get("agent_id")
    explicit_token = arguments.get("token")
    connection_agent_id, connection_token = src.mcp_server.get_connection_agent()

    explicit_creds_supplied = explicit_agent_id is not None or explicit_token is not None
    if explicit_creds_supplied:
        if not explicit_agent_id or not explicit_token:
            return [types.TextContent(type="text", text=json.dumps({
                "error": "InvalidCredentials",
                "detail": "msg_wait requires both agent_id and token when explicit credentials are supplied.",
            }))]
        agent_id = explicit_agent_id
        token = explicit_token
    else:
        agent_id = connection_agent_id
        token = connection_token

    verified_agent = False
    if agent_id and token:
        verified_agent = await crud.agent_verify_token(db, agent_id, token)
        if not verified_agent:
            return [types.TextContent(type="text", text=json.dumps({
                "error": "InvalidCredentials",
                "detail": "Invalid agent_id/token for msg_wait.",
            }))]

    # If caller passed explicit credentials on an SSE request, bind this agent
    # to the current connection session so transport status can reflect SSE.
    # Without this, agents that only call msg_wait with explicit agent_id/token
    # may appear as online+waiting but not SSE-connected.
    if verified_agent:
        src.mcp_server.set_connection_agent(agent_id, token)

    logger.info(f"[msg_wait] explicit: agent_id={explicit_agent_id}, connection: agent_id={connection_agent_id}, final_agent_id={agent_id}, for_agent={for_agent}")

    # Track agent entering msg_wait state for coordination timeout detection.
    #
    # Cross-process note:
    # - msg_wait may run inside stdio_main.py worker processes, while the
    #   admin coordinator loop runs in the HTTP server process (src.main).
    # - Process-local memory (for example module-level dicts) is NOT shared
    #   across those processes, so using in-memory wait state can miss events.
    # - We therefore persist wait state in SQLite (thread_wait_states), which
    #   gives all processes a single source of truth.
    #
    # Semantics:
    # - entering msg_wait writes/refreshes (thread_id, agent_id)
    # - receiving a message or posting a message removes that wait marker
    # - coordinator reads DB markers to evaluate timeout conditions
    if verified_agent:
        await crud.thread_wait_enter(db, thread_id, agent_id, timeout_ms)

    wants_sync_only = False
    issued_token_count: int | None = None
    refresh_request: dict[str, Any] | None = None
    current_latest_seq = await crud.thread_latest_seq(db, thread_id)
    
    if verified_agent:
        refresh_request = await crud.msg_wait_refresh_request_get(db, thread_id, agent_id)
        async with db.execute(
            "SELECT COUNT(*) FROM reply_tokens "
            "WHERE thread_id = ? AND agent_id = ? AND status = 'issued'",
            (thread_id, agent_id),
        ) as cur:
            row = await cur.fetchone()
            issued_token_count = row[0] if row else 0
            if refresh_request:
                wants_sync_only = True
            # Only force return for sync if the agent is actually behind.
            # If they are at the latest seq, they can safely wait; they'll get
            # a token when they eventually wake up.
            if not wants_sync_only and issued_token_count == 0 and after_seq < current_latest_seq:
                wants_sync_only = True
    
    fast_return_allowed = bool(wants_sync_only)
    
    # ── Diagnostic Logs ───────────────────────────────────────────────────────
    reason = "normal"
    if refresh_request:
        refresh_reason = refresh_request.get("reason") or "unknown"
        reason = f"refresh_required_after_{refresh_reason}(after_seq={after_seq}, latest={current_latest_seq})"
    elif wants_sync_only:
        reason = f"no_issued_tokens_and_behind(total_issued={issued_token_count if agent_id else 'N/A'}, after_seq={after_seq}, latest={current_latest_seq})"
    elif verified_agent and issued_token_count == 0:
        reason = f"no_issued_tokens_but_caught_up(latest={current_latest_seq})"
    
    logger.info(
        f"[msg_wait_debug] agent_id={agent_id} thread_id={thread_id} "
        f"after_seq={after_seq} current_latest_seq={current_latest_seq} "
        f"fast_return_allowed={fast_return_allowed} reason={reason}"
    )
    # ─────────────────────────────────────────────────────────────────────────

    # Refresh every 20 seconds to stay online during long-poll waits.
    HEARTBEAT_INTERVAL = 20.0

    async def _refresh_heartbeat() -> None:
        if verified_agent:
            try:
                await crud.agent_msg_wait(db, agent_id, token, wait_seconds=timeout_s, fast_return_allowed=fast_return_allowed, reason=f"{reason} (heartbeat)", after_seq=after_seq, current_latest_seq=current_latest_seq)
                logger.debug(f"[msg_wait] heartbeat refreshed for agent_id={agent_id}")
            except Exception as e:
                logger.warning(f"[msg_wait] Failed to refresh heartbeat for {agent_id}: {e}")
        # Also refresh the in-process SSE session timestamp so is_agent_sse_connected()
        # stays true during active msg_wait polling. Without this, the short
        # _SSE_STALE_SECONDS window would expire mid-wait and flip the agent offline.
        try:
            session_id = src.mcp_server.get_session_id()
            if session_id:
                src.mcp_server.mark_sse_connected(session_id)
        except Exception:
            pass

    if verified_agent:
        try:
            result = await crud.agent_msg_wait(db, agent_id, token, wait_seconds=timeout_s, fast_return_allowed=fast_return_allowed, reason=reason, after_seq=after_seq, current_latest_seq=current_latest_seq)
            logger.info(f"[msg_wait] activity recorded: agent_id={agent_id}, result={result}")
        except Exception as e:
            logger.warning(f"[msg_wait] Failed to record activity for {agent_id}: {e}")
    elif agent_id or token:
        logger.warning(f"[msg_wait] Invalid credentials rejected: agent_id={agent_id}, token={'***' if token else None}")
    else:
        logger.warning(f"[msg_wait] No credentials available: agent_id={agent_id}, token={'***' if token else None}")

    if wants_sync_only:
        logger.info(
            f"[msg_wait] immediate-return-eligible reason={'refresh_required' if refresh_request else 'no_issued_token'} "
            f"thread_id={thread_id} agent_id={agent_id} after_seq={after_seq}"
        )

    async def _poll():
        last_heartbeat = asyncio.get_event_loop().time()
        local_after_seq = after_seq
        while True:
            raw_msgs = await crud.msg_list(db, thread_id, after_seq=local_after_seq, include_system_prompt=False)
            msgs = _project_messages_for_agent(raw_msgs)
            if msgs:
                if for_agent:
                    filtered = [m for m in msgs if _metadata_targets(m, for_agent)]
                    if filtered:
                        # Exit wait state only when returning a message to caller.
                        if verified_agent:
                            await crud.thread_wait_exit(db, thread_id, agent_id)
                            await crud.agent_msg_received(db, agent_id)
                        logger.info(
                            f"[msg_wait] return reason=targeted_messages thread_id={thread_id} "
                            f"agent_id={agent_id} for_agent={for_agent} count={len(filtered)}"
                        )
                        return filtered
                    # Messages were present but not targeted at this waiter.
                    # Move the local cursor forward to avoid polling the same
                    # non-target messages forever, and keep wait-state active.
                    local_after_seq = max(local_after_seq, max(m.seq for m in msgs))
                else:
                    # No for_agent filter: any message wakes this waiter.
                    if verified_agent:
                        await crud.thread_wait_exit(db, thread_id, agent_id)
                        await crud.agent_msg_received(db, agent_id)
                    logger.info(
                        f"[msg_wait] return reason=new_messages thread_id={thread_id} "
                        f"agent_id={agent_id} count={len(msgs)}"
                    )
                    return msgs

            # Priority: messages first, then generic no-issued-token fast-return.
            if wants_sync_only:
                if verified_agent:
                    await crud.thread_wait_exit(db, thread_id, agent_id)
                logger.info(
                    f"[msg_wait] return reason=sync_only_no_issued_token "
                    f"thread_id={thread_id} agent_id={agent_id}"
                )
                return []

            now = asyncio.get_event_loop().time()
            if now - last_heartbeat >= HEARTBEAT_INTERVAL:
                await _refresh_heartbeat()
                last_heartbeat = now

            await asyncio.sleep(0.5)

    try:
        msgs = await asyncio.wait_for(_poll(), timeout=timeout_s)
    except asyncio.TimeoutError:
        msgs = []
        if verified_agent:
            await crud.thread_wait_exit(db, thread_id, agent_id)
        logger.info(
            f"[msg_wait] return reason=timeout thread_id={thread_id} "
            f"agent_id={agent_id} timeout_ms={timeout_ms}"
        )

    if verified_agent and refresh_request:
        await crud.msg_wait_refresh_request_clear(db, thread_id, agent_id)

    current_seq_after_wait = await crud.thread_latest_seq(db, thread_id)
    token_payload: dict[str, Any] | None = None

    if verified_agent and not msgs and current_seq_after_wait == current_latest_seq:
        latest_token = await crud.reply_token_get_latest_issued(db, thread_id, agent_id)
        if latest_token is not None:
            await crud.reply_tokens_invalidate_for_agent_except(
                db,
                thread_id=thread_id,
                agent_id=agent_id,
                keep_token=latest_token["reply_token"],
            )
            token_payload = {
                "reply_token": latest_token["reply_token"],
                "current_seq": current_seq_after_wait,
                "reply_window": {
                    "expires_at": latest_token["expires_at"],
                    "max_new_messages": 0,
                },
            }

    if token_payload is None:
        if verified_agent:
            await crud.reply_tokens_invalidate_for_agent(db, thread_id, agent_id)
        token_payload = await crud.issue_reply_token(
            db,
            thread_id=thread_id,
            agent_id=agent_id if verified_agent else None,
            source="msg_wait",
        )
    
    # Coordinator interventions are generated by main._admin_coordinator_loop.
    coordination_prompt = None
    
    def _format_wait_msg(m):
        m = _project_message_for_agent(m)
        d = {
            "msg_id": m.id,
            "author": m.author,
            "author_id": getattr(m, "author_id", None),
            "author_name": getattr(m, "author_name", None),
            "role": m.role,
            "content": m.content,
            "seq": m.seq,
            "created_at": m.created_at.isoformat(),
            "metadata": _filter_metadata_fields(m.metadata),
        }
        if ENABLE_PRIORITY:
            d["priority"] = m.priority
        return d

    envelope = {
        "messages": [_format_wait_msg(m) for m in msgs],
        "current_seq": token_payload["current_seq"],
        "reply_token": token_payload["reply_token"],
        "reply_window": token_payload["reply_window"],
    }
    
    if coordination_prompt:
        envelope["coordination_prompt"] = coordination_prompt

    return_format = arguments.get("return_format", "blocks")
    if return_format == "blocks":
        blocks: list[types.Content] = []
        blocks.append(types.TextContent(type="text", text=json.dumps({
            "type": "sync_context",
            "current_seq": token_payload["current_seq"],
            "reply_token": token_payload["reply_token"],
            "reply_window": token_payload["reply_window"],
        })))
        if coordination_prompt:
            blocks.append(types.TextContent(type="text", text=json.dumps({
                "type": "coordination_prompt",
                **coordination_prompt,
            })))
        for m in msgs:
            blocks.extend(_message_to_blocks(m))
        return blocks

    return [types.TextContent(type="text", text=json.dumps(envelope))]

async def handle_agent_register(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    agent = await crud.agent_register(
        db,
        ide=arguments["ide"],
        model=arguments["model"],
        description=arguments.get("description", ""),
        capabilities=arguments.get("capabilities"),
        display_name=arguments.get("display_name"),
        skills=arguments.get("skills"),
    )
    logger.info(f"[agent_register] client_type=direct_register agent_id={agent.id}")
    src.mcp_server._current_agent_id.set(agent.id)
    src.mcp_server._current_agent_token.set(agent.token)
    src.mcp_server.set_connection_agent(agent.id, agent.token)
    logger.info(f"[agent_register] Set context and connection registry: agent_id={agent.id}")
    import json as _json
    return [types.TextContent(type="text", text=_json.dumps({
        "agent_id": agent.id,
        "name": agent.name,
        "display_name": agent.display_name,
        "alias_source": agent.alias_source,
        "token": agent.token,
        "capabilities": _json.loads(agent.capabilities) if agent.capabilities else [],
        "skills": _json.loads(agent.skills) if agent.skills else [],
        "last_activity": agent.last_activity,
        "last_activity_time": agent.last_activity_time.isoformat() if agent.last_activity_time else None,
        "thread_create_requirement": (
            "When calling thread_create, you must provide both agent_id and token explicitly in input."
        ),
        "thread_create_example": {
            "tool": "thread_create",
            "input": {
                "topic": "Example topic",
                "agent_id": agent.id,
                "token": agent.token,
            },
        },
        "deprecation_info": {
            "status": "deprecated",
            "recommended_replacement": "bus_connect",
            "reason": (
                "agent_register only handles agent identity registration. "
                "bus_connect provides a unified one-step agent + thread lifecycle, "
                "returning agent credentials, thread details, and messages in a single call."
            ),
            "timeline": (
                "Soft-warn in v1.1 → Soft-disable in v1.3 → Hard-remove in v2.0"
            ),
            "migration_examples": [
                {
                    "title": "Basic migration",
                    "before": {
                        "tool": "agent_register",
                        "input": {"ide": "Cursor", "model": "Claude Haiku"},
                    },
                    "after": {
                        "tool": "bus_connect",
                        "input": {"thread_name": "My Thread", "ide": "Cursor", "model": "Claude Haiku"},
                    },
                    "benefit": "bus_connect gives you agent_id, token, thread_id, and messages in one call.",
                },
                {
                    "title": "With agent metadata",
                    "before": [
                        {"tool": "agent_register", "input": {"ide": "...", "model": "...", "capabilities": ["..."]}},
                        {"tool": "thread_create", "input": {"topic": "...", "agent_id": "...", "token": "..."}},
                    ],
                    "after": {
                        "tool": "bus_connect",
                        "input": {
                            "thread_name": "My Thread",
                            "ide": "...",
                            "model": "...",
                            "capabilities": ["..."],
                        },
                    },
                    "benefit": "Unified registration + thread join in single call.",
                },
                {
                    "title": "Session resumption",
                    "before": [
                        {"tool": "agent_register", "input": {"ide": "...", "model": "..."}},
                        {"tool": "agent_resume", "input": {"agent_id": "...", "token": "..."}},
                    ],
                    "after": {
                        "tool": "bus_connect",
                        "input": {
                            "thread_name": "My Thread",
                            "agent_id": "...",
                            "token": "...",
                        },
                    },
                    "benefit": "bus_connect handles agent resume + thread join.",
                },
            ],
        },
    }))]

async def handle_agent_heartbeat(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    ok = await crud.agent_heartbeat(db, arguments["agent_id"], arguments["token"])
    if ok:
        src.mcp_server._current_agent_id.set(arguments["agent_id"])
        src.mcp_server._current_agent_token.set(arguments["token"])
        src.mcp_server.set_connection_agent(arguments["agent_id"], arguments["token"])
    return [types.TextContent(type="text", text=json.dumps({"ok": ok}))]

async def handle_agent_resume(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    try:
        agent = await crud.agent_resume(db, arguments["agent_id"], arguments["token"])
    except ValueError as e:
        return [types.TextContent(type="text", text=json.dumps({"ok": False, "error": str(e)}))]
    src.mcp_server._current_agent_id.set(agent.id)
    src.mcp_server._current_agent_token.set(agent.token)
    src.mcp_server.set_connection_agent(agent.id, agent.token)
    logger.info(f"[agent_resume] Set context and connection registry for agent_id={agent.id}")
    return [types.TextContent(type="text", text=json.dumps({
        "ok": True,
        "agent_id": agent.id,
        "name": agent.name,
        "display_name": agent.display_name,
        "alias_source": agent.alias_source,
        "is_online": agent.is_online,
        "last_heartbeat": agent.last_heartbeat.isoformat(),
        "last_activity": agent.last_activity,
        "last_activity_time": agent.last_activity_time.isoformat() if agent.last_activity_time else None,
        "thread_create_requirement": (
            "When calling thread_create, you must provide both agent_id and token explicitly in input."
        ),
        "thread_create_example": {
            "tool": "thread_create",
            "input": {
                "topic": "Example topic",
                "agent_id": agent.id,
                "token": arguments["token"],
            },
        },
    }))]

async def handle_agent_unregister(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    ok = await crud.agent_unregister(db, arguments["agent_id"], arguments["token"])
    return [types.TextContent(type="text", text=json.dumps({"ok": ok}))]

async def handle_agent_list(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    agents = await crud.agent_list(db)
    return [types.TextContent(type="text", text=json.dumps([
        {"agent_id": a.id, "name": a.name, "ide": a.ide, "model": a.model,
         "display_name": a.display_name, "alias_source": a.alias_source,
         "description": a.description, "is_online": a.is_online,
         "capabilities": json.loads(a.capabilities) if a.capabilities else [],
         "skills": json.loads(a.skills) if a.skills else [],
         "last_heartbeat": a.last_heartbeat.isoformat(),
         "last_activity": a.last_activity,
         "last_activity_time": a.last_activity_time.isoformat() if a.last_activity_time else None}
        for a in agents
    ]))]


async def handle_agent_update(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    try:
        agent = await crud.agent_update(
            db,
            agent_id=arguments["agent_id"],
            token=arguments["token"],
            description=arguments.get("description"),
            capabilities=arguments.get("capabilities"),
            skills=arguments.get("skills"),
            display_name=arguments.get("display_name"),
        )
    except ValueError as e:
        return [types.TextContent(type="text", text=json.dumps({"ok": False, "error": str(e)}))]
    return [types.TextContent(type="text", text=json.dumps({
        "ok": True,
        "agent_id": agent.id,
        "name": agent.name,
        "display_name": agent.display_name,
        "description": agent.description,
        "capabilities": json.loads(agent.capabilities) if agent.capabilities else [],
        "skills": json.loads(agent.skills) if agent.skills else [],
        "last_activity": agent.last_activity,
        "last_activity_time": agent.last_activity_time.isoformat() if agent.last_activity_time else None,
    }))]

async def handle_agent_set_typing(db, arguments: dict[str, Any]) -> list[types.TextContent]:
    db2 = await get_db()
    actual_author = arguments["agent_id"]
    async with db2.execute("SELECT name FROM agents WHERE id = ?", (actual_author,)) as cur:
        row = await cur.fetchone()
        if row:
            actual_author = row["name"]

    await crud._emit_event(db2, "agent.typing", arguments["thread_id"], {
        "agent_id": actual_author,
        "is_typing": arguments["is_typing"],
    })
    return [types.TextContent(type="text", text=json.dumps({"ok": True}))]

TOOLS_DISPATCH = {
    "bus_get_config": handle_bus_get_config,
    "bus_connect": handle_bus_connect,
    "thread_create": handle_thread_create,
    "thread_list": handle_thread_list,
    "thread_delete": handle_thread_delete,
    "thread_get": handle_thread_get,
    "thread_settings_get": handle_thread_settings_get,
    "thread_settings_update": handle_thread_settings_update,
    "msg_post": handle_msg_post,
    "msg_list": handle_msg_list,
    "msg_wait": handle_msg_wait,
    "msg_get": handle_msg_get,
    "msg_react": handle_msg_react,
    "msg_unreact": handle_msg_unreact,
    "msg_search": handle_msg_search,
    "msg_edit": handle_msg_edit,
    "msg_edit_history": handle_msg_edit_history,
    "agent_register": handle_agent_register,
    "agent_heartbeat": handle_agent_heartbeat,
    "agent_resume": handle_agent_resume,
    "agent_unregister": handle_agent_unregister,
    "agent_list": handle_agent_list,
    "agent_update": handle_agent_update,
    "agent_set_typing": handle_agent_set_typing,
    "template_list": handle_template_list,
    "template_get": handle_template_get,
    "template_create": handle_template_create,
}

async def dispatch_tool(db, name: str, arguments: dict[str, Any]) -> list[types.Content]:
    handler = TOOLS_DISPATCH.get(name)
    if handler:
        return await handler(db, arguments)
    return [types.TextContent(type="text", text=json.dumps({"error": f"Unknown tool: {name}"}))]