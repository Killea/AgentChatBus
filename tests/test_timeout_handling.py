"""
Unit tests for timeout handling in AgentChatBus main.py endpoints.

These tests verify that database operations timeout gracefully and return
appropriate HTTP status codes (503 Service Unavailable).
"""

import asyncio
import pytest
import warnings
from unittest.mock import AsyncMock, patch, MagicMock
from fastapi import HTTPException
from fastapi.testclient import TestClient

from src.main import (
    app,
    DB_TIMEOUT,
    api_threads,
    api_agents,
    api_messages,
    api_create_thread,
)
from src.db.models import Thread, Message, AgentInfo


# ─────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────

@pytest.fixture
def client():
    """FastAPI TestClient for API endpoint testing."""
    return TestClient(app)


# Suppress RuntimeWarnings from mocking async functions
@pytest.fixture(autouse=True, scope="session")
def suppress_runtime_warnings():
    """Suppress RuntimeWarnings caused by mocking async functions."""
    import warnings
    import sys
    
    # Suppress both RuntimeWarning and PytestUnraisableExceptionWarning
    warnings.filterwarnings("ignore", category=RuntimeWarning)
    
    # Also suppress pytest's unraisable exception warnings
    class WarningInterceptor:
        def __init__(self):
            self.original_showwarning = warnings.showwarning
            
        def custom_showwarning(self, message, category, filename, lineno, file=None, line=None):
            # Ignore RuntimeWarnings
            if category == RuntimeWarning:
                return
            # Ignore pytest unraisable warnings
            if "PytestUnraisableExceptionWarning" in str(type(category)):
                return
            self.original_showwarning(message, category, filename, lineno, file, line)
    
    interceptor = WarningInterceptor()
    warnings.showwarning = interceptor.custom_showwarning
    
    yield
    
    # Restore original
    warnings.showwarning = interceptor.original_showwarning


# ─────────────────────────────────────────────
# Test timeout behavior
# ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_api_threads_timeout_on_get_db():
    """Test that API returns 503 when get_db() times out."""
    with patch("asyncio.wait_for") as mock_wait_for:
        # First call to wait_for (get_db) times out
        mock_wait_for.side_effect = asyncio.TimeoutError()
        
        try:
            await api_threads()
            pytest.fail("Expected HTTPException with 503")
        except HTTPException as e:
            assert e.status_code == 503
            assert "Database operation timeout" in e.detail


@pytest.mark.asyncio
async def test_api_threads_timeout_on_thread_list():
    """Test that API returns 503 when thread_list() times out."""
    mock_db = AsyncMock()

    async def mock_wait_for_impl(coro, timeout):
        # First call (get_db) returns mock_db
        if "get_db" in str(coro):
            return mock_db
        # Second call (thread_list) times out
        else:
            raise asyncio.TimeoutError()

    with patch("asyncio.wait_for", side_effect=mock_wait_for_impl):
        try:
            await api_threads()
            pytest.fail("Expected HTTPException with 503")
        except HTTPException as e:
            assert e.status_code == 503
            assert "Database operation timeout" in e.detail


@pytest.mark.asyncio
async def test_api_agents_timeout():
    """Test that /api/agents returns 503 on timeout."""
    async def mock_wait_for_impl(coro, timeout):
        raise asyncio.TimeoutError()

    with patch("asyncio.wait_for", side_effect=mock_wait_for_impl):
        try:
            await api_agents()
            pytest.fail("Expected HTTPException with 503")
        except HTTPException as e:
            assert e.status_code == 503
            assert "Database operation timeout" in e.detail


# ─────────────────────────────────────────────
# Test successful operations (no timeout)
# ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_api_threads_success():
    """Test successful thread listing with no timeout."""
    mock_db = AsyncMock()
    import datetime
    now = datetime.datetime.now()

    mock_threads = [
        Thread(
            id="thread-1",
            topic="Test Thread",
            status="discuss",
            created_at=now,
            closed_at=None,
            summary=None,
            metadata=None,
        )
    ]

    call_count = [0]

    async def mock_wait_for_impl(coro, timeout):
        call_count[0] += 1
        # First call (get_db) returns mock_db
        if call_count[0] == 1:
            return mock_db
        # Second call (thread_list) returns mock_threads
        else:
            return mock_threads

    with patch("asyncio.wait_for", side_effect=mock_wait_for_impl):
        # Since api_threads is an async function that returns a list,
        # we need to test the actual return value
        result = await api_threads()

        # Verify result is a list with expected structure
        assert isinstance(result, list)
        if result:
            assert "id" in result[0]
            assert "topic" in result[0]
            assert "status" in result[0]


@pytest.mark.asyncio
async def test_api_agents_success():
    """Test successful agent listing with no timeout."""
    mock_db = AsyncMock()
    import datetime
    now = datetime.datetime.now()

    mock_agents = [
        AgentInfo(
            id="agent-1",
            name="Test Agent",
            ide="VSCode",
            model="test-model",
            description="Test",
            capabilities=None,
            registered_at=now,
            last_heartbeat=now,
            is_online=True,
            token="test-token",
        )
    ]

    async def mock_wait_for_impl(coro, timeout):
        # Return mock_agents for agent_list calls
        return mock_agents

    with patch("asyncio.wait_for", side_effect=mock_wait_for_impl):
        result = await api_agents()

        assert isinstance(result, list)
        if result:
            assert "id" in result[0]
            assert "name" in result[0]
            assert "is_online" in result[0]


# ─────────────────────────────────────────────
# Test timeout constant
# ─────────────────────────────────────────────

def test_db_timeout_constant():
    """Verify DB_TIMEOUT constant is set to expected value."""
    assert DB_TIMEOUT == 5, f"Expected DB_TIMEOUT=5, got {DB_TIMEOUT}"


# ─────────────────────────────────────────────
# Integration tests with TestClient (if server running)
# ─────────────────────────────────────────────

def test_api_threads_http_endpoint(client: TestClient):
    """Integration test: GET /api/threads returns 200 or 503 depending on DB."""
    # This will only work if the AgentChatBus server is running
    response = client.get("/api/threads")

    # Accept either 200 (success) or 503 (timeout) — depends on server state
    assert response.status_code in [200, 503], f"Unexpected status: {response.status_code}"

    if response.status_code == 200:
        assert isinstance(response.json(), list)
    else:
        assert "timeout" in response.json().get("detail", "").lower()


def test_api_agents_http_endpoint(client: TestClient):
    """Integration test: GET /api/agents returns 200 or 503 depending on DB."""
    response = client.get("/api/agents")

    assert response.status_code in [200, 503], f"Unexpected status: {response.status_code}"

    if response.status_code == 200:
        assert isinstance(response.json(), list)
    else:
        assert "timeout" in response.json().get("detail", "").lower()
