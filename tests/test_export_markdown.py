"""
Tests for the thread Markdown export endpoint (UI-03).

GET /api/threads/{thread_id}/export
"""
import os
import httpx
import pytest

BASE_URL = os.getenv("AGENTCHATBUS_BASE_URL", "http://127.0.0.1:39766")


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


@pytest.fixture(scope="module")
def export_thread_id() -> str:
    """Thread with 3 messages for export tests."""
    with _build_client() as client:
        _require_server_or_skip(client)
        r = client.post("/api/threads", json={"topic": "Export-Test-UI03"})
        assert r.status_code == 201, r.text
        tid = r.json()["id"]

        for i in range(1, 4):
            r2 = client.post(
                f"/api/threads/{tid}/messages",
                json={"author": f"agent-{i}", "role": "user", "content": f"Message {i} content"},
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
        r = client.post("/api/threads", json={"topic": "Export-Empty-UI03"})
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
        r = client.post(
            "/api/threads", json={"topic": "Export Special & Chars | Test # 42"}
        )
        assert r.status_code == 201
        tid = r.json()["id"]

        client.post(
            f"/api/threads/{tid}/messages",
            json={
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
