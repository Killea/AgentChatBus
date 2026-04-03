"""
Integration tests for thread settings and automatic admin coordination.
"""
import pytest
import asyncio
import json
import uuid
import aiosqlite
from datetime import datetime, timedelta, timezone
from agentchatbus.db import crud
from agentchatbus.db.database import init_schema


@pytest.fixture
async def db():
    """Return an isolated in-memory database connection per test."""
    conn = await aiosqlite.connect(":memory:")
    conn.row_factory = aiosqlite.Row
    await init_schema(conn)
    try:
        yield conn
    finally:
        await conn.close()


async def create_test_thread(db):
    """Helper to create a thread with unique ID."""
    thread = await crud.thread_create(db, topic=f"test-thread-{uuid.uuid4()}")
    return thread.id


@pytest.mark.asyncio
async def test_thread_settings_get_or_create(db):
    """Test auto-creation of thread settings with defaults."""
    thread_id = await create_test_thread(db)
    
    settings = await crud.thread_settings_get_or_create(db, thread_id)
    
    assert settings is not None
    assert settings.thread_id == thread_id
    assert settings.auto_coordinator_enabled is True
    assert settings.timeout_seconds == 60
    assert settings.auto_assigned_admin_id is None


@pytest.mark.asyncio
async def test_thread_settings_update(db):
    """Test updating thread settings."""
    thread_id = await create_test_thread(db)
    
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
async def test_thread_settings_update_invalid_timeout(db):
    """Test that timeout below minimum is rejected."""
    thread_id = await create_test_thread(db)
    
    # Create settings first
    await crud.thread_settings_get_or_create(db, thread_id)
    
    # Try to set timeout below minimum
    with pytest.raises(ValueError):
        await crud.thread_settings_update(db, thread_id, timeout_seconds=29)


@pytest.mark.asyncio
async def test_thread_settings_update_allows_large_timeout(db):
    """Large timeout values are allowed (no max cap)."""
    thread_id = await create_test_thread(db)
    await crud.thread_settings_get_or_create(db, thread_id)

    updated = await crud.thread_settings_update(db, thread_id, timeout_seconds=3600)
    assert updated.timeout_seconds == 3600


@pytest.mark.asyncio
async def test_thread_settings_update_activity(db):
    """Test activity time update and admin reset."""
    thread_id = await create_test_thread(db)
    
    # Create settings and assign admin
    settings = await crud.thread_settings_get_or_create(db, thread_id)
    old_activity = settings.last_activity_time
    
    # Wait a bit to ensure time difference
    await asyncio.sleep(0.1)
    
    # Enable auto coordinator before automatic admin assignment.
    await crud.thread_settings_update(db, thread_id, auto_coordinator_enabled=True)

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
async def test_message_updates_activity(db):
    """Test that posting a message updates thread activity."""
    thread_id = await create_test_thread(db)
    
    # Create settings
    settings_before = await crud.thread_settings_get_or_create(db, thread_id)
    old_activity = settings_before.last_activity_time
    
    # Wait then post message
    await asyncio.sleep(0.1)
    current_seq = await crud.thread_latest_seq(db, thread_id)
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
async def test_timeout_detection_simple(db):
    """Test that timed-out threads can be detected by comparing times programmatically."""
    thread_id = await create_test_thread(db)
    
    # Create settings with 30 second timeout
    settings = await crud.thread_settings_get_or_create(db, thread_id)
    await crud.thread_settings_update(db, thread_id, timeout_seconds=30)
    
    # Backdate last_activity_time by updating directly
    old_time = (datetime.now(timezone.utc) - timedelta(seconds=35)).isoformat()
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
    
    # Should be ~35 seconds elapsed with 30 second timeout
    assert elapsed >= settings.timeout_seconds
    assert settings.auto_coordinator_enabled is True
    assert settings.auto_assigned_admin_id is None


