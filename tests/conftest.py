"""
Conftest for starting/stopping AgentChatBus server during tests.

This fixture ensures the server is running for e2e and UI tests.
Uses a separate port and database to avoid conflicts with production server.
"""
import os
import signal
import sys
import time
import subprocess
from pathlib import Path
import httpx
import pytest

# Use a dedicated test port separate from the production port (39766) to avoid conflicts.
# See UP-20 / Integration Testing — Port Conflict Resolution in agentchatbus-upstream-improvements.md
TEST_PORT = 39769
BASE_URL = f"http://127.0.0.1:{TEST_PORT}"
# Use a separate test database
TEST_DB_PATH = os.path.join(os.path.dirname(__file__), "data", "bus_test.db")
_SERVER_PROCESS = None

# Hard guardrails: tests must never accidentally use a production DB.
# Set defaults early so modules that read config at import time see test values.
os.environ.setdefault("AGENTCHATBUS_PORT", str(TEST_PORT))
os.environ.setdefault("AGENTCHATBUS_TEST_BASE_URL", BASE_URL)
os.environ.setdefault("AGENTCHATBUS_DB", TEST_DB_PATH)

# Script-style checks that are intended to run manually against a dedicated server
# should not be collected by pytest's normal test discovery.
collect_ignore = ["test_image_paste.py", "test_token_exposure.py"]


@pytest.fixture(scope="session", autouse=True)
def enforce_test_database() -> None:
    """Fail fast if a test run is configured to use a non-test database.

    This protects developers from accidentally pointing tests at a production/dev DB
    (e.g. repo data/bus.db or ~/.agentchatbus/bus.db).
    """
    db = os.getenv("AGENTCHATBUS_DB")
    if not db:
        raise RuntimeError(
            "AGENTCHATBUS_DB must be set during tests to a test database path (or ':memory:')."
        )

    if db == ":memory:":
        return

    repo_root = Path(__file__).resolve().parents[1]
    prod_repo_db = (repo_root / "data" / "bus.db").resolve()
    prod_home_db = (Path.home() / ".agentchatbus" / "bus.db").resolve()

    try:
        resolved = Path(db).expanduser().resolve()
    except Exception:
        # If resolution fails, treat as unsafe.
        raise RuntimeError(f"Invalid AGENTCHATBUS_DB path for tests: {db!r}")

    if resolved == prod_repo_db or resolved == prod_home_db:
        raise RuntimeError(
            f"Refusing to run tests against a production DB: AGENTCHATBUS_DB={str(resolved)!r}"
        )

    resolved_str = str(resolved).replace("\\", "/").lower()
    base = resolved.name.lower()

    # Require a clearly test-scoped DB file name/path.
    # Current test suite uses e.g. bus_test.db, data/test_*.db, tests/data/*.db
    if "test" not in base and "/tests/" not in resolved_str and "/test" not in resolved_str:
        raise RuntimeError(
            "AGENTCHATBUS_DB must point to a test database (name/path should include 'test') "
            f"or ':memory:'. Got: {str(resolved)!r}"
        )


