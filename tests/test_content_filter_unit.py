"""
Unit tests for UP-07: Content Filter.
Tests the filter logic and CRUD integration without requiring a running server.
Uses an in-memory SQLite database.
"""
import asyncio
import os
import pytest
import aiosqlite

os.environ["AGENTCHATBUS_CONTENT_FILTER_ENABLED"] = "true"

from agentchatbus.content_filter import check_content, ContentFilterError, SECRET_PATTERNS
from agentchatbus.config import CONTENT_FILTER_ENABLED
from agentchatbus.db.database import init_schema
from agentchatbus.db import crud


# ─────────────────────────────────────────────
# Pure unit tests — no DB needed
# ─────────────────────────────────────────────

class TestCheckContent:
    def test_allows_normal_text(self):
        blocked, pattern = check_content("The refactor looks good, great work!")
        assert blocked is False
        assert pattern is None

    def test_blocks_aws_access_key(self):
        blocked, pattern = check_content("Use key AKIAIOSFODNN7EXAMPLE123 to access bucket")
        assert blocked is True
        assert "AWS" in pattern

    def test_blocks_aws_temp_key(self):
        blocked, pattern = check_content("Temp key: ASIAQNZAKIIOSFODNN7E")
        assert blocked is True
        assert "AWS" in pattern

    def test_blocks_github_pat(self):
        blocked, pattern = check_content("My token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456abcd")
        assert blocked is True
        assert "GitHub" in pattern

    def test_blocks_github_oauth(self):
        blocked, pattern = check_content("OAuth: gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456abcd")
        assert blocked is True
        assert "GitHub" in pattern

    def test_blocks_private_key_rsa(self):
        blocked, pattern = check_content("-----BEGIN RSA PRIVATE KEY-----\nMIIEpA...")
        assert blocked is True
        assert "Private Key" in pattern

    def test_blocks_private_key_generic(self):
        blocked, pattern = check_content("-----BEGIN PRIVATE KEY-----")
        assert blocked is True
        assert "Private Key" in pattern

    def test_blocks_slack_bot_token(self):
        blocked, pattern = check_content("Slack: xoxb-123456789-ABCDEFGHIJ")
        assert blocked is True
        assert "Slack" in pattern

    def test_allows_technical_discussion_about_tokens(self):
        """Talking about token rotation strategy should not be blocked."""
        blocked, _ = check_content(
            "We should rotate the token every 30 days and store it in a secrets manager, not in code."
        )
        assert blocked is False

    def test_allows_code_snippet_without_real_secrets(self):
        blocked, _ = check_content(
            "const token = process.env.API_TOKEN; // read from environment"
        )
        assert blocked is False

    def test_content_filter_error_has_pattern_name(self):
        err = ContentFilterError("AWS Access Key ID")
        assert err.pattern_name == "AWS Access Key ID"
        assert "AWS Access Key ID" in str(err)

    def test_config_enabled_by_default(self):
        assert CONTENT_FILTER_ENABLED is True


# ─────────────────────────────────────────────
# FastAPI handler integration test (no server)
# ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_crud_msg_post_blocks_aws_key():
    """
    Verify that crud.msg_post raises ContentFilterError for AWS keys.
    Uses an isolated in-memory DB.
    """
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)
    try:
        thread = await crud.thread_create(db, "unit-test-cf-thread")
        sync = await crud.issue_reply_token(db, thread_id=thread.id)

        with pytest.raises(ContentFilterError) as exc_info:
            await crud.msg_post(
                db,
                thread.id,
                "human",
                "AKIAIOSFODNN7EXAMPLE123",
                expected_last_seq=sync["current_seq"],
                reply_token=sync["reply_token"],
            )
        assert "AWS" in exc_info.value.pattern_name
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_crud_msg_post_allows_normal():
    """Normal content must pass through without error."""
    db = await aiosqlite.connect(":memory:")
    db.row_factory = aiosqlite.Row
    await init_schema(db)
    try:
        thread = await crud.thread_create(db, "unit-test-normal-thread")
        sync = await crud.issue_reply_token(db, thread_id=thread.id)
        msg = await crud.msg_post(
            db,
            thread.id,
            "human",
            "This looks like a solid implementation.",
            expected_last_seq=sync["current_seq"],
            reply_token=sync["reply_token"],
        )
        assert msg.seq > 0
        assert msg.content == "This looks like a solid implementation."
    finally:
        await db.close()
