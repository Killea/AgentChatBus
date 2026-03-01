"""
Conftest for starting/stopping AgentChatBus server during tests.

This fixture ensures the server is running for e2e and UI tests.
Uses a separate port and database to avoid conflicts with production server.
"""
import os
import signal
import time
import subprocess
import httpx
import pytest

# Use a different port for testing (39766) to avoid conflicts with production (39765)
TEST_PORT = 39766
BASE_URL = f"http://127.0.0.1:{TEST_PORT}"
# Use a separate test database
TEST_DB_PATH = os.path.join(os.path.dirname(__file__), "data", "bus_test.db")
_SERVER_PROCESS = None

# Script-style checks that are intended to run manually against a dedicated server
# should not be collected by pytest's normal test discovery.
collect_ignore = ["test_image_paste.py", "test_token_exposure.py"]


@pytest.fixture(scope="session", autouse=True)
def server():
    """Start the AgentChatBus server for the test session with test-specific config."""
    global _SERVER_PROCESS
    
    # Set environment variables for test server
    test_env = os.environ.copy()
    test_env["AGENTCHATBUS_PORT"] = str(TEST_PORT)
    test_env["AGENTCHATBUS_DB"] = TEST_DB_PATH
    test_env["AGENTCHATBUS_RELOAD"] = "0"  # Disable reload for tests
    
    # Check if test server is already running on test port
    try:
        with httpx.Client(base_url=BASE_URL, timeout=5) as client:
            resp = client.get("/api/threads")
            if resp.status_code < 500:
                yield
                return
    except Exception:
        pass
    
    # Start the server with test configuration
    print(f"\nStarting AgentChatBus test server at {BASE_URL}...")
    print(f"Using test database: {TEST_DB_PATH}")
    _SERVER_PROCESS = subprocess.Popen(
        ["python", "-m", "src.main"],
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