@pytest.fixture(scope="session", autouse=True)
def server():
    """Start the AgentChatBus server for the test session with test-specific config."""
    global _SERVER_PROCESS
    
    # Set environment variables for test server
    test_env = os.environ.copy()
    test_env["AGENTCHATBUS_PORT"] = str(TEST_PORT)
    test_env["AGENTCHATBUS_DB"] = TEST_DB_PATH
    test_env["AGENTCHATBUS_RELOAD"] = "0"  # Disable reload for tests
    
    # Check if a compatible test server is already running on the test port.
    # Verify /health + all new endpoints from UP-13+16, UP-20, UP-22, UP-14:
    # - /api/metrics (UP-22): must return 200
    # - /api/threads?limit=1 (UP-20 pagination): must return dict with "threads" key
    # - /api/messages/nonexistent/reactions (UP-13+16): must return 404 with "Message" in detail
    #   (an old server without reactions route returns 404 "Not Found" — FastAPI generic default)
    # - GET /api/threads/{id}/messages (UP-14): response items must have "reply_to_msg_id" key
    #   We create a temp thread and check the field is present in the messages response.
    try:
        with httpx.Client(base_url=BASE_URL, timeout=5) as client:
            health = client.get("/health")
            metrics_resp = client.get("/api/metrics")
            threads_resp = client.get("/api/threads", params={"limit": 1})
            react_check = client.post(
                "/api/messages/nonexistent/reactions",
                json={"agent_id": "test", "reaction": "test"},
            )
            react_detail = react_check.json().get("detail", "") if react_check.status_code == 404 else ""
            # UP-14: create a temp thread and check reply_to_msg_id field in messages response
            reply_field_ok = False
            thread_resp = client.post("/api/threads", json={"topic": "__compat_check__", "status": "discuss"})
            if thread_resp.status_code in (200, 201):
                tid = thread_resp.json().get("id", "")
                if tid:
                    msgs_resp = client.get(f"/api/threads/{tid}/messages")
                    if msgs_resp.status_code == 200:
                        msgs_data = msgs_resp.json()
                        # Empty list is OK — field present means server supports UP-14
                        # We check by posting a message and reading back
                        msg_resp = client.post(
                            f"/api/threads/{tid}/messages",
                            json={"author": "compat-check", "content": "ping", "role": "user"},
                        )
                        if msg_resp.status_code in (200, 201):
                            reply_field_ok = "reply_to_msg_id" in msg_resp.json()
            if (
                health.status_code == 200
                and metrics_resp.status_code == 200
                and threads_resp.status_code == 200
                and isinstance(threads_resp.json(), dict)
                and "threads" in threads_resp.json()
                and react_check.status_code == 404
                and "Message" in str(react_detail)
                and reply_field_ok
            ):
                yield
                return
    except Exception:
        pass

    # Start the server with test configuration
    print(f"\nStarting AgentChatBus test server at {BASE_URL}...")
    print(f"Using test database: {TEST_DB_PATH}")
    _SERVER_PROCESS = subprocess.Popen(
        [sys.executable, "-m", "src.main"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=test_env
    )
    
    # Wait for server to be ready
    max_retries = 30
    for i in range(max_retries):
        try:
            time.sleep(0.5)
            with httpx.Client(base_url=BASE_URL, timeout=5) as client:
                resp = client.get("/api/threads")
                if resp.status_code < 500:
                    print(f"Test server started successfully (attempt {i+1})")
                    yield
                    return
        except Exception:
            if i == max_retries - 1:
                raise Exception(f"Server failed to start after {max_retries} attempts")
            continue
    
    yield
    
    # Cleanup: stop the server gracefully
    if _SERVER_PROCESS:
        print("Stopping test server...")
        try:
            # First try graceful shutdown with Ctrl+C
            if os.name == 'nt':  # Windows
                _SERVER_PROCESS.send_signal(signal.CTRL_C_EVENT)
            else:
                _SERVER_PROCESS.send_signal(signal.SIGTERM)
            
            # Wait up to 3 seconds for graceful shutdown
            _SERVER_PROCESS.wait(timeout=3)
        except (subprocess.TimeoutExpired, AttributeError, OSError):
            # If graceful shutdown fails, force kill
            try:
                _SERVER_PROCESS.terminate()
                _SERVER_PROCESS.wait(timeout=2)
            except subprocess.TimeoutExpired:
                _SERVER_PROCESS.kill()
                _SERVER_PROCESS.wait()
        print("Test server stopped")
    
    # Optionally clean up test database
    if os.path.exists(TEST_DB_PATH):
        try:
            os.remove(TEST_DB_PATH)
            print(f"Cleaned up test database: {TEST_DB_PATH}")
        except Exception as e:
            print(f"Warning: Could not remove test database: {e}")
