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
import ast
from pathlib import Path
import httpx
import pytest

# Use a dedicated test port separate from the production port (39765) to avoid conflicts.
# See UP-20 / Integration Testing — Port Conflict Resolution in agentchatbus-upstream-improvements.md
TEST_PORT = 39769
BASE_URL = f"http://127.0.0.1:{TEST_PORT}"
# Use a separate test database
TEST_DB_PATH = os.path.join(os.path.dirname(__file__), "data", "bus_test.db")
_SERVER_PROCESS = None

if TEST_PORT == 39765:
    raise RuntimeError("TEST_PORT must never be the production port 39765.")

# Hard guardrails: tests must never accidentally use a production DB.
# Set defaults early so modules that read config at import time see test values.
# Set test port explicitly for this pytest process so imports never see production port.
os.environ["AGENTCHATBUS_PORT"] = str(TEST_PORT)
os.environ.setdefault("AGENTCHATBUS_TEST_BASE_URL", BASE_URL)
os.environ.setdefault("AGENTCHATBUS_DB", TEST_DB_PATH)


def _enforce_no_popen_pipe_in_conftest() -> None:
    """Hard guardrail: never use subprocess.PIPE for the test server.

    Why:
    - If the server is started with stdout/stderr=PIPE and the test runner does
      not continuously drain those pipes, the child process can block once the
      OS pipe buffer fills.
    - That manifests as intermittent hangs (pytest appears stuck) or
      httpx.ReadTimeouts when tests send HTTP requests to the server.

    This check intentionally fails fast if someone reintroduces PIPE in this
    fixture.
    """

    try:
        source = Path(__file__).read_text(encoding="utf-8")
    except Exception:
        return

    try:
        tree = ast.parse(source)
    except SyntaxError:
        return

    def _is_subprocess_pipe(node: ast.AST) -> bool:
        # Matches: subprocess.PIPE
        return (
            isinstance(node, ast.Attribute)
            and isinstance(node.value, ast.Name)
            and node.value.id == "subprocess"
            and node.attr == "PIPE"
        )

    for n in ast.walk(tree):
        if not isinstance(n, ast.Call):
            continue

        # Match subprocess.Popen(...)
        is_popen = (
            isinstance(n.func, ast.Attribute)
            and isinstance(n.func.value, ast.Name)
            and n.func.value.id == "subprocess"
            and n.func.attr == "Popen"
        )
        if not is_popen:
            continue

        for kw in n.keywords:
            if kw.arg in {"stdout", "stderr"} and kw.value is not None and _is_subprocess_pipe(kw.value):
                raise RuntimeError(
                    "tests/conftest.py must not start the test server with subprocess.PIPE "
                    "(stdout/stderr). This can deadlock and cause intermittent pytest hangs."
                )


_enforce_no_popen_pipe_in_conftest()

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
    started_here = False
    server_ready = False
    
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
            reg_resp = client.post(
                "/api/agents/register",
                json={"ide": "VS Code", "model": "GPT-5.3-Codex"},
            )
            if reg_resp.status_code == 200:
                agent = reg_resp.json()
                thread_resp = client.post(
                    "/api/threads",
                    json={
                        "topic": "__compat_check__",
                        "status": "discuss",
                        "creator_agent_id": agent["agent_id"],
                    },
                    headers={"X-Agent-Token": agent["token"]},
                )
            else:
                thread_resp = None
            if thread_resp is not None and thread_resp.status_code in (200, 201):
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
            # Cleanup compat-check thread to avoid polluting shared server DB.
            if thread_resp is not None and thread_resp.status_code in (200, 201):
                compat_tid = thread_resp.json().get("id", "")
                if compat_tid:
                    try:
                        client.delete(f"/api/threads/{compat_tid}")
                    except Exception:
                        pass
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
                server_ready = True
    except Exception:
        pass

    if not server_ready:
        # Start the server with test configuration
        print(f"\nStarting AgentChatBus test server at {BASE_URL}...")
        print(f"Using test database: {TEST_DB_PATH}")

        # IMPORTANT: do NOT set stdout/stderr to subprocess.PIPE here.
        # Pytest does not drain those pipes continuously, and once the pipe
        # buffer fills the server can block (deadlock), leading to flaky
        # httpx.ReadTimeout errors and the appearance that pytest has "hung".
        _SERVER_PROCESS = subprocess.Popen(
            [sys.executable, "-m", "src.main"],
            env=test_env
        )
        started_here = True

        # Wait for server to be ready
        max_retries = 30
        for i in range(max_retries):
            try:
                time.sleep(0.5)
                with httpx.Client(base_url=BASE_URL, timeout=5) as client:
                    resp = client.get("/api/threads")
                    if resp.status_code < 500:
                        print(f"Test server started successfully (attempt {i+1})")
                        server_ready = True
                        break
            except Exception:
                if i == max_retries - 1:
                    raise Exception(f"Server failed to start after {max_retries} attempts")
                continue

    if not server_ready:
        raise RuntimeError(f"Test server is not ready at {BASE_URL}")
    
    try:
        yield
    finally:
        # Cleanup only for process started by this fixture.
        if started_here and _SERVER_PROCESS:
            print("Stopping test server...")
            try:
                # On Windows, CTRL_C_EVENT can interrupt the pytest parent process.
                # Use terminate() for reliable child-only shutdown.
                if os.name == 'nt':
                    _SERVER_PROCESS.terminate()
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
            _SERVER_PROCESS = None

        # Optionally clean up test database created by this fixture run.
        if started_here and os.path.exists(TEST_DB_PATH):
            try:
                os.remove(TEST_DB_PATH)
                print(f"Cleaned up test database: {TEST_DB_PATH}")
            except Exception as e:
                print(f"Warning: Could not remove test database: {e}")

        # Clean up all other accumulated test DB files in tests/data/.
        # Only when this fixture started the server — avoids interfering with
        # an externally managed server whose DB files may still be open.
        if started_here:
            tests_data_dir = Path(TEST_DB_PATH).parent
            for db_file in tests_data_dir.glob("*.db*"):
                if db_file.resolve() == Path(TEST_DB_PATH).resolve():
                    continue  # already handled above
                try:
                    db_file.unlink()
                except Exception:
                    pass


@pytest.fixture(scope="session")
def thread_registry():
    """Optional registry for tracking test threads to delete on session end.

    Use this fixture in integration tests that create threads against an
    externally managed server (i.e. when the server is NOT started by
    conftest).  When conftest starts the server itself, the entire
    ``bus_test.db`` is removed on teardown, so explicit cleanup is
    unnecessary.

    Usage::

        def test_foo(thread_registry):
            tid = create_thread(...)
            thread_registry.register(tid)
            # thread is deleted automatically at end of session
    """
    _ids: list[str] = []

    class _Registry:
        def register(self, thread_id: str) -> None:
            _ids.append(thread_id)

    reg = _Registry()
    yield reg

    if not _ids:
        return
    with httpx.Client(base_url=BASE_URL, timeout=5) as client:
        for tid in _ids:
            try:
                client.delete(f"/api/threads/{tid}")
            except Exception:
                pass

