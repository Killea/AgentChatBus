#!/usr/bin/env python3
"""
Test script to verify image upload and message metadata flow.
"""
import asyncio
import json
from pathlib import Path
import pytest

import src.db.database as dbmod


@pytest.mark.asyncio
async def test_image_flow():
    """Test the complete image upload and message flow."""
    
    # Import after path setup
    import sys
    sys.path.insert(0, str(Path(__file__).parent))
    
    from src.db.database import get_db
    from src.db import crud
    
    print("="*60)
    print("Testing Image Upload and Message Metadata Flow")
    print("="*60)
    
    # Get database connection
    print("\n1. Initializing database...")
    try:
        db = await get_db()
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
        
        msg = await crud.msg_post(
            db, 
            thread_id=thread_id,
            author="test_user",
            content="Test message with images",
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
        await dbmod.close_db()
    except Exception:
        pass

if __name__ == "__main__":
    asyncio.run(test_image_flow())


