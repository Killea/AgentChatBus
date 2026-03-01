"""
Integration tests for AgentChatBus HTTP endpoints.

These tests require a running local server at BASE_URL.
If the server is not reachable, tests are skipped (not failed).
"""

import os
import httpx
import pytest

# Use the same test port as conftest.py (39766) to connect to test server
BASE_URL = os.getenv("AGENTCHATBUS_BASE_URL", "http://127.0.0.1:39766")


def _build_client() -> httpx.Client:
    return httpx.Client(base_url=BASE_URL, timeout=10)


def _require_server_or_skip(client: httpx.Client) -> None:
    try:
        # /api/threads is lightweight and available in normal startup.
        resp = client.get("/api/threads")
        if resp.status_code < 500:
            return
    except Exception:
        pass
    pytest.skip(f"AgentChatBus server is not reachable at {BASE_URL}")


@pytest.fixture(scope="module")
def thread_id() -> str:
    with _build_client() as client:
        _require_server_or_skip(client)

        topic = "E2E-Idempotency-Test"
        r1 = client.post("/api/threads", json={"topic": topic})
        assert r1.status_code == 201, r1.text
        id1 = r1.json()["id"]

        # Creating same topic again should return same thread id (idempotent).
        r2 = client.post("/api/threads", json={"topic": topic})
        assert r2.status_code == 201, r2.text
        id2 = r2.json()["id"]

        assert id1 == id2
        return id1


def test_thread_idempotency(thread_id: str):
    assert isinstance(thread_id, str)
    assert thread_id


def test_transcript_uri_message_post(thread_id: str):
    with _build_client() as client:
        _require_server_or_skip(client)

        # This validates that the thread id from fixture is usable for message posting.
        r = client.post(
            f"/api/threads/{thread_id}/messages",
            json={"author": "test-agent", "role": "user", "content": "Test message for E2E"},
        )
        assert r.status_code == 201, r.text

        body = r.json()
        assert "id" in body
        assert "seq" in body


# ─────────────────────────────────────────────
# UP-07: Content Filter Tests
# ─────────────────────────────────────────────

@pytest.fixture(scope="module")
def cf_thread_id() -> str:
    """Dedicated thread for content filter tests."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = client.post("/api/threads", json={"topic": "E2E-ContentFilter-Test"})
        assert r.status_code == 201, r.text
        return r.json()["id"]


def test_content_filter_allows_normal_text(cf_thread_id: str):
    """Normal messages must not be blocked."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = client.post(
            f"/api/threads/{cf_thread_id}/messages",
            json={"author": "test-agent", "role": "user", "content": "The refactor looks good, great work!"},
        )
        assert r.status_code == 201, r.text


def test_content_filter_blocks_aws_key(cf_thread_id: str):
    """Messages containing AWS access key IDs must be blocked with HTTP 400."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = client.post(
            f"/api/threads/{cf_thread_id}/messages",
            json={"author": "test-agent", "role": "user", "content": "Use key AKIAIOSFODNN7EXAMPLE123 to access the bucket"},
        )
        assert r.status_code == 400, r.text
        body = r.json()
        assert "detail" in body
        detail = body["detail"]
        assert "pattern" in detail
        assert "AWS" in detail["pattern"]


def test_content_filter_blocks_github_token(cf_thread_id: str):
    """Messages containing GitHub personal access tokens must be blocked."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = client.post(
            f"/api/threads/{cf_thread_id}/messages",
            json={"author": "test-agent", "role": "user", "content": "My token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456abcd"},
        )
        assert r.status_code == 400, r.text
        body = r.json()
        assert "detail" in body
        assert "pattern" in body["detail"]


def test_content_filter_allows_technical_discussion(cf_thread_id: str):
    """Technical code discussions mentioning 'token' in context must not be blocked."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = client.post(
            f"/api/threads/{cf_thread_id}/messages",
            json={"author": "test-agent", "role": "user",
                  "content": "We should rotate the token every 30 days and store it in a secrets manager, not in code."},
        )
        assert r.status_code == 201, r.text
