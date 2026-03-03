"""
Tests for the thread Markdown export endpoint (UI-03).

GET /api/threads/{thread_id}/export
"""
import httpx
import pytest

# NOTE: This test suite must run against a dedicated test server instance.
# Do NOT default to AGENTCHATBUS_BASE_URL (which may point at a production/dev server).
from tests._constants import TEST_BASE_URL as BASE_URL


def _build_client() -> httpx.Client:
    return httpx.Client(base_url=BASE_URL, timeout=10)


def _require_server_or_skip(client: httpx.Client) -> None:
    try:
        resp = client.get("/api/threads")
        if resp.status_code < 500:
            return
    except Exception:
        pass
    pytest.skip(f"AgentChatBus server is not reachable at {BASE_URL}")


def _register_agent(client: httpx.Client) -> tuple[str, str]:
    resp = client.post(
        "/api/agents/register",
        json={"ide": "VS Code", "model": "GPT-5.3-Codex"},
    )
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    return payload["agent_id"], payload["token"]


def _create_thread(client: httpx.Client, topic: str) -> httpx.Response:
    creator_id, creator_token = _register_agent(client)
    return client.post(
        "/api/threads",
        json={"topic": topic, "creator_agent_id": creator_id},
        headers={"X-Agent-Token": creator_token},
    )


def _sync_and_post(client: httpx.Client, thread_id: str, payload: dict) -> dict:
    """Helper to sync context and post message in one call."""
    sync = client.post(f"/api/threads/{thread_id}/sync-context", json={}).json()
    payload["expected_last_seq"] = sync["current_seq"]
    payload["reply_token"] = sync["reply_token"]
    return client.post(f"/api/threads/{thread_id}/messages", json=payload)


@pytest.fixture(scope="module")
def export_thread_id() -> str:
    """Thread with 3 messages for export tests."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = _create_thread(client, "Export-Test-UI03")
        assert r.status_code == 201, r.text
        tid = r.json()["id"]

        for i in range(1, 4):
            r2 = _sync_and_post(
                client,
                tid,
                {"author": f"agent-{i}", "role": "user", "content": f"Message {i} content"},
            )
            assert r2.status_code == 201, r2.text

        return tid


def test_export_with_messages(export_thread_id: str):
    """Thread with 3 messages produces valid Markdown structure."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = client.get(f"/api/threads/{export_thread_id}/export")
        assert r.status_code == 200
        md = r.text
        assert md.startswith("# Export-Test-UI03"), f"Expected h1 title, got: {md[:80]!r}"
        assert "---" in md
        assert "Message 1 content" in md
        assert "Message 2 content" in md
        assert "Message 3 content" in md
        assert "### " in md, "Expected ### headers for messages"


def test_export_content_type(export_thread_id: str):
    """Response Content-Type must be text/markdown."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = client.get(f"/api/threads/{export_thread_id}/export")
        assert r.status_code == 200
        assert "text/markdown" in r.headers.get("content-type", "")


def test_export_content_disposition(export_thread_id: str):
    """Content-Disposition must contain a .md filename slug."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = client.get(f"/api/threads/{export_thread_id}/export")
        assert r.status_code == 200
        cd = r.headers.get("content-disposition", "")
        assert "attachment" in cd
        assert ".md" in cd


def test_export_404():
    """Non-existent thread must return 404."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = client.get("/api/threads/does-not-exist-xxxxxx/export")
        assert r.status_code == 404


def test_export_empty_thread():
    """Thread with no messages returns a markdown header without message sections."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = _create_thread(client, "Export-Empty-UI03")
        assert r.status_code == 201
        tid = r.json()["id"]

        r2 = client.get(f"/api/threads/{tid}/export")
        assert r2.status_code == 200
        md = r2.text
        assert "# Export-Empty-UI03" in md
        assert "**Messages:** 0" in md
        assert "### " not in md, "No message headers expected for empty thread"


def test_export_special_chars():
    """Topic and content with special Markdown chars must not corrupt output."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = _create_thread(client, "Export Special & Chars | Test # 42")
        assert r.status_code == 201
        tid = r.json()["id"]

        _sync_and_post(
            client,
            tid,
            {
                "author": "agent-x",
                "role": "user",
                "content": 'Content with | pipes | and "quotes" and `backticks`',
            },
        )

        r2 = client.get(f"/api/threads/{tid}/export")
        assert r2.status_code == 200
        md = r2.text
        assert "Export Special" in md
        assert "pipes" in md
        assert "backticks" in md
