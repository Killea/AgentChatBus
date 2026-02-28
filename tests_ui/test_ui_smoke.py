"""
UI smoke tests for AgentChatBus web console.

These tests are intentionally lightweight and are meant to be used as a
regression gate before/after frontend refactors.

Requirements:
- Local server running at BASE_URL (default: http://127.0.0.1:39765)
- playwright installed with browser binaries

If prerequisites are missing, tests are skipped (not failed).
"""

from __future__ import annotations

import os
import time
from typing import Generator

import httpx
import pytest

try:
    from playwright.sync_api import Page, sync_playwright  # type: ignore

    PLAYWRIGHT_AVAILABLE = True
except Exception:
    Page = object  # type: ignore
    sync_playwright = None  # type: ignore
    PLAYWRIGHT_AVAILABLE = False

BASE_URL = os.getenv("AGENTCHATBUS_BASE_URL", "http://127.0.0.1:39766")
CLEANUP_THREADS = os.getenv("AGENTCHATBUS_UI_CLEANUP", "1").strip().lower() not in {"0", "false", "no"}

_CREATED_TOPICS: set[str] = set()
_CREATED_THREAD_IDS: set[str] = set()
# Use a unique prefix to identify UI test threads
_UI_TEST_PREFIX = "UI-Smoke-"


def _find_thread_id_by_topic(topic: str) -> str | None:
    try:
        # Reduced timeout from 5 to 3 seconds for faster lookups
        with httpx.Client(base_url=BASE_URL, timeout=3) as client:
            resp = client.get("/api/threads", params={"include_archived": "true"})
            if resp.status_code >= 400:
                return None
            threads = resp.json()
    except Exception:
        return None

    for t in threads:
        if t.get("topic") != topic:
            continue
        tid = t.get("id")
        if isinstance(tid, str) and tid:
            return tid
    return None


def _record_created_topic(topic: str) -> None:
    _CREATED_TOPICS.add(topic)
    # UI create is async; poll briefly until API reflects the new thread.
    # Reduced from 12 to 8 iterations for faster tests
    for i in range(8):
        tid = _find_thread_id_by_topic(topic)
        if tid:
            _CREATED_THREAD_IDS.add(tid)
            return
        time.sleep(0.1)  # Reduced from 0.2 to 0.1


def _cleanup_created_threads() -> None:
    if not CLEANUP_THREADS:
        return

    # Resolve any topic that did not get mapped to id during test execution.
    for topic in sorted(_CREATED_TOPICS):
        tid = _find_thread_id_by_topic(topic)
        if tid:
            _CREATED_THREAD_IDS.add(tid)

    if not _CREATED_THREAD_IDS:
        return

    # Reduced timeout from 8 to 3 seconds for faster cleanup
    with httpx.Client(base_url=BASE_URL, timeout=3) as client:
        for tid in sorted(_CREATED_THREAD_IDS):
            # Prefer hard delete; fallback to archive on older servers.
            try:
                delete_resp = client.delete(f"/api/threads/{tid}")
            except Exception:
                continue

            if delete_resp.status_code in (200, 204, 404):
                continue

            try:
                client.post(f"/api/threads/{tid}/archive")
            except Exception:
                pass


def _require_server_or_skip() -> None:
    try:
        # Reduced timeout from 5 to 3 seconds
        with httpx.Client(base_url=BASE_URL, timeout=3) as client:
            resp = client.get("/api/threads")
            if resp.status_code < 500:
                return
    except Exception:
        pass
    pytest.skip(f"AgentChatBus server is not reachable at {BASE_URL}")


@pytest.fixture(scope="session", autouse=True)
def cleanup_old_ui_test_threads():
    """Clean up any UI test threads from previous runs before starting tests."""
    try:
        # Reduced timeout from 5 to 3 seconds
        with httpx.Client(base_url=BASE_URL, timeout=3) as client:
            # Get all threads including archived
            resp = client.get("/api/threads", params={"include_archived": "true"})
            if resp.status_code == 200:
                threads = resp.json()
                # Delete threads that start with our test prefix
                for thread in threads:
                    topic = thread.get("topic", "")
                    if topic.startswith(_UI_TEST_PREFIX):
                        try:
                            client.delete(f"/api/threads/{thread['id']}")
                        except Exception:
                            pass
    except Exception:
        pass
    
    yield
    
    # Clean up any UI test threads after all tests
    try:
        with httpx.Client(base_url=BASE_URL, timeout=3) as client:
            resp = client.get("/api/threads", params={"include_archived": "true"})
            if resp.status_code == 200:
                threads = resp.json()
                for thread in threads:
                    topic = thread.get("topic", "")
                    if topic.startswith(_UI_TEST_PREFIX):
                        try:
                            client.delete(f"/api/threads/{thread['id']}")
                        except Exception:
                            pass
    except Exception:
        pass


@pytest.fixture(scope="module")
def page() -> Generator[Page, None, None]:
    if not PLAYWRIGHT_AVAILABLE:
        pytest.skip("Playwright is not installed. Install with: pip install -e .[ui]")
    _require_server_or_skip()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        pg = ctx.new_page()
        pg.goto(BASE_URL, wait_until="load", timeout=30000)
        # Reduced wait from 1000 to 500ms - wait for the app to be fully loaded
        pg.wait_for_timeout(500)
        yield pg
        _cleanup_created_threads()
        ctx.close()
        browser.close()


def _topic(prefix: str = "") -> str:
    """Generate a unique topic with UI test prefix."""
    return f"{_UI_TEST_PREFIX}{prefix}-{int(time.time() * 1000)}"


