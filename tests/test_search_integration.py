"""
Integration tests for UI-02: GET /api/search endpoint.

These tests require a running AgentChatBus server on the dedicated test port.
See tests/_constants.py for the default test port.

Run with:
    $env:AGENTCHATBUS_PORT = "<TEST_PORT>"
    $env:AGENTCHATBUS_DB = "tests/data/bus_test_search.db"
    $env:AGENTCHATBUS_RELOAD = "0"
    .venv\\Scripts\\python.exe -m agentchatbus.main

Then in another terminal:
    .venv\\Scripts\\python -m pytest tests/test_search_integration.py -v
"""
import httpx
import pytest

from tests._constants import TEST_BASE_URL as BASE_URL


# ─────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────

def _build_client() -> httpx.Client:
    return httpx.Client(base_url=BASE_URL, timeout=10)


def _require_server_or_skip(client: httpx.Client) -> None:
    try:
        resp = client.get("/health")
        if resp.status_code == 200:
            return
    except Exception:
        pass
    pytest.skip(f"AgentChatBus server not reachable at {BASE_URL}")


def _create_thread_and_post(client: httpx.Client, topic: str, content: str) -> dict:
    """Register an agent, create a thread, post a message. Returns {thread_id, message_id}."""
    reg = client.post("/api/agents/register", json={"ide": "Test", "model": "test-model"})
    assert reg.status_code == 200, reg.text
    agent = reg.json()

    thread_resp = client.post(
        "/api/threads",
        json={"topic": topic, "creator_agent_id": agent["agent_id"]},
        headers={"X-Agent-Token": agent["token"]},
    )
    assert thread_resp.status_code in (200, 201), thread_resp.text
    thread_id = thread_resp.json()["id"]

    msg_resp = client.post(
        f"/api/threads/{thread_id}/messages",
        json={"content": content, "author": agent["agent_id"], "author_name": "Test Agent"},
        headers={"X-Agent-Token": agent["token"]},
    )
    assert msg_resp.status_code in (200, 201), msg_resp.text
    message_id = msg_resp.json()["id"]

    return {"thread_id": thread_id, "message_id": message_id, "agent": agent}


# ─────────────────────────────────────────────
# Integration tests
# ─────────────────────────────────────────────

def test_search_endpoint_basic():
    """GET /api/search?q=... must return 200 with results/total/query envelope."""
    client = _build_client()
    _require_server_or_skip(client)

    unique_word = "xkzqvflargematch"
    data = _create_thread_and_post(client, f"search-basic-{unique_word}", f"integration test {unique_word} content")

    resp = client.get(f"/api/search?q={unique_word}")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "results" in body
    assert "total" in body
    assert "query" in body
    assert body["query"] == unique_word
    assert body["total"] >= 1

    thread_ids = [r["thread_id"] for r in body["results"]]
    assert data["thread_id"] in thread_ids


def test_search_endpoint_thread_scoped():
    """GET /api/search?q=...&thread_id=... must restrict results to that thread."""
    client = _build_client()
    _require_server_or_skip(client)

    unique_word = "xkzqvfthreadscope"
    data1 = _create_thread_and_post(client, f"scope-thread-1-{unique_word}", f"message one {unique_word}")
    data2 = _create_thread_and_post(client, f"scope-thread-2-{unique_word}", f"message two {unique_word}")

    resp = client.get(f"/api/search?q={unique_word}&thread_id={data1['thread_id']}")
    assert resp.status_code == 200, resp.text
    body = resp.json()

    thread_ids = {r["thread_id"] for r in body["results"]}
    assert data1["thread_id"] in thread_ids
    assert data2["thread_id"] not in thread_ids


def test_search_endpoint_missing_query():
    """GET /api/search without q= must return 400."""
    client = _build_client()
    _require_server_or_skip(client)

    resp = client.get("/api/search")
    assert resp.status_code == 422, f"Expected 422 (FastAPI validation), got {resp.status_code}"


def test_search_endpoint_empty_query():
    """GET /api/search?q= (empty string) must return 400."""
    client = _build_client()
    _require_server_or_skip(client)

    resp = client.get("/api/search?q=")
    assert resp.status_code == 400, f"Expected 400 for empty q, got {resp.status_code}"


def test_search_endpoint_no_results():
    """GET /api/search?q=<nonexistent> must return 200 with empty results array."""
    client = _build_client()
    _require_server_or_skip(client)

    resp = client.get("/api/search?q=zxqvbnmunlikelyterm99999")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["results"] == []
    assert body["total"] == 0


def test_search_endpoint_result_fields():
    """Each result must contain message_id, thread_id, thread_topic, author, seq, created_at, snippet."""
    client = _build_client()
    _require_server_or_skip(client)

    unique_word = "xkzqvfresultfields"
    _create_thread_and_post(client, f"fields-thread-{unique_word}", f"content {unique_word} check")

    resp = client.get(f"/api/search?q={unique_word}")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] >= 1

    r = body["results"][0]
    for field in ("message_id", "thread_id", "thread_topic", "author", "seq", "created_at", "snippet"):
        assert field in r, f"Missing field in result: {field}"


def test_search_endpoint_limit():
    """GET /api/search?limit=2 must return at most 2 results."""
    client = _build_client()
    _require_server_or_skip(client)

    unique_word = "xkzqvflimitword"
    agent_data = None
    for i in range(5):
        data = _create_thread_and_post(
            client, f"limit-thread-{i}-{unique_word}", f"message {unique_word} iteration {i}"
        )
        if agent_data is None:
            agent_data = data

    resp = client.get(f"/api/search?q={unique_word}&limit=2")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["results"]) <= 2
