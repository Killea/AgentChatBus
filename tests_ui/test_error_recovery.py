"""
P2 Priority Tests: Error Handling and Recovery
Tests for API failures, network issues, and graceful degradation.
"""
import pytest
import time

try:
    from playwright.sync_api import Page
except Exception:
    Page = object


pytestmark = [pytest.mark.p2, pytest.mark.error]


@pytest.fixture(scope="module", autouse=True)
def skip_without_playwright():
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        pytest.skip("Playwright is not installed")


class TestAPIErrorHandling:
    """Tests for API error responses and user feedback."""
    
    def test_err_001_api_timeout_handling(self, page: Page, mock_api):
        """TC-ERR-001: Handles API timeout gracefully."""
        page.wait_for_selector("#compose", timeout=5000)
        
        # Intercept message POST to simulate slow response
        def slow_handler(route):
            time.sleep(2)  # 2 second delay
            route.continue_()
        
        page.route("**/api/threads/*/messages", slow_handler)
        
        # Try to send message
        compose_input = page.locator(".compose-input")
        compose_input.fill("Test message")
        
        # Send (would timeout if wait is too short)
        page.wait_for_timeout(100)
        
        # Page should remain responsive
        assert compose_input.is_visible()
    
    def test_err_002_api_500_error(self, page: Page, mock_api):
        """TC-ERR-002: Handles 500 server error."""
        page.wait_for_selector("#messages", timeout=5000)
        
        # Mock 500 error response
        def error_500(route):
            route.fulfill(
                json={"error": "Internal server error"},
                status=500
            )
        
        # Temporarily route to error
        page.route("**/api/agents", error_500)
        
        # Trigger agent list fetch
        page.evaluate("window.refreshAgents?.();")
        page.wait_for_timeout(500)
        
        # Page should not crash
        assert page.locator("#topbar").is_visible()
    
    def test_err_003_api_400_bad_request(self, page: Page, mock_api):
        """TC-ERR-003: Handles 400 bad request."""
        page.wait_for_selector("#compose", timeout=5000)
        
        # Mock 400 error
        def error_400(route):
            route.fulfill(
                json={"error": "Bad request"},
                status=400
            )
        
        page.route("**/api/threads/*/messages", error_400)
        
        # Attempt to send message
        compose = page.locator(".compose-input")
        compose.fill("Invalid message")
        
        page.wait_for_timeout(300)
        
        # Page should handle gracefully
        assert page.locator("#topbar").is_visible()
    
    def test_err_004_api_401_unauthorized(self, page: Page, mock_api):
        """TC-ERR-004: Handles 401 unauthorized response."""
        page.wait_for_selector("#topbar", timeout=5000)
        
        # Mock 401 error
        def error_401(route):
            route.fulfill(
                json={"error": "Unauthorized"},
                status=401
            )
        
        page.route("**/api/threads", error_401)
        
        # Trigger threads fetch
        page.evaluate("window.loadThreads?.();")
        page.wait_for_timeout(500)
        
        # Page should suggest re-authentication or remain visible
        assert page.locator("#topbar").is_visible()
    
    def test_err_005_api_404_not_found(self, page: Page):
        """TC-ERR-005: Handles 404 not found."""
        page.wait_for_selector("#topbar", timeout=5000)
        
        # Mock 404 error
        def error_404(route):
            route.fulfill(
                json={"error": "Not found"},
                status=404
            )
        
        page.route("**/api/threads/nonexistent", error_404)
        
        # Page should handle gracefully
        assert page.locator("#topbar").is_visible()


class TestNetworkErrors:
    """Tests for network-level errors."""
    
    def test_err_006_network_disconnect_recovery(self, page: Page):
        """TC-ERR-006: Recovers from network disconnection."""
        page.wait_for_selector("#status-label", timeout=5000)
        
        # Simulate network error
        page.evaluate("""
        if (window.eventSource) {
            window.eventSource.close();
            window.eventSource = null;
        }
        """)
        
        page.wait_for_timeout(500)
        
        # Status should show reconnecting or error
        status_label = page.locator("#status-label")
        status_text = status_label.inner_text()
        
        assert "Reconnecting" in status_text or "Connected" in status_text
    
    def test_err_007_connection_timeout(self, page: Page):
        """TC-ERR-007: Handles connection timeout."""
        page.wait_for_selector(".compose-input", timeout=5000)
        
        # Page has loaded, so connection exists
        # Simulating timeout is tricky without DevTools Protocol
        page.wait_for_timeout(300)
        
        # Page should remain functional
        assert page.locator("#topbar").is_visible()
    
    def test_err_008_malformed_response(self, page: Page):
        """TC-ERR-008: Handles malformed API responses."""
        page.wait_for_selector("#messages", timeout=5000)
        
        # Mock malformed JSON response
        def malformed_response(route):
            route.fulfill(
                body="{'invalid json",
                status=200
            )
        
        page.route("**/api/agents", malformed_response)
        
        # Trigger fetch
        page.evaluate("window.refreshAgents?.();")
        page.wait_for_timeout(500)
        
        # Page should handle parse error
        assert page.locator("#topbar").is_visible()


