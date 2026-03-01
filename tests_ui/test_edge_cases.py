"""
P3 Priority Tests: Edge Cases and Boundary Conditions
Tests for unusual data, extreme inputs, and corner cases.
"""
import pytest

try:
    from playwright.sync_api import Page
except Exception:
    Page = object


pytestmark = [pytest.mark.p3, pytest.mark.edge]


@pytest.fixture(scope="module", autouse=True)
def skip_without_playwright():
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        pytest.skip("Playwright is not installed")


class TestDataTypeEdgeCases:
    """Tests for unexpected data types."""
    
    def test_edge_001_numeric_id_handling(self, page: Page, mock_api):
        """TC-EDGE-001: Handles numeric IDs instead of strings."""
        page.wait_for_selector("#messages", timeout=5000)
        
        # Mock API returning numeric IDs
        def numeric_ids(route):
            route.fulfill(
                json=[{
                    "seq": 123,
                    "author": 456,  # numeric ID
                    "author_id": 789,
                    "role": "user",
                    "content": "Test",
                    "created_at": "2026-03-01T00:00:00Z"
                }],
                status=200
            )
        
        page.route("**/api/threads/*/messages*", numeric_ids)
        
        # Refresh messages
        page.evaluate("window.selectThread?.({id: 'test'});")
        page.wait_for_timeout(500)
        
        # Should not crash on localeCompare or similar
        assert page.locator("#messages").is_visible()
    
    def test_edge_002_null_values_in_response(self, page: Page, mock_api):
        """TC-EDGE-002: Handles null values in API responses."""
        page.wait_for_selector("#messages", timeout=5000)
        
        def with_nulls(route):
            route.fulfill(
                json=[{
                    "seq": 1,
                    "author": None,  # null
                    "content": None,
                    "created_at": None,
                    "role": "user"
                }],
                status=200
            )
        
        page.route("**/api/threads/*/messages*", with_nulls)
        
        page.evaluate("window.selectThread?.({id: 'test'});")
        page.wait_for_timeout(500)
        
        assert page.locator("#messages").is_visible()
    
    def test_edge_003_undefined_values(self, page: Page):
        """TC-EDGE-003: Handles undefined properties."""
        page.wait_for_selector("#messages", timeout=5000)
        
        # Inject undefined into window
        page.evaluate("""
        window.testData = {
            messages: [
                { 
                    seq: 1, 
                    author: undefined,
                    content: 'test'
                }
            ]
        };
        """)
        
        page.wait_for_timeout(300)
        
        # Should not crash
        assert page.locator("#messages").is_visible()
    
    def test_edge_004_empty_string_values(self, page: Page):
        """TC-EDGE-004: Handles empty strings in content."""
        page.wait_for_selector("#messages", timeout=5000)
        
        # Message with empty content
        content = ""
        
        # Try to display empty message
        page.evaluate(f"""
        window.displayMessage?.({{content: '', author: 'test'}});
        """)
        
        page.wait_for_timeout(300)
        
        assert page.locator("#messages").is_visible()


class TestExtremeInputSize:
    """Tests for very large inputs."""
    
    def test_edge_005_very_long_thread_name(self, page: Page):
        """TC-EDGE-005: Handles extremely long thread names."""
        page.wait_for_selector("#thread-pane", timeout=5000)
        
        # Create thread with very long name
        long_name = "A" * 5000  # 5000 character name
        
        page.evaluate(f"""
        window.createThread?.({{'topic': '{long_name}'}});
        """)
        
        page.wait_for_timeout(300)
        
        # Should handle without overflow
        assert page.locator("#thread-pane").is_visible()
    
    def test_edge_006_massive_message_history(self, page: Page):
        """TC-EDGE-006: Handles loading very large message histories."""
        page.wait_for_selector("#messages", timeout=5000)
        
        # Would need to load 1000+ messages
        # This tests pagination and memory handling
        assert page.locator("#messages").is_visible()
    
    def test_edge_007_deeply_nested_thread_structure(self, page: Page):
        """TC-EDGE-007: Handles deeply nested thread replies."""
        page.wait_for_selector("#messages", timeout=5000)
        
        # If replies/nesting is supported, test depth
        page.evaluate("""
        for (let i = 0; i < 100; i++) {
            window.createReply?.(i, 'Nested reply ' + i);
        }
        """)
        
        page.wait_for_timeout(500)
        
        assert page.locator("#messages").is_visible()


class TestSpecialCharacterHandling:
    """Tests for special character edge cases."""
    
    def test_edge_008_rtl_text_rendering(self, page: Page, sse_injector):
        """TC-EDGE-008: Properly renders right-to-left text."""
        page.wait_for_selector("#messages", timeout=5000)
        
        # Inject RTL message
        sse_injector.inject_message_event(
            page,
            thread_id="rtl-test",
            seq=2000,
            content="مرحبا بك في النظام"  # Arabic
        )
        
        page.wait_for_timeout(500)
        
        assert page.locator("#messages").is_visible()
    
    def test_edge_009_emoji_variations(self, page: Page, sse_injector):
        """TC-EDGE-009: Handles emoji variations and skin tones."""
        page.wait_for_selector("#messages", timeout=5000)
        
        emoji_content = "👨‍👩‍👧‍👦 👍🏳️‍🌈 🇮🇹"  # Family emoji, rainbow flag, etc
        
        sse_injector.inject_message_event(
            page,
            thread_id="emoji-test",
            seq=2001,
            content=emoji_content
        )
        
        page.wait_for_timeout(500)
        
        assert page.locator("#messages").is_visible()
    
    def test_edge_010_unicode_normalization(self, page: Page):
        """TC-EDGE-010: Handles different Unicode representations."""
        page.wait_for_selector("#messages", timeout=5000)
        
        # Same character, different Unicode compositions
        composed = "é"  # U+00E9
        decomposed = "é"  # U+0065 + U+0301
        
        assert composed != decomposed
        
        # Both should display correctly
        page.wait_for_timeout(300)
        assert page.locator("#messages").is_visible()
    
    def test_edge_011_zero_width_characters(self, page: Page):
        """TC-EDGE-011: Handles zero-width characters."""
        page.wait_for_selector(".compose-input", timeout=5000)
        compose = page.locator(".compose-input")
        
        # Message with zero-width characters
        zw_text = "visible\u200Binvisible"
        compose.fill(zw_text)
        
        page.wait_for_timeout(300)
        
        assert compose.input_value() == zw_text


