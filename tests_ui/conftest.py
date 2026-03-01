"""
Conftest for UI tests with comprehensive fixtures for advanced testing.
"""
import os
import pytest
import json
import time
import uuid
from typing import Any, Callable, Generator

try:
    from playwright.sync_api import Page, sync_playwright, BrowserContext
    PLAYWRIGHT_AVAILABLE = True
except Exception:
    PLAYWRIGHT_AVAILABLE = False

# Use the same test port as the main conftest to connect to the test server
TEST_PORT = 39766
BASE_URL = f"http://127.0.0.1:{TEST_PORT}"

# Override the default BASE_URL for UI tests
os.environ["AGENTCHATBUS_BASE_URL"] = BASE_URL


# ===========================
# Test Data Builder Classes
# ===========================

class TestDataBuilder:
    """Generate test data for messages, threads, and agents."""
    
    @staticmethod
    def message(
        content: str = "Test message",
        role: str = "user",
        author: str = "human",
        seq: int = None
    ) -> dict:
        """Generate a test message."""
        return {
            "seq": seq or int(time.time() * 1000),
            "author": author,
            "author_name": "Test User",
            "role": role,
            "content": content,
            "created_at": "2026-03-01T03:30:00Z",
        }
    
    @staticmethod
    def thread(
        topic: str = None,
        status: str = "discuss",
        messages: int = 0
    ) -> dict:
        """Generate a test thread."""
        return {
            "id": str(uuid.uuid4()),
            "topic": topic or f"Test Thread {int(time.time() * 1000)}",
            "status": status,
            "created_at": "2026-03-01T03:30:00Z",
            "messages_count": messages,
        }
    
    @staticmethod
    def agent(
        agent_id: str = None,
        name: str = "Test Agent",
        is_online: bool = True
    ) -> dict:
        """Generate a test agent."""
        return {
            "id": agent_id or str(uuid.uuid4()),
            "name": name,
            "display_name": name,
            "is_online": is_online,
            "capabilities": ["testing"],
        }


# ===========================
# API Mock Utilities
# ===========================

class MockApiBuilder:
    """Build mock API response handlers for Playwright."""
    
    @staticmethod
    def messages_handler(messages: list[dict] = None) -> Callable:
        """Create a mock handler for GET /api/threads/{id}/messages."""
        def handler(route):
            route.fulfill(
                json=messages or [],
                status=200,
                headers={"Content-Type": "application/json"}
            )
        return handler
    
    @staticmethod
    def threads_handler(threads: list[dict] = None) -> Callable:
        """Create a mock handler for GET /api/threads."""
        def handler(route):
            route.fulfill(
                json=threads or [],
                status=200,
                headers={"Content-Type": "application/json"}
            )
        return handler
    
    @staticmethod
    def agents_handler(agents: list[dict] = None) -> Callable:
        """Create a mock handler for GET /api/agents."""
        def handler(route):
            route.fulfill(
                json=agents or [],
                status=200,
                headers={"Content-Type": "application/json"}
            )
        return handler
    
    @staticmethod
    def error_handler(status: int = 500, message: str = "Server error") -> Callable:
        """Create a mock error response handler."""
        def handler(route):
            route.fulfill(
                json={"error": message},
                status=status,
                headers={"Content-Type": "application/json"}
            )
        return handler


# ===========================
# SSE Event Simulation
# ===========================

class SSEEventInjector:
    """Inject fake SSE events into the page."""
    
    @staticmethod
    def inject_message_event(
        page: Page,
        thread_id: str,
        seq: int = 100,
        author: str = "test-agent",
        content: str = "Test SSE message"
    ) -> None:
        """Inject a msg.new event."""
        event_data = {
            "type": "msg.new",
            "payload": {
                "thread_id": thread_id,
                "seq": seq,
                "author": author,
                "content": content,
            }
        }
        script = f"""
        const evt = new MessageEvent('message', {{
            data: JSON.stringify({json.dumps(event_data)})
        }});
        window.eventSource?.dispatchEvent(evt);
        """
        page.evaluate(script)
    
    @staticmethod
    def inject_agent_presence_event(
        page: Page,
        agent_id: str,
        status: str = "online"
    ) -> None:
        """Inject an agent.presence event."""
        event_data = {
            "type": "agent.presence",
            "payload": {
                "agent_id": agent_id,
                "is_online": status == "online"
            }
        }
        script = f"""
        const evt = new MessageEvent('message', {{
            data: JSON.stringify({json.dumps(event_data)})
        }});
        window.eventSource?.dispatchEvent(evt);
        """
        page.evaluate(script)
    
    @staticmethod
    def inject_thread_event(
        page: Page,
        event_type: str,
        thread_id: str,
        status: str = None
    ) -> None:
        """Inject thread state change events."""
        payload = {"thread_id": thread_id}
        if status:
            payload["status"] = status
        
        event_data = {
            "type": f"thread.{event_type}",
            "payload": payload
        }
        script = f"""
        const evt = new MessageEvent('message', {{
            data: JSON.stringify({json.dumps(event_data)})
        }});
        window.eventSource?.dispatchEvent(evt);
        """
        page.evaluate(script)


# ===========================
# Pytest Fixtures
# ===========================

@pytest.fixture
def test_data() -> TestDataBuilder:
    """Provide test data builder."""
    return TestDataBuilder()


@pytest.fixture
def mock_api() -> MockApiBuilder:
    """Provide mock API builder."""
    return MockApiBuilder()


@pytest.fixture
def sse_injector() -> SSEEventInjector:
    """Provide SSE event injector."""
    return SSEEventInjector()


@pytest.fixture
def page_with_sse_mock(page: Page, mock_api: MockApiBuilder) -> Generator[Page, None, None]:
    """Page fixture with automatic API and SSE mocking."""
    if not PLAYWRIGHT_AVAILABLE:
        pytest.skip("Playwright not available")
    
    # Setup mock handlers
    page.route("**/api/threads", mock_api.threads_handler())
    page.route("**/api/agents", mock_api.agents_handler())
    page.route("**/api/threads/*/messages*", mock_api.messages_handler())
    
    yield page


# Marker definitions for test categorization
def pytest_configure(config):
    """Register custom markers."""
    config.addinivalue_line("markers", "p0: P0 priority tests (critical)")
    config.addinivalue_line("markers", "p1: P1 priority tests (high)")
    config.addinivalue_line("markers", "p2: P2 priority tests (medium)")
    config.addinivalue_line("markers", "p3: P3 priority tests (low)")
    config.addinivalue_line("markers", "sse: SSE connection tests")
    config.addinivalue_line("markers", "sync: Message synchronization tests")
    config.addinivalue_line("markers", "component: Web component tests")
    config.addinivalue_line("markers", "agent: Agent status tests")
    config.addinivalue_line("markers", "concurrent: Concurrent agent tests")
    config.addinivalue_line("markers", "slow: Slow/performance tests")