@pytest.mark.asyncio
async def test_assign_admin(db):
    """Test admin assignment."""
    thread_id = await create_test_thread(db)
    
    # Create settings
    await crud.thread_settings_get_or_create(db, thread_id)
    
    # Enable auto coordinator before automatic admin assignment.
    await crud.thread_settings_update(db, thread_id, auto_coordinator_enabled=True)

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
async def test_assign_admin_ignored_when_auto_coordinator_disabled(db):
    """Auto assignment must be ignored when auto coordinator is disabled."""
    thread_id = await create_test_thread(db)
    await crud.thread_settings_get_or_create(db, thread_id)
    await crud.thread_settings_update(db, thread_id, auto_coordinator_enabled=False)

    await crud.thread_settings_assign_admin(db, thread_id, "agent-disabled", "DisabledAgent")
    fetched = await crud.thread_settings_get_or_create(db, thread_id)

    assert fetched.auto_coordinator_enabled is False
    assert fetched.auto_assigned_admin_id is None
    assert fetched.auto_assigned_admin_name is None


@pytest.mark.asyncio
async def test_set_creator_admin_ignored_when_auto_coordinator_disabled(db):
    """Creator auto-assignment must be ignored when auto coordinator is disabled."""
    thread_id = await create_test_thread(db)
    await crud.thread_settings_get_or_create(db, thread_id)
    await crud.thread_settings_update(db, thread_id, auto_coordinator_enabled=False)

    await crud.thread_settings_set_creator_admin(db, thread_id, "creator-1", "CreatorAgent")
    fetched = await crud.thread_settings_get_or_create(db, thread_id)

    assert fetched.auto_coordinator_enabled is False
    assert fetched.creator_admin_id is None
    assert fetched.creator_admin_name is None


@pytest.mark.asyncio
async def test_system_message_creation(db):
    """Test creation of system messages without reply tokens."""
    thread_id = await create_test_thread(db)
    
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
    system_msgs = [m for m in messages if m.author == "system" and m.role == "system" and "test message" in m.content]
    assert len(system_msgs) > 0


@pytest.mark.asyncio
async def test_thread_delete_with_reactions_and_settings(db):
    """Deleting a thread must remove dependent rows and not violate FK constraints."""
    thread_id = await create_test_thread(db)

    # Ensure settings row exists (created automatically on thread_create path).
    settings = await crud.thread_settings_get_or_create(db, thread_id)
    assert settings.thread_id == thread_id

    # Create a message and a reaction that references this message.
    sync = await crud.issue_reply_token(db, thread_id=thread_id)
    msg = await crud.msg_post(
        db,
        thread_id=thread_id,
        author="test-agent",
        content="msg for delete",
        expected_last_seq=sync["current_seq"],
        reply_token=sync["reply_token"],
        role="user",
    )
    await crud.msg_react(db, message_id=msg.id, agent_id=None, reaction="ack")

    deleted = await crud.thread_delete(db, thread_id)
    assert deleted is not None
    assert deleted["thread_id"] == thread_id

    # Verify thread and dependents are gone.
    assert await crud.thread_get(db, thread_id) is None
    async with db.execute("SELECT COUNT(*) AS cnt FROM thread_settings WHERE thread_id = ?", (thread_id,)) as cur:
        assert (await cur.fetchone())["cnt"] == 0
    async with db.execute(
        "SELECT COUNT(*) AS cnt FROM reactions WHERE message_id = ?", (msg.id,)
    ) as cur:
        assert (await cur.fetchone())["cnt"] == 0


