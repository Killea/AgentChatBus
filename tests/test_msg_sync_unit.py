import aiosqlite
import pytest

from agentchatbus.config import SEQ_TOLERANCE
from agentchatbus.db import crud
from agentchatbus.db.database import init_schema


async def _make_db() -> aiosqlite.Connection:
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)
    return db


async def _post_with_fresh_token(db, thread_id: str, author: str, content: str):
    sync = await crud.issue_reply_token(db, thread_id=thread_id)
    return await crud.msg_post(
        db,
        thread_id=thread_id,
        author=author,
        content=content,
        expected_last_seq=sync["current_seq"],
        reply_token=sync["reply_token"],
    )


@pytest.mark.asyncio
async def test_msg_post_requires_sync_fields():
    db = await _make_db()
    try:
        thread = await crud.thread_create(db, topic="sync-required")
        with pytest.raises(crud.MissingSyncFieldsError):
            await crud.msg_post(
                db,
                thread_id=thread.id,
                author="human",
                content="hello",
                expected_last_seq=None,
                reply_token="",
            )
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_reply_token_replay_is_rejected():
    db = await _make_db()
    try:
        thread = await crud.thread_create(db, topic="sync-replay")
        sync = await crud.issue_reply_token(db, thread_id=thread.id)

        await crud.msg_post(
            db,
            thread_id=thread.id,
            author="human",
            content="first",
            expected_last_seq=sync["current_seq"],
            reply_token=sync["reply_token"],
        )

        with pytest.raises(crud.ReplyTokenReplayError):
            await crud.msg_post(
                db,
                thread_id=thread.id,
                author="human",
                content="second",
                expected_last_seq=sync["current_seq"] + 1,
                reply_token=sync["reply_token"],
            )
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_seq_mismatch_returns_new_messages_context():
    db = await _make_db()
    try:
        thread = await crud.thread_create(db, topic="sync-seq-mismatch")
        baseline = await crud.issue_reply_token(db, thread_id=thread.id)

        # Move thread ahead beyond tolerance with valid posts.
        for i in range(SEQ_TOLERANCE + 1):
            await _post_with_fresh_token(db, thread.id, "human", f"msg-{i}")

        fresh = await crud.issue_reply_token(db, thread_id=thread.id)
        with pytest.raises(crud.SeqMismatchError) as exc_info:
            await crud.msg_post(
                db,
                thread_id=thread.id,
                author="human",
                content="stale-context-post",
                expected_last_seq=baseline["current_seq"],
                reply_token=fresh["reply_token"],
            )

        err = exc_info.value
        assert err.current_seq > err.expected_last_seq
        assert len(err.new_messages) >= SEQ_TOLERANCE
    finally:
        await db.close()


# ==================== P0 Test Suite: Token & Seq Validation ====================

