#!/usr/bin/env python3
"""
Test script to verify image upload and message metadata flow.
"""
import asyncio
import json
from pathlib import Path
import pytest
import aiosqlite

from agentchatbus.db.database import init_schema
from agentchatbus.db import crud


@pytest.mark.asyncio
async def test_image_flow():
    """Test the complete image upload and message flow."""
    
    # Import after path setup
    import sys
    sys.path.insert(0, str(Path(__file__).parent))
    
    print("="*60)
    print("Testing Image Upload and Message Metadata Flow")
    print("="*60)
    
    # Get database connection
    print("\n1. Initializing database...")
    try:
        db = await aiosqlite.connect(":memory:")
        db.row_factory = aiosqlite.Row
        await init_schema(db)
        print("   Database connected")
    except Exception as e:
        pytest.fail(f"Error connecting to database: {e}")
    
    # Create a test thread
    print("\n2. Creating test thread...")
    try:
        thread = await crud.thread_create(db, "Test Thread for Images")
        thread_id = thread.id
        print(f"   Created thread: {thread_id}")
    except Exception as e:
        pytest.fail(f"Error creating thread: {e}")
    
    # Create a message with image metadata
    print("\n3. Creating message with image metadata...")
    try:
        test_images = [
            {"url": "/static/uploads/test-image-1.jpg", "name": "test1.jpg"},
            {"url": "/static/uploads/test-image-2.png", "name": "test2.png"}
        ]
        test_metadata = {
            "images": test_images,
            "mentions": ["agent-1", "agent-2"]
        }
        sync = await crud.issue_reply_token(db, thread_id=thread_id)
        
        msg = await crud.msg_post(
            db, 
            thread_id=thread_id,
            author="test_user",
            content="Test message with images",
            expected_last_seq=sync["current_seq"],
            reply_token=sync["reply_token"],
            role="user",
            metadata=test_metadata
        )
        msg_id = msg.id
        print(f"   Created message: {msg_id}")
        print(f"   Metadata stored: {msg.metadata}")
    except Exception as e:
        pytest.fail(f"Error creating message: {e}")
    
    # Retrieve the message and verify metadata
    print("\n4. Retrieving message to verify metadata...")
    try:
        retrieved_msgs = await crud.msg_list(db, thread_id, after_seq=0, limit=10, include_system_prompt=False)
        assert retrieved_msgs, "No messages retrieved"
        msg = retrieved_msgs[0]
        print(f"   Retrieved message: {msg.id}")
        print(f"   Content: {msg.content}")
        print(f"   Raw metadata: {msg.metadata}")

        assert msg.metadata, "No metadata stored"
        parsed_meta = json.loads(msg.metadata)
        print(f"   Parsed metadata: {json.dumps(parsed_meta, indent=2)}")

        assert "images" in parsed_meta, "No images in metadata"
        assert len(parsed_meta["images"]) == 2, "Unexpected image count"
        assert parsed_meta["images"][0]["url"] == "/static/uploads/test-image-1.jpg"
        assert parsed_meta["images"][1]["url"] == "/static/uploads/test-image-2.png"

        assert "mentions" in parsed_meta, "No mentions in metadata"
        assert parsed_meta["mentions"] == ["agent-1", "agent-2"]
    except Exception as e:
        pytest.fail(f"Error retrieving message: {e}")
    
    print("\n" + "="*60)
    print("Test Complete")
    print("="*60)
    try:
        await db.close()
    except Exception:
        pass

@pytest.mark.asyncio
async def test_message_to_blocks_async_loads_image_from_file(tmp_path):
    """UP-31: Verify _message_to_blocks reads image bytes asynchronously via asyncio.to_thread."""
    from unittest.mock import patch
    from agentchatbus.tools.dispatch import _message_to_blocks
    from agentchatbus.db.models import Message

    img_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
    img_file = tmp_path / "test-async.png"
    img_file.write_bytes(img_bytes)

    msg = Message(
        id="test-async-img",
        thread_id="t1",
        seq=1,
        author="human",
        role="user",
        content="check this",
        metadata=json.dumps({"images": [{"url": "/static/uploads/test-async.png"}]}),
        created_at=None,
        reply_to_msg_id=None,
    )

    with patch("agentchatbus.tools.dispatch._url_to_local_upload_path", return_value=img_file):
        blocks = await _message_to_blocks(msg)

    import mcp.types as types
    image_blocks = [b for b in blocks if isinstance(b, types.ImageContent)]
    assert len(image_blocks) == 1
    assert image_blocks[0].mimeType == "image/png"

    import base64
    expected_data = base64.b64encode(img_bytes).decode("ascii")
    assert image_blocks[0].data == expected_data


@pytest.mark.asyncio
async def test_message_to_blocks_include_attachments_false():
    """UP-31/33: Verify include_attachments=False skips image processing entirely."""
    from agentchatbus.tools.dispatch import _message_to_blocks
    from agentchatbus.db.models import Message

    msg = Message(
        id="test-no-attach",
        thread_id="t1",
        seq=1,
        author="human",
        role="user",
        content="text only",
        metadata=json.dumps({"attachments": [{"type": "image", "mimeType": "image/png", "data": "abc123"}]}),
        created_at=None,
        reply_to_msg_id=None,
    )

    blocks = await _message_to_blocks(msg, include_attachments=False)

    import mcp.types as types
    assert all(isinstance(b, types.TextContent) for b in blocks)
    assert any("text only" in b.text for b in blocks)


if __name__ == "__main__":
    asyncio.run(test_image_flow())