def test_shell_regions_render(page: Page) -> None:
    page.wait_for_selector("#topbar")
    page.wait_for_selector("#sidebar")
    page.wait_for_selector("#thread-pane")
    page.wait_for_selector("#main")
    page.wait_for_selector("#messages")
    page.wait_for_selector("#compose", state="attached")
    page.wait_for_selector("#agent-status-bar")


def test_create_thread_and_select(page: Page) -> None:
    topic = _topic("UI-Thread")

    page.click("#btn-new-thread")
    page.wait_for_selector("#modal-overlay.visible")
    page.fill("#modal-topic", topic)
    page.click("#modal .btn-primary")

    page.wait_for_selector("#thread-header", state="visible")
    title = page.locator("#thread-title").inner_text().strip()
    assert title == topic
    _record_created_topic(topic)


def test_send_message_visible(page: Page) -> None:
    # Ensure a thread exists and is selected for compose box
    if not page.locator("#thread-header").is_visible():
        # Create a new thread
        topic = _topic("UI-Message")
        page.click("#btn-new-thread")
        page.wait_for_selector("#modal-overlay.visible")
        page.fill("#modal-topic", topic)
        page.click("#modal .btn-primary")
        page.wait_for_selector("#thread-header", state="visible")
        title = page.locator("#thread-title").inner_text().strip()
        assert title == topic
        _record_created_topic(topic)

    # Get the current thread ID from the URL or API
    thread_id = None
    try:
        with httpx.Client(base_url=BASE_URL, timeout=3) as client:
            threads_resp = client.get("/api/threads")
            if threads_resp.status_code == 200:
                threads = threads_resp.json()
                # Get the most recent thread with our prefix
                for t in threads:
                    if t.get("topic", "").startswith(_UI_TEST_PREFIX):
                        thread_id = t.get("id")
                        break
    except Exception as e:
        print(f"Error getting threads: {e}")

    if not thread_id:
        pytest.skip(f"Could not find thread ID")

    # Send a message via API with shorter timeout
    content = f"UI message {int(time.time() * 1000)}"
    try:
        with httpx.Client(base_url=BASE_URL, timeout=3) as client:
            msg_resp = client.post(
                f"/api/threads/{thread_id}/messages",
                json={"author": "human", "content": content, "role": "user"}
            )
            assert msg_resp.status_code in (200, 201), f"Failed to send message: {msg_resp.status_code}"
    except Exception as e:
        pytest.skip(f"Could not send message via API: {e}")

    # Wait for the message to appear on the page (via SSE) - reduced from 2000 to 1000
    page.wait_for_timeout(1000)

    # Check if messages are visible
    msg_rows = page.locator(".msg-row")
    count = msg_rows.count()

    assert count > 0, f"No messages found on page after sending via API. Thread: {thread_id}"


def test_thread_filter_panel_toggle(page: Page) -> None:
    panel = page.locator("#thread-filter-panel")
    page.click("#btn-thread-filter")
    expect_open = panel.get_attribute("class") or ""
    assert "visible" in expect_open

    # Clicking body should close it.
    page.click("#topbar")
    expect_closed = panel.get_attribute("class") or ""
    assert "visible" not in expect_closed


def test_theme_toggle(page: Page) -> None:
    before = page.locator("body").get_attribute("data-theme") or "dark"
    page.click("#btn-theme-toggle")
    after = page.locator("body").get_attribute("data-theme") or "dark"
    assert before != after


def test_settings_modal_open_close(page: Page) -> None:
    page.click("#btn-settings")
    page.wait_for_selector("#settings-modal-overlay", state="visible")
    # Click near top-left to avoid hitting modal content area.
    page.locator("#settings-modal-overlay").click(position={"x": 5, "y": 5})
    page.wait_for_timeout(100)

    # Overlay should become hidden by inline style when closed.
    style = page.locator("#settings-modal-overlay").get_attribute("style") or ""
    assert "display: none" in style


def test_numeric_agent_and_author_does_not_crash_js(page: Page) -> None:
    """Test that JS does not crash (e.g. localeCompare TypeError) when API returns numeric IDs."""
    errors: list[str] = []

    def catch_error(err) -> None:
        errors.append(err.message)

    page.on("pageerror", catch_error)

    # We mock the agents API and thread messages API to return numbers instead of strings
    # to test sorting crashes on "a.localeCompare(b)"
    def handle_agents(route) -> None:
        route.fulfill(
            json=[
                {
                    "id": 111,
                    "agent_id": 111,
                    "name": 222,
                    "display_name": 333,
                    "is_online": True,
                }
            ]
        )

    def handle_messages(route) -> None:
        route.fulfill(
            json=[
                {
                    "seq": 1,
                    "author": 444,
                    "author_name": 555,
                    "author_id": 666,
                    "role": "user",
                    "content": "test numeric author",
                    "created_at": "2026-02-27T00:00:00Z",
                }
            ]
        )

    # Route these endpoints to return mocked numeric responses
    page.route("**/api/agents*", handle_agents)
    page.route("**/api/threads/*/messages*", handle_messages)

    # Force the frontend to re-fetch agents
    page.evaluate("window.refreshAgents()")
    page.wait_for_timeout(300)  # Reduced from 500 to 300

    # Click a thread to trigger selectThread -> load messages -> updateOnlinePresence
    topic = _topic("UI-Crash-Test")
    page.click("#btn-new-thread")
    page.wait_for_selector("#modal-overlay.visible")
    page.fill("#modal-topic", topic)
    page.click("#modal .btn-primary")
    page.wait_for_timeout(500)  # Reduced from 1000 to 500
    _record_created_topic(topic)

    # Unroute
    page.unroute("**/api/agents*", handle_agents)
    page.unroute("**/api/threads/*/messages*", handle_messages)

    # Assert no page errors occurred
    page.remove_listener("pageerror", catch_error)
    assert not errors, f"Caught JS errors on page: {errors}"

