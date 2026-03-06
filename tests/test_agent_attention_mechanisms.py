import json
import asyncio
from unittest.mock import patch

import aiosqlite
import pytest
from mcp import types

from src.db import crud
from src.db.database import init_schema
from src.tools import dispatch

# Helpers
async def _make_db():
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)
    return db

async def _post_msg_with_attention(db, thread_id: str):
    sync = await crud.issue_reply_token(db, thread_id=thread_id)
    return await crud.msg_post(
        db,
        thread_id=thread_id,
        author="agent-test",
        content="Testing attention mechanisms",
        expected_last_seq=sync["current_seq"],
        reply_token=sync["reply_token"],
        metadata={"handoff_target": "agent-xyz", "stop_reason": "timeout"},
        priority="urgent",
    )

@pytest.fixture
def mock_attention_true(monkeypatch):
    monkeypatch.setattr("src.tools.dispatch.ENABLE_HANDOFF_TARGET", True)
    monkeypatch.setattr("src.tools.dispatch.ENABLE_STOP_REASON", True)
    monkeypatch.setattr("src.tools.dispatch.ENABLE_PRIORITY", True)

@pytest.fixture
def mock_attention_false(monkeypatch):
    monkeypatch.setattr("src.tools.dispatch.ENABLE_HANDOFF_TARGET", False)
    monkeypatch.setattr("src.tools.dispatch.ENABLE_STOP_REASON", False)
    monkeypatch.setattr("src.tools.dispatch.ENABLE_PRIORITY", False)

@pytest.mark.asyncio
async def test_msg_get_attention_enabled(mock_attention_true):
    db = await _make_db()
    thread = await crud.thread_create(db, "Topic")
    msg = await _post_msg_with_attention(db, thread.id)
    
    # Test msg_get
    result_list = await dispatch.handle_msg_get(db, {"message_id": msg.id})
    payload = json.loads(result_list[0].text)
    
    assert payload["found"] is True
    message = payload["message"]
    
    # Should be preserved
    assert message["priority"] == "urgent"
    meta = json.loads(message["metadata"])
    assert meta.get("handoff_target") == "agent-xyz"
    assert meta.get("stop_reason") == "timeout"
    
    await db.close()

@pytest.mark.asyncio
async def test_msg_get_attention_disabled(mock_attention_false):
    db = await _make_db()
    thread = await crud.thread_create(db, "Topic")
    msg = await _post_msg_with_attention(db, thread.id)
    
    # Test msg_get
    result_list = await dispatch.handle_msg_get(db, {"message_id": msg.id})
    payload = json.loads(result_list[0].text)
    
    assert payload["found"] is True
    message = payload["message"]
    
    # Should be stripped
    assert "priority" not in message
    meta = json.loads(message["metadata"]) if message["metadata"] else {}
    assert "handoff_target" not in meta
    assert "stop_reason" not in meta
    
    await db.close()

@pytest.mark.asyncio
async def test_msg_list_attention_disabled(mock_attention_false):
    db = await _make_db()
    thread = await crud.thread_create(db, "Topic")
    await _post_msg_with_attention(db, thread.id)
    
    result_list = await dispatch.handle_msg_list(db, {"thread_id": thread.id, "after_seq": 0})
    
    # Check JSON block outputs directly via string inspection or loading
    blocks = [r.text for r in result_list if r.type == "text"]
    for text in blocks:
        try:
            payload = json.loads(text)
            if "message" in payload:
                msg = payload["message"]
                assert "priority" not in msg
                meta = json.loads(msg.get("metadata", "{}")) if msg.get("metadata") else {}
                assert "handoff_target" not in meta
                assert "stop_reason" not in meta
        except json.JSONDecodeError:
            pass
            
    await db.close()

@pytest.mark.asyncio
async def test_msg_wait_attention_disabled(mock_attention_false):
    db = await _make_db()
    thread = await crud.thread_create(db, "Topic")
    await _post_msg_with_attention(db, thread.id)
    
    result_list = await dispatch.handle_msg_wait(db, {"thread_id": thread.id, "after_seq": 0, "timeout_ms": 100})
    
    blocks = [r.text for r in result_list if r.type == "text"]
    for text in blocks:
        try:
            payload = json.loads(text)
            if "message" in payload:
                msg = payload["message"]
                assert "priority" not in msg
                meta = json.loads(msg.get("metadata", "{}")) if msg.get("metadata") else {}
                assert "handoff_target" not in meta
                assert "stop_reason" not in meta
        except json.JSONDecodeError:
            pass
            
    await db.close()

@pytest.mark.asyncio
async def test_msg_post_attention_enabled(mock_attention_true):
    db = await _make_db()
    thread = await crud.thread_create(db, "Topic")
    sync = await crud.issue_reply_token(db, thread.id)
    
    # Test msg_post
    result_list = await dispatch.handle_msg_post(db, {
        "thread_id": thread.id,
        "author": "agent-test",
        "content": "Testing post attention enabled",
        "expected_last_seq": sync["current_seq"],
        "reply_token": sync["reply_token"],
        "metadata": {"handoff_target": "agent-xyz", "stop_reason": "timeout"},
        "priority": "urgent"
    })
    
    payload = json.loads(result_list[0].text)
    assert payload["priority"] == "urgent"
    assert payload.get("handoff_target") == "agent-xyz"
    assert payload.get("stop_reason") == "timeout"
    await db.close()

@pytest.mark.asyncio
async def test_msg_post_attention_disabled(mock_attention_false):
    db = await _make_db()
    thread = await crud.thread_create(db, "Topic")
    sync = await crud.issue_reply_token(db, thread.id)
    
    # Test msg_post
    result_list = await dispatch.handle_msg_post(db, {
        "thread_id": thread.id,
        "author": "agent-test",
        "content": "Testing post attention disabled",
        "expected_last_seq": sync["current_seq"],
        "reply_token": sync["reply_token"],
        "metadata": {"handoff_target": "agent-xyz", "stop_reason": "timeout"},
        "priority": "urgent"
    })
    
    payload = json.loads(result_list[0].text)
    assert "priority" not in payload
    assert "handoff_target" not in payload
    assert "stop_reason" not in payload
    await db.close()