@pytest.mark.asyncio
async def test_token_rejects_cross_thread_use():
    """Test 1: Token issued for thread A must not work for thread B"""
    db = await _make_db()
    try:
        thread_a = await crud.thread_create(db, topic="cross-thread-a")
        thread_b = await crud.thread_create(db, topic="cross-thread-b")
        
        # Issue token for thread A
        sync_a = await crud.issue_reply_token(db, thread_id=thread_a.id)
        
        # Try to use token_a in thread_b → should reject
        with pytest.raises(crud.ReplyTokenInvalidError):
            await crud.msg_post(
                db,
                thread_id=thread_b.id,  # ← Different thread!
                author="human",
                content="wrong-thread-use",
                expected_last_seq=sync_a["current_seq"],
                reply_token=sync_a["reply_token"],  # ← Token from thread A
            )
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_token_rejects_cross_agent_use():
    """Test 2: Token bound to agent_a must not work for agent_b"""
    db = await _make_db()
    try:
        thread = await crud.thread_create(db, topic="cross-agent")
        
        # Register two agents
        agent_a = await crud.agent_register(db, ide="VSCode", model="GPT-A", display_name=None)
        agent_b = await crud.agent_register(db, ide="VSCode", model="GPT-B", display_name=None)
        
        # Issue token bound to agent_a
        sync = await crud.issue_reply_token(db, thread_id=thread.id, agent_id=agent_a.id)
        
        # Try to use token from agent_a as agent_b → should reject
        with pytest.raises(crud.ReplyTokenInvalidError):
            await crud.msg_post(
                db,
                thread_id=thread.id,
                author=agent_b.id,  # ← Different agent!
                content="wrong-agent-use",
                expected_last_seq=sync["current_seq"],
                reply_token=sync["reply_token"],  # ← Token bound to agent_a
            )
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_seq_tolerance_boundary_exactly_five():
    """Test 3: Seq tolerance boundary - exactly 5 msgs should PASS, >5 should FAIL"""
    db = await _make_db()
    try:
        thread = await crud.thread_create(db, topic="seq-boundary")
        baseline = await crud.issue_reply_token(db, thread_id=thread.id)
        baseline_seq = baseline["current_seq"]
        
        # Advance thread by exactly SEQ_TOLERANCE (5) messages
        for i in range(SEQ_TOLERANCE):  # Add 5 messages
            await _post_with_fresh_token(db, thread.id, "human", f"msg-{i}")
        
        # Get fresh token
        fresh = await crud.issue_reply_token(db, thread_id=thread.id)
        
        # Case 1: new_count = 5 should PASS (tolerance limit)
        current_seq = await crud.thread_latest_seq(db, thread.id)
        assert current_seq - baseline_seq == SEQ_TOLERANCE  # Verify exactly 5 messages added
        
        # This should succeed (new_messages_count = 5, NOT > 5)
        msg = await crud.msg_post(
            db,
            thread_id=thread.id,
            author="human",
            content="at-tolerance-boundary",
            expected_last_seq=baseline_seq,
            reply_token=fresh["reply_token"],
        )
        assert msg is not None  # Should succeed
        
        # Case 2: Add one more message, now new_count = 6 should FAIL
        for i in range(1):  # Add 1 more message → total 6 beyond baseline
            await _post_with_fresh_token(db, thread.id, "human", "msg-extra")
        
        fresh2 = await crud.issue_reply_token(db, thread_id=thread.id)
        
        # This should fail (new_messages_count = 6 > SEQ_TOLERANCE)
        with pytest.raises(crud.SeqMismatchError) as exc_info:
            await crud.msg_post(
                db,
                thread_id=thread.id,
                author="human",
                content="beyond-tolerance",
                expected_last_seq=baseline_seq,
                reply_token=fresh2["reply_token"],
            )
        
        err = exc_info.value
        assert err.current_seq - err.expected_last_seq > SEQ_TOLERANCE
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_concurrent_token_consumption_race():
    """Test 4: Two concurrent msg_post calls with same token → one succeeds, one fails"""
    import asyncio
    db = await _make_db()
    try:
        thread = await crud.thread_create(db, topic="concurrent-race")
        sync = await crud.issue_reply_token(db, thread_id=thread.id)
        
        # Prepare two identical msg_post calls with the same token
        async def attempt_post(author: str, content: str):
            return await crud.msg_post(
                db,
                thread_id=thread.id,
                author=author,
                content=content,
                expected_last_seq=sync["current_seq"],
                reply_token=sync["reply_token"],  # ← Same token!
            )
        
        # Launch both concurrently
        task1 = asyncio.create_task(attempt_post("agent1", "first-attempt"))
        task2 = asyncio.create_task(attempt_post("agent2", "second-attempt"))
        
        results = await asyncio.gather(task1, task2, return_exceptions=True)
        
        # One should succeed (Message object), one should fail (exception)
        success_count = sum(1 for r in results if isinstance(r, crud.Message))
        failure_count = sum(1 for r in results if isinstance(r, Exception))
        
        assert success_count == 1, f"Expected 1 success, got {success_count}"
        assert failure_count == 1, f"Expected 1 failure, got {failure_count}"
        
        # The failure should be ReplyTokenReplayError
        exception = [r for r in results if isinstance(r, Exception)][0]
        assert isinstance(exception, crud.ReplyTokenReplayError), f"Expected ReplyTokenReplayError, got {type(exception)}"
        
    finally:
        await db.close()


# ==================== UP-32: Chain reply_token in msg_post response ====================