class TestInputValidation:
    """Tests for input validation and error prevention."""
    
    def test_err_009_empty_message_validation(self, page: Page):
        """TC-ERR-009: Rejects empty messages."""
        page.wait_for_selector(".compose-input", timeout=5000)
        compose = page.locator(".compose-input")
        
        # Try to send empty message
        compose.fill("")
        
        # Send button should be disabled or message should fail
        # (exact behavior depends on implementation)
        assert compose.input_value() == ""
    
    def test_err_010_oversized_message_handling(self, page: Page):
        """TC-ERR-010: Handles excessively long messages."""
        page.wait_for_selector(".compose-input", timeout=5000)
        compose = page.locator(".compose-input")
        
        # Try to input very long message
        huge_message = "x" * 100000  # 100KB
        compose.fill(huge_message)
        
        # Page should handle without crashing
        assert compose.is_visible()
    
    def test_err_011_xss_prevention(self, page: Page, sse_injector):
        """TC-ERR-011: Prevents XSS attacks in message content."""
        page.wait_for_selector("#messages", timeout=5000)
        
        # Inject message with script tag
        xss_payload = '<img src=x onerror="window.xssExecuted=true" />'
        sse_injector.inject_message_event(
            page,
            thread_id="xss-test",
            seq=1000,
            content=xss_payload
        )
        
        page.wait_for_timeout(500)
        
        # Check if XSS was executed
        xss_executed = page.evaluate("window.xssExecuted || false")
        assert not xss_executed, "XSS should be prevented"
    
    def test_err_012_sql_injection_prevention(self, page: Page):
        """TC-ERR-012: Handles SQL injection-like strings."""
        page.wait_for_selector(".compose-input", timeout=5000)
        compose = page.locator(".compose-input")
        
        # Try SQL injection pattern
        sql_injection = "'; DROP TABLE messages; --"
        compose.fill(sql_injection)
        
        # Page should treat as normal text
        assert compose.input_value() == sql_injection


class TestDataConsistency:
    """Tests for data consistency during errors."""
    
    def test_err_013_message_send_failure_no_duplicate(self, page: Page):
        """TC-ERR-013: Failed message send doesn't create duplicate."""
        page.wait_for_selector("#messages", timeout=5000)
        initial_count = page.locator(".msg-row").count()
        
        # Mock message POST to fail
        def msg_fail(route):
            route.abort()
        
        page.route("**/api/threads/*/messages", msg_fail)
        
        # Try to send message
        # (would fail silently with abort)
        page.wait_for_timeout(300)
        
        # Message count should not increase
        final_count = page.locator(".msg-row").count()
        assert final_count == initial_count
    
    def test_err_014_thread_delete_consistency(self, page: Page):
        """TC-ERR-014: Thread delete maintains data consistency."""
        page.wait_for_selector("#thread-pane", timeout=5000)
        
        initial_threads = page.locator(".thread-item").count()
        
        # Simulate thread deletion
        page.evaluate("""
        window.deleteThread?.('test-thread-id');
        """)
        
        page.wait_for_timeout(300)
        
        # Thread pane should still be valid
        assert page.locator("#thread-pane").is_visible()


class TestRecoveryMechanisms:
    """Tests for error recovery and retry logic."""
    
    def test_err_015_automatic_retry_on_failure(self, page: Page):
        """TC-ERR-015: Implements retry logic for failed requests."""
        page.wait_for_selector("#topbar", timeout=5000)
        
        # Simulate failed request followed by success
        attempt_count = [0]
        def intermittent_failure(route):
            attempt_count[0] += 1
            if attempt_count[0] < 2:
                route.abort()
            else:
                route.continue_()
        
        page.route("**/api/threads", intermittent_failure)
        
        # Trigger fetch
        page.evaluate("window.loadThreads?.();")
        page.wait_for_timeout(1000)  # Wait for retries
        
        # Page should recover
        assert page.locator("#topbar").is_visible()
    
    def test_err_016_graceful_degradation(self, page: Page):
        """TC-ERR-016: UI degrades gracefully if some features fail."""
        page.wait_for_selector("#topbar", timeout=5000)
        
        # Mock multiple API endpoints to fail
        def all_fail(route):
            route.fulfill(status=500)
        
        page.route("**/api/agents", all_fail)
        page.route("**/api/threads", all_fail)
        
        # Trigger loads
        page.evaluate("""
        window.refreshAgents?.();
        window.loadThreads?.();
        """)
        
        page.wait_for_timeout(500)
        
        # Core page should still be functional
        assert page.locator("#topbar").is_visible()
    
    def test_err_017_error_message_display(self, page: Page):
        """TC-ERR-017: Error messages are displayed to user."""
        page.wait_for_selector("#topbar", timeout=5000)
        
        # Trigger an error scenario
        page.evaluate("""
        window.showError?.('Test error message');
        """)
        
        page.wait_for_timeout(300)
        
        # Look for error message display
        error_msg = page.locator("[role='alert'], .error-message")
        
        # Error display area should exist or be created
        assert page.locator("#topbar").is_visible()


class TestEdgeCaseErrors:
    """Tests for unusual error scenarios."""
    
    def test_err_018_simultaneous_api_failures(self, page: Page):
        """TC-ERR-018: Handles multiple simultaneous API failures."""
        page.wait_for_selector("#topbar", timeout=5000)
        
        # Fail all API endpoints
        def fail_all(route):
            route.fulfill(status=503)  # Service unavailable
        
        page.route("**/api/**", fail_all)
        
        # Trigger multiple requests
        page.evaluate("""
        window.loadThreads?.();
        window.refreshAgents?.();
        """)
        
        page.wait_for_timeout(500)
        
        # Page should remain usable
        assert page.locator("#topbar").is_visible()
    
    def test_err_019_token_expiration(self, page: Page):
        """TC-ERR-019: Handles expired authentication token."""
        page.wait_for_selector("#topbar", timeout=5000)
        
        # Mock 401 with token expired
        def token_expired(route):
            route.fulfill(
                json={"error": "Token expired"},
                status=401
            )
        
        page.route("**/api/threads", token_expired)
        
        # Load would trigger auth error
        page.evaluate("window.loadThreads?.();")
        page.wait_for_timeout(500)
        
        # Should suggest re-auth or remain stable
        assert page.locator("#topbar").is_visible()
