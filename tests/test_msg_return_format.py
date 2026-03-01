import json

import aiosqlite
import pytest

import mcp.types as types

from src.db import crud
from src.db.database import init_schema
from src.tools.dispatch import handle_msg_list


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
        await crud.msg_post(
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
        await crud.msg_post(
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
        await crud.msg_post(
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