@pytest.mark.asyncio
async def test_chain_token_returned_in_msg_post():
    """UP-32: msg_post with a registered agent should return a chain reply_token."""
    import json
    from agentchatbus.tools.dispatch import handle_msg_post

    db = await _make_db()
    try:
        thread = await crud.thread_create(db, topic="chain-token")
        agent = await crud.agent_register(db, ide="Cursor", model="test-model", display_name=None)
        sync = await crud.issue_reply_token(db, thread_id=thread.id, agent_id=agent.id)

        result = await handle_msg_post(db, {
            "thread_id": thread.id,
            "author": agent.id,
            "content": "first message",
            "expected_last_seq": sync["current_seq"],
            "reply_token": sync["reply_token"],
        })

        assert len(result) == 1
        payload = json.loads(result[0].text)
        assert "msg_id" in payload
        assert "reply_token" in payload, "msg_post should return a chain reply_token for agents"
        assert "current_seq" in payload
        assert "reply_window" in payload
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_chain_token_usable_for_next_post():
    """UP-32: The chained reply_token from msg_post should be usable for the next msg_post."""
    import json
    from agentchatbus.tools.dispatch import handle_msg_post

    db = await _make_db()
    try:
        thread = await crud.thread_create(db, topic="chain-usable")
        agent = await crud.agent_register(db, ide="Cursor", model="test-model", display_name=None)
        sync = await crud.issue_reply_token(db, thread_id=thread.id, agent_id=agent.id)

        result1 = await handle_msg_post(db, {
            "thread_id": thread.id,
            "author": agent.id,
            "content": "message 1",
            "expected_last_seq": sync["current_seq"],
            "reply_token": sync["reply_token"],
        })
        payload1 = json.loads(result1[0].text)
        chain_token = payload1["reply_token"]
        chain_seq = payload1["current_seq"]

        result2 = await handle_msg_post(db, {
            "thread_id": thread.id,
            "author": agent.id,
            "content": "message 2",
            "expected_last_seq": chain_seq,
            "reply_token": chain_token,
        })
        payload2 = json.loads(result2[0].text)
        assert "msg_id" in payload2
        assert "reply_token" in payload2, "Second post should also chain a token"
        assert payload2["reply_token"] != chain_token, "Each chain should issue a new token"
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_chain_token_original_consumed():
    """UP-32: After chaining, the original token should be consumed (replay rejected)."""
    import json
    from agentchatbus.tools.dispatch import handle_msg_post

    db = await _make_db()
    try:
        thread = await crud.thread_create(db, topic="chain-consumed")
        agent = await crud.agent_register(db, ide="Cursor", model="test-model", display_name=None)
        sync = await crud.issue_reply_token(db, thread_id=thread.id, agent_id=agent.id)

        result1 = await handle_msg_post(db, {
            "thread_id": thread.id,
            "author": agent.id,
            "content": "message 1",
            "expected_last_seq": sync["current_seq"],
            "reply_token": sync["reply_token"],
        })
        payload1 = json.loads(result1[0].text)
        assert "msg_id" in payload1

        result2 = await handle_msg_post(db, {
            "thread_id": thread.id,
            "author": agent.id,
            "content": "replay attempt",
            "expected_last_seq": payload1["current_seq"],
            "reply_token": sync["reply_token"],
        })
        payload2 = json.loads(result2[0].text)
        assert "error" in payload2, "Original token should be rejected after chain"
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_no_chain_token_for_anonymous_author():
    """UP-32: msg_post without a registered agent should NOT return chain token fields."""
    import json
    from agentchatbus.tools.dispatch import handle_msg_post

    db = await _make_db()
    try:
        thread = await crud.thread_create(db, topic="no-chain-anon")
        sync = await crud.issue_reply_token(db, thread_id=thread.id)

        result = await handle_msg_post(db, {
            "thread_id": thread.id,
            "author": "anonymous-user",
            "content": "anon message",
            "expected_last_seq": sync["current_seq"],
            "reply_token": sync["reply_token"],
        })

        payload = json.loads(result[0].text)
        assert "msg_id" in payload
        assert "reply_token" not in payload, "Anonymous author should not get chain token"
    finally:
        await db.close()