@pytest.mark.asyncio
async def test_thread_delete_cleans_future_fk_tables(db):
    """thread_delete should keep working when new FK tables are introduced."""
    thread_id = await create_test_thread(db)

    sync = await crud.issue_reply_token(db, thread_id=thread_id)
    msg = await crud.msg_post(
        db,
        thread_id=thread_id,
        author="test-agent",
        content="fk future table probe",
        expected_last_seq=sync["current_seq"],
        reply_token=sync["reply_token"],
        role="user",
    )

    # Simulate future schema additions with new FK dependencies.
    await db.execute(
        """
        CREATE TABLE IF NOT EXISTS future_thread_links (
            id TEXT PRIMARY KEY,
            thread_ref TEXT NOT NULL REFERENCES threads(id)
        )
        """
    )
    await db.execute(
        """
        CREATE TABLE IF NOT EXISTS future_message_links (
            id TEXT PRIMARY KEY,
            message_ref TEXT NOT NULL REFERENCES messages(id)
        )
        """
    )
    await db.execute(
        "INSERT INTO future_thread_links (id, thread_ref) VALUES (?, ?)",
        ("ftl-1", thread_id),
    )
    await db.execute(
        "INSERT INTO future_message_links (id, message_ref) VALUES (?, ?)",
        ("fml-1", msg.id),
    )
    await db.commit()

    deleted = await crud.thread_delete(db, thread_id)
    assert deleted is not None

    async with db.execute("SELECT COUNT(*) AS cnt FROM future_thread_links") as cur:
        assert (await cur.fetchone())["cnt"] == 0
    async with db.execute("SELECT COUNT(*) AS cnt FROM future_message_links") as cur:
        assert (await cur.fetchone())["cnt"] == 0


# ─────────────────────────────────────────────────────────────────────────────
# MCP handler tests (UP-28)
# ─────────────────────────────────────────────────────────────────────────────

import json
from agentchatbus.tools.dispatch import handle_thread_settings_get, handle_thread_settings_update


@pytest.mark.asyncio
async def test_mcp_thread_settings_get(db):
    """thread_settings_get returns all expected fields for a valid thread."""
    thread_id = await create_test_thread(db)

    results = await handle_thread_settings_get(db, {"thread_id": thread_id})
    assert len(results) == 1
    data = json.loads(results[0].text)

    assert data["thread_id"] == thread_id
    assert "auto_administrator_enabled" in data
    assert "timeout_seconds" in data
    assert "switch_timeout_seconds" in data
    assert "auto_assigned_admin_id" in data
    assert "auto_assigned_admin_name" in data
    assert data["timeout_seconds"] == 60
    assert data["auto_administrator_enabled"] is True


@pytest.mark.asyncio
async def test_mcp_thread_settings_get_not_found(db):
    """thread_settings_get returns error for invalid thread_id."""
    results = await handle_thread_settings_get(db, {"thread_id": "nonexistent-thread-id"})
    assert len(results) == 1
    data = json.loads(results[0].text)
    assert "error" in data
    assert data["error"] == "Thread not found"


@pytest.mark.asyncio
async def test_mcp_thread_settings_update(db):
    """thread_settings_update modifies settings and returns updated values."""
    thread_id = await create_test_thread(db)

    results = await handle_thread_settings_update(db, {
        "thread_id": thread_id,
        "auto_administrator_enabled": False,
        "timeout_seconds": 120,
    })
    assert len(results) == 1
    data = json.loads(results[0].text)

    assert data["ok"] is True
    assert data["auto_administrator_enabled"] is False
    assert data["timeout_seconds"] == 120

    # Verify persistence via get
    get_results = await handle_thread_settings_get(db, {"thread_id": thread_id})
    get_data = json.loads(get_results[0].text)
    assert get_data["auto_administrator_enabled"] is False
    assert get_data["timeout_seconds"] == 120


@pytest.mark.asyncio
async def test_mcp_thread_settings_update_invalid_timeout(db):
    """thread_settings_update returns error when timeout_seconds < 30."""
    thread_id = await create_test_thread(db)

    results = await handle_thread_settings_update(db, {
        "thread_id": thread_id,
        "timeout_seconds": 10,
    })
    assert len(results) == 1
    data = json.loads(results[0].text)
    assert "error" in data
    assert "30" in data["error"]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
