"""
Unit tests for UP-07: Content Filter.
Tests the filter logic and CRUD integration without requiring a running server.
Uses an in-memory SQLite database.
"""
import asyncio
import os
import pytest

# Use an in-memory DB for unit tests
os.environ["AGENTCHATBUS_DB"] = ":memory:"
os.environ["AGENTCHATBUS_CONTENT_FILTER_ENABLED"] = "true"

from src.content_filter import check_content, ContentFilterError, SECRET_PATTERNS
from src.config import CONTENT_FILTER_ENABLED


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
    Uses the shared DB singleton — creates a thread first.
    """
    # Force fresh DB for this test
    os.environ["AGENTCHATBUS_DB"] = "data/test_unit_cf.db"

    # Reset singleton so it picks up the new DB path
    import src.db.database as dbmod
    if dbmod._db is not None:
        await dbmod.close_db()
        dbmod._db = None

    from src.db.database import get_db
    from src.db import crud

    db = await get_db()
    thread = await crud.thread_create(db, "unit-test-cf-thread")

    with pytest.raises(ContentFilterError) as exc_info:
        await crud.msg_post(db, thread.id, "human", "AKIAIOSFODNN7EXAMPLE123")
    assert "AWS" in exc_info.value.pattern_name

    # Cleanup
    await dbmod.close_db()
    dbmod._db = None
    # Remove test DB files
    import pathlib
    for f in pathlib.Path("data").glob("test_unit_cf*"):
        try:
            f.unlink()
        except Exception:
            pass


@pytest.mark.asyncio
async def test_crud_msg_post_allows_normal():
    """Normal content must pass through without error."""
    os.environ["AGENTCHATBUS_DB"] = "data/test_unit_cf2.db"

    import src.db.database as dbmod
    if dbmod._db is not None:
        await dbmod.close_db()
        dbmod._db = None

    from src.db.database import get_db
    from src.db import crud

    db = await get_db()
    thread = await crud.thread_create(db, "unit-test-normal-thread")
    msg = await crud.msg_post(db, thread.id, "human", "This looks like a solid implementation.")
    assert msg.seq > 0
    assert msg.content == "This looks like a solid implementation."

    await dbmod.close_db()
    dbmod._db = None
    import pathlib
    for f in pathlib.Path("data").glob("test_unit_cf2*"):
        try:
            f.unlink()
        except Exception:
            pass
