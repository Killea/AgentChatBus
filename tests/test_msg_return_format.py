import json

import aiosqlite
import pytest

import mcp.types as types

from agentchatbus.db import crud
from agentchatbus.db.database import init_schema
from agentchatbus.tools.dispatch import handle_msg_list


async def _post_message(db, thread_id: str, author: str, content: str, role: str = "user", metadata: dict | None = None):
    sync = await crud.issue_reply_token(db, thread_id=thread_id)
    return await crud.msg_post(
        db,
        thread_id=thread_id,
        author=author,
        content=content,
        expected_last_seq=sync["current_seq"],
        reply_token=sync["reply_token"],
        role=role,
        metadata=metadata,
    )


async def _make_db() -> aiosqlite.Connection:
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)
    return db


@pytest.mark.asyncio
async def test_msg_list_default_json_compatible():
    db = await _make_db()
    try:
        thread = await crud.thread_create(db, topic="fmt-json-default")
        await _post_message(
            db,
            thread_id=thread.id,
            author="human",
            content="hello",
            role="user",
            metadata={
                "attachments": [
                    {"type": "image", "mimeType": "image/png", "data": "iVBORw0KGgo="}
                ]
            },
        )

        out = await handle_msg_list(
            db,
            {
                "thread_id": thread.id,
                "after_seq": 0,
                "limit": 10,
                "include_system_prompt": False,
                "return_format": "json",
            },
        )

        assert isinstance(out, list)
        assert len(out) == 1
        assert isinstance(out[0], types.TextContent)

        payload = json.loads(out[0].text)
        assert isinstance(payload, list)
        assert payload and payload[0]["content"] == "hello"
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_msg_list_blocks_can_return_imagecontent():
    db = await _make_db()
    try:
        thread = await crud.thread_create(db, topic="fmt-blocks")
        await _post_message(
            db,
            thread_id=thread.id,
            author="human",
            content="look",
            role="user",
            metadata={
                "attachments": [
                    {"type": "image", "mimeType": "image/png", "data": "iVBORw0KGgo="}
                ]
            },
        )

        out = await handle_msg_list(
            db,
            {
                "thread_id": thread.id,
                "after_seq": 0,
                "limit": 10,
                "include_system_prompt": False,
            },
        )

        assert isinstance(out, list)
        assert any(isinstance(x, types.ImageContent) for x in out)
        assert any(isinstance(x, types.TextContent) and "look" in x.text for x in out)
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_msg_list_blocks_strips_data_url_prefix_and_inferrs_mime():
    db = await _make_db()
    try:
        thread = await crud.thread_create(db, topic="fmt-blocks-dataurl")
        await _post_message(
            db,
            thread_id=thread.id,
            author="human",
            content="dataurl",
            role="user",
            metadata={
                "attachments": [
                    {"type": "image", "data": "data:image/png;base64,iVBORw0KGgo="}
                ]
            },
        )

        out = await handle_msg_list(
            db,
            {
                "thread_id": thread.id,
                "after_seq": 0,
                "limit": 10,
                "include_system_prompt": False,
            },
        )

        imgs = [x for x in out if isinstance(x, types.ImageContent)]
        assert imgs, "Expected at least one ImageContent"
        assert imgs[0].mimeType == "image/png"
        assert imgs[0].data == "iVBORw0KGgo="
    finally:
        await db.close()


# ==================== UP-33: include_attachments parameter ====================

@pytest.mark.asyncio
async def test_msg_list_blocks_include_attachments_false():
    """UP-33: include_attachments=false should return text blocks only (no ImageContent)."""
    db = await _make_db()
    try:
        thread = await crud.thread_create(db, topic="no-attachments")
        await _post_message(
            db,
            thread_id=thread.id,
            author="human",
            content="text with image",
            role="user",
            metadata={
                "attachments": [
                    {"type": "image", "mimeType": "image/png", "data": "iVBORw0KGgo="}
                ]
            },
        )

        out = await handle_msg_list(
            db,
            {
                "thread_id": thread.id,
                "after_seq": 0,
                "limit": 10,
                "include_system_prompt": False,
                "include_attachments": False,
            },
        )

        assert isinstance(out, list)
        assert all(isinstance(x, types.TextContent) for x in out), \
            "With include_attachments=False, all blocks should be TextContent"
        assert any("text with image" in x.text for x in out)
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_msg_list_blocks_include_attachments_true_default():
    """UP-33: include_attachments=true (default) should still return ImageContent."""
    db = await _make_db()
    try:
        thread = await crud.thread_create(db, topic="with-attachments-default")
        await _post_message(
            db,
            thread_id=thread.id,
            author="human",
            content="with images",
            role="user",
            metadata={
                "attachments": [
                    {"type": "image", "mimeType": "image/png", "data": "iVBORw0KGgo="}
                ]
            },
        )

        out = await handle_msg_list(
            db,
            {
                "thread_id": thread.id,
                "after_seq": 0,
                "limit": 10,
                "include_system_prompt": False,
            },
        )

        assert any(isinstance(x, types.ImageContent) for x in out), \
            "Default include_attachments=True should return ImageContent"
    finally:
        await db.close()
