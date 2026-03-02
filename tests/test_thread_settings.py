"""
Integration tests for thread settings and automatic admin coordination.
"""
import pytest
import asyncio
import json
import uuid
import aiosqlite
from datetime import datetime, timedelta, timezone
from src.db import crud
from src.db.database import init_schema


@pytest.fixture
async def db_with_thread():
    """Create a test thread and return db + thread_id."""
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)
    # Use unique thread_id to ensure test isolation
    topic = f"test-thread-settings-{uuid.uuid4().hex[:8]}"
    thread = await crud.thread_create(db, topic=topic)
    try:
        yield db, thread.id
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_thread_settings_get_or_create(db_with_thread):
    """Test auto-creation of thread settings with defaults."""
    db, thread_id = db_with_thread
    
    settings = await crud.thread_settings_get_or_create(db, thread_id)
    
    assert settings is not None
    assert settings.thread_id == thread_id
    assert settings.auto_coordinator_enabled is True
    assert settings.timeout_seconds == 60
    assert settings.auto_assigned_admin_id is None


@pytest.mark.asyncio
async def test_thread_settings_update(db_with_thread):
    """Test updating thread settings."""
    db, thread_id = db_with_thread
    
    # Create settings first
    await crud.thread_settings_get_or_create(db, thread_id)
    
    # Update timeout
    updated = await crud.thread_settings_update(
        db,
        thread_id,
        auto_coordinator_enabled=True,
        timeout_seconds=120
    )
    
    assert updated.timeout_seconds == 120
    
    # Verify persistence
    fetched = await crud.thread_settings_get_or_create(db, thread_id)
    assert fetched.timeout_seconds == 120


@pytest.mark.asyncio
async def test_thread_settings_update_invalid_timeout(db_with_thread):
    """Test that invalid timeout values are rejected."""
    db, thread_id = db_with_thread
    
    # Create settings first
    await crud.thread_settings_get_or_create(db, thread_id)
    
    # Try to set timeout out of range
    with pytest.raises(ValueError):
        await crud.thread_settings_update(db, thread_id, timeout_seconds=5)
    
    with pytest.raises(ValueError):
        await crud.thread_settings_update(db, thread_id, timeout_seconds=400)


@pytest.mark.asyncio
async def test_thread_settings_update_activity(db_with_thread):
    """Test activity time update and admin reset."""
    db, thread_id = db_with_thread
    
    # Create settings and assign admin
    settings = await crud.thread_settings_get_or_create(db, thread_id)
    old_activity = settings.last_activity_time
    
    # Wait a bit to ensure time difference
    await asyncio.sleep(0.1)
    
    # Assign admin
    await crud.thread_settings_assign_admin(db, thread_id, "agent-1", "TestAgent")
    settings = await crud.thread_settings_get_or_create(db, thread_id)
    assert settings.auto_assigned_admin_id == "agent-1"
    
    # Update activity (simulating message post)
    await asyncio.sleep(0.1)
    await crud.thread_settings_update_activity(db, thread_id)
    
    # Verify admin was cleared and activity updated
    settings = await crud.thread_settings_get_or_create(db, thread_id)
    assert settings.auto_assigned_admin_id is None
    assert settings.last_activity_time > old_activity


@pytest.mark.asyncio
async def test_message_updates_activity(db_with_thread):
    """Test that posting a message updates thread activity."""
    db, thread_id = db_with_thread
    
    # Create settings
    settings_before = await crud.thread_settings_get_or_create(db, thread_id)
    old_activity = settings_before.last_activity_time
    
    # Get current seq before posting
    messages_before = await crud.msg_list(db, thread_id, include_system_prompt=False)
    current_seq = messages_before[-1].seq if messages_before else 0
    
    # Wait then post message
    await asyncio.sleep(0.1)
    token_response = await crud.issue_reply_token(db, thread_id, None)
    msg = await crud.msg_post(
        db,
        thread_id=thread_id,
        author="test-author",
        content="Test message",
        expected_last_seq=current_seq,
        reply_token=token_response["reply_token"],
        role="user",
    )
    
    # Verify activity was updated
    settings_after = await crud.thread_settings_get_or_create(db, thread_id)
    assert settings_after.last_activity_time > old_activity


@pytest.mark.asyncio
async def test_timeout_detection_simple(db_with_thread):
    """Test that timed-out threads can be detected by comparing times programmatically."""
    db, thread_id = db_with_thread
    
    # Create settings with 10 second timeout
    settings = await crud.thread_settings_get_or_create(db, thread_id)
    await crud.thread_settings_update(db, thread_id, timeout_seconds=10)
    
    # Backdate last_activity_time by updating directly
    old_time = (datetime.now(timezone.utc) - timedelta(seconds=15)).isoformat()
    async with db.execute(
        "UPDATE thread_settings SET last_activity_time = ? WHERE thread_id = ?",
        (old_time, thread_id)
    ) as cur:
        pass
    await db.commit()
    
    # Get the updated settings
    settings = await crud.thread_settings_get_or_create(db, thread_id)
    
    # Manually check if it should timeout
    elapsed = (datetime.now(timezone.utc) - settings.last_activity_time.replace(tzinfo=timezone.utc)).total_seconds()
    
    # Should be ~15 seconds elapsed with 10 second timeout
    assert elapsed >= settings.timeout_seconds
    assert settings.auto_coordinator_enabled is True
    assert settings.auto_assigned_admin_id is None


@pytest.mark.asyncio
async def test_assign_admin(db_with_thread):
    """Test admin assignment."""
    db, thread_id = db_with_thread
    
    # Create settings
    await crud.thread_settings_get_or_create(db, thread_id)
    
    # Assign admin
    assigned = await crud.thread_settings_assign_admin(
        db,
        thread_id,
        "agent-uuid-123",
        "MyTestAgent"
    )
    
    assert assigned.auto_assigned_admin_id == "agent-uuid-123"
    assert assigned.auto_assigned_admin_name == "MyTestAgent"
    assert assigned.admin_assignment_time is not None
    
    # Verify persistence
    fetched = await crud.thread_settings_get_or_create(db, thread_id)
    assert fetched.auto_assigned_admin_id == "agent-uuid-123"


@pytest.mark.asyncio
async def test_system_message_creation(db_with_thread):
    """Test creation of system messages without reply tokens."""
    db, thread_id = db_with_thread
    
    # Create system message
    msg = await crud._msg_create_system(
        db,
        thread_id,
        "System test message",
        metadata={"test": True}
    )
    
    assert msg.author == "system"
    assert msg.role == "system"
    assert msg.content == "System test message"
    assert msg.author_id == "system"
    
    # Verify in messages table
    messages = await crud.msg_list(db, thread_id, include_system_prompt=False)
    system_msgs = [m for m in messages if m.author == "system" and m.role == "system"]
    assert len(system_msgs) > 0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