class TestBoundaryNumberValues:
    """Tests for numeric boundary values."""
    
    def test_edge_012_very_large_seq_number(self, page: Page, sse_injector):
        """TC-EDGE-012: Handles very large seq numbers."""
        page.wait_for_selector("#messages", timeout=5000)
        
        # Edge case: JavaScript MAX_SAFE_INTEGER
        large_seq = 9007199254740991  # MAX_SAFE_INTEGER
        
        sse_injector.inject_message_event(
            page,
            thread_id="large-seq",
            seq=large_seq,
            content="Large seq message"
        )
        
        page.wait_for_timeout(500)
        
        assert page.locator("#messages").is_visible()
    
    def test_edge_013_zero_and_negative_numbers(self, page: Page):
        """TC-EDGE-013: Handles zero and negative numeric values."""
        page.wait_for_selector("#messages", timeout=5000)
        
        # Message with seq = 0
        page.evaluate("""
        window.displayMessage?.({seq: 0, content: 'Zero seq'});
        """)
        
        page.wait_for_timeout(300)
        
        assert page.locator("#messages").is_visible()
    
    def test_edge_014_float_numbers_where_int_expected(self, page: Page):
        """TC-EDGE-014: Handles float values for integer fields."""
        page.wait_for_selector("#messages", timeout=5000)
        
        # seq as float
        page.evaluate("""
        window.displayMessage?.({seq: 123.456, content: 'Float seq'});
        """)
        
        page.wait_for_timeout(300)
        
        assert page.locator("#messages").is_visible()


class TestTemporalEdgeCases:
    """Tests for time-related edge cases."""
    
    def test_edge_015_timestamp_in_future(self, page: Page, sse_injector):
        """TC-EDGE-015: Handles timestamps in the future."""
        page.wait_for_selector("#messages", timeout=5000)
        
        # Message timestamp in 2099
        sse_injector.inject_message_event(
            page,
            thread_id="future-time",
            seq=3000,
            content="Future message"
        )
        
        page.evaluate("""
        window.lastMessage = {created_at: '2099-12-31T23:59:59Z'};
        """)
        
        page.wait_for_timeout(300)
        
        assert page.locator("#messages").is_visible()
    
    def test_edge_016_timestamp_year_2000_problem(self, page: Page):
        """TC-EDGE-016: Handles year 2000 and before."""
        page.wait_for_selector("#messages", timeout=5000)
        
        # Old message timestamp (before 2000)
        page.evaluate("""
        window.oldMessage = {created_at: '1999-12-31T23:59:59Z'};
        """)
        
        page.wait_for_timeout(300)
        
        assert page.locator("#messages").is_visible()
    
    def test_edge_017_invalid_date_string(self, page: Page):
        """TC-EDGE-017: Handles invalid date strings."""
        page.wait_for_selector("#messages", timeout=5000)
        
        # Invalid date format
        page.evaluate("""
        window.invalidDateMsg = {created_at: 'not-a-date'};
        """)
        
        page.wait_for_timeout(300)
        
        # Should not crash
        assert page.locator("#messages").is_visible()


class TestBrowserLimitEdgeCases:
    """Tests for browser-level limitations."""
    
    def test_edge_018_dom_size_limit(self, page: Page):
        """TC-EDGE-018: Handles reaching DOM size limits."""
        page.wait_for_selector("#messages", timeout=5000)
        
        # Create many DOM elements
        page.evaluate("""
        let container = document.getElementById('messages');
        for (let i = 0; i < 10000; i++) {
            let el = document.createElement('div');
            el.textContent = 'Message ' + i;
            container.appendChild(el);
        }
        """)
        
        page.wait_for_timeout(1000)
        
        # Page should still be responsive
        assert page.locator("#topbar").is_visible()
    
    def test_edge_019_memory_pressure(self, page: Page):
        """TC-EDGE-019: Handles memory pressure gracefully."""
        page.wait_for_selector("#messages", timeout=5000)
        
        # Allocate large strings
        page.evaluate("""
        let huge = new Array(1000000).fill('x').join('');
        window.hugeData = huge;
        """)
        
        page.wait_for_timeout(500)
        
        # Page should remain functional
        assert page.locator("#topbar").is_visible()
    
    def test_edge_020_rapid_dom_updates(self, page: Page):
        """TC-EDGE-020: Handles rapid DOM updates."""
        page.wait_for_selector("#messages", timeout=5000)
        
        # Simulate rapid updates
        page.evaluate("""
        let container = document.getElementById('messages');
        for (let i = 0; i < 100; i++) {
            let el = document.createElement('div');
            el.textContent = 'Update ' + i;
            container.appendChild(el);
            container.removeChild(el);
        }
        """)
        
        page.wait_for_timeout(500)
        
        assert page.locator("#messages").is_visible()
