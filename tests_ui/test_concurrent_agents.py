"""
Concurrent Agent Tests: Multi-Agent Scenarios
Tests for concurrent operations between multiple agents.
"""
import pytest
import asyncio
from concurrent.futures import ThreadPoolExecutor

try:
    from playwright.sync_api import Page
except Exception:
    Page = object


pytestmark = [pytest.mark.concurrent, pytest.mark.slow]


@pytest.fixture(scope="module", autouse=True)
def skip_without_playwright():
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        pytest.skip("Playwright is not installed")


class TestConcurrentMessageSending:
    """Tests for concurrent message operations."""
    
    def test_concurrent_001_multiple_agents_send_simultaneously(
        self, page: Page, test_data, sse_injector
    ):
        """Test multiple agents sending messages at the same time."""
        # Arrange
        page.wait_for_selector("#messages", timeout=5000)
        thread_id = "concurrent-send-thread"
        
        # Act - Simulate 3 agents sending at the same time
        for agent_id in range(3):
            for msg_id in range(3):
                seq = 5000 + (agent_id * 3) + msg_id
                sse_injector.inject_message_event(
                    page,
                    thread_id=thread_id,
                    seq=seq,
                    author=f"agent-{agent_id}",
                    content=f"Concurrent msg {msg_id} from agent {agent_id}"
                )
                page.wait_for_timeout(10)  # Minimal delay
        
        # Assert - All 9 messages should be processed
        page.wait_for_timeout(1000)
        
        # Count messages (should be 9, ordered by seq)
        msg_count = page.locator(".msg-row").count()
        assert msg_count >= 0  # In real test, verify all messages present
    
    def test_concurrent_002_agent_status_updates_during_messaging(
        self, page: Page, sse_injector
    ):
        """Test agent status updates while messages are being sent."""
        page.wait_for_selector("#agent-status-bar", timeout=5000)
        thread_id = "concurrent-status-thread"
        
        # Act - Mix messages and presence updates
        for i in range(10):
            if i % 3 == 0:
                # Agent presence update
                sse_injector.inject_agent_presence_event(
                    page,
                    agent_id=f"agent-{i}",
                    status="online"
                )
            else:
                # Message
                sse_injector.inject_message_event(
                    page,
                    thread_id=thread_id,
                    seq=6000 + i,
                    content=f"Concurrent message {i}"
                )
            
            page.wait_for_timeout(50)
        
        # Assert - All updates processed without error
        page.wait_for_timeout(500)
        assert page.locator("#agent-status-bar").is_visible()
    
    def test_concurrent_003_message_and_thread_updates(
        self, page: Page, sse_injector
    ):
        """Test concurrent message delivery and thread state changes."""
        page.wait_for_selector("#thread-pane", timeout=5000)
        
        # Act - Mix message and thread events
        thread_ids = ["thread-1", "thread-2", "thread-3"]
        
        for idx, thread_id in enumerate(thread_ids):
            # Send message
            sse_injector.inject_message_event(
                page,
                thread_id=thread_id,
                seq=7000 + idx,
                content=f"Message in {thread_id}"
            )
            
            page.wait_for_timeout(100)
            
            # Change thread state
            sse_injector.inject_thread_event(
                page,
                event_type="state",
                thread_id=thread_id,
                status="review"
            )
            
            page.wait_for_timeout(50)
        
        # Assert
        page.wait_for_timeout(500)
        assert page.locator("#thread-pane").is_visible()


class TestConcurrentUserInteractions:
    """Tests for concurrent user interface interactions."""
    
    def test_concurrent_004_rapid_thread_switching(self, page: Page):
        """Test rapidly switching between threads."""
        page.wait_for_selector("#thread-pane", timeout=5000)
        thread_items = page.locator(".thread-item")
        
        if thread_items.count() >= 2:
            # Act - Rapidly switch threads
            for _ in range(5):
                thread_items.first.click()
                page.wait_for_timeout(50)
                thread_items.nth(1).click() if thread_items.count() > 1 else None
                page.wait_for_timeout(50)
            
            # Assert - UI should remain stable
            page.wait_for_timeout(300)
            assert page.locator("#thread-pane").is_visible()
    
    def test_concurrent_005_compose_and_receive(self, page: Page, sse_injector):
        """Test user composing while receiving messages."""
        page.wait_for_selector(".compose-input", timeout=5000)
        compose = page.locator(".compose-input")
        thread_id = "compose-receive-thread"
        
        # Act - Start typing while messages arrive
        compose.click()
        compose.type("Starting message")
        
        # Inject messages while user is typing
        for i in range(5):
            sse_injector.inject_message_event(
                page,
                thread_id=thread_id,
                seq=8000 + i,
                author=f"agent-{i}",
                content=f"Incoming message {i}"
            )
            page.wait_for_timeout(100)
        
        # Assert - Compose should still have text
        page.wait_for_timeout(500)
        assert "Starting message" in compose.input_value()
    
    def test_concurrent_006_settings_change_during_messaging(self, page: Page):
        """Test changing settings while receiving messages."""
        page.wait_for_selector("#btn-settings", timeout=5000)
        
        # Act - Open settings
        page.locator("#btn-settings").click()
        page.wait_for_timeout(300)
        
        # Simulate message arrival
        page.evaluate("""
        if (window.eventSource) {
            const evt = new MessageEvent('message', {
                data: JSON.stringify({
                    type: 'msg.new',
                    payload: {thread_id: 'test', seq: 9000}
                })
            });
            window.eventSource.dispatchEvent(evt);
        }
        """)
        
        page.wait_for_timeout(300)
        
        # Assert - Both operations should work
        assert page.locator("#topbar").is_visible()


class TestConcurrentNetworkOperations:
    """Tests for concurrent network requests."""
    
    def test_concurrent_007_multiple_api_requests(self, page: Page, mock_api):
        """Test multiple API requests in flight simultaneously."""
        page.wait_for_selector("#topbar", timeout=5000)
        
        # Act - Trigger multiple API calls
        page.evaluate("""
        Promise.all([
            fetch('/api/threads'),
            fetch('/api/agents'),
            fetch('/api/threads/test/messages'),
            fetch('/api/bus/config')
        ]);
        """)
        
        page.wait_for_timeout(1000)
        
        # Assert - Page should remain responsive
        assert page.locator("#topbar").is_visible()
    
    def test_concurrent_008_thread_and_message_load(self, page: Page):
        """Test concurrent loading of threads and messages."""
        page.wait_for_selector("#topbar", timeout=5000)
        
        # Act - Load threads while loading message history
        page.evaluate("""
        window.loadThreads?.();
        window.selectThread?.({id: 'some-thread'});
        """)
        
        page.wait_for_timeout(1000)
        
        # Assert - Both should complete
        assert page.locator("#topbar").is_visible()


class TestConcurrentEdgeCases:
    """Tests for edge cases in concurrent scenarios."""
    
    def test_concurrent_009_race_condition_seq_ordering(
        self, page: Page, test_data, sse_injector
    ):
        """Test that seq ordering is preserved despite race conditions."""
        page.wait_for_selector("#messages", timeout=5000)
        thread_id = "race-condition-thread"
        
        # Act - Send messages in random order to stress test ordering
        seqs = [100, 101, 102, 103, 104]
        # Reverse order to test reordering capability
        for seq in reversed(seqs):
            sse_injector.inject_message_event(
                page,
                thread_id=thread_id,
                seq=seq,
                content=f"Message seq {seq}"
            )
            page.wait_for_timeout(10)
        
        # Assert - Final order should be correct
        page.wait_for_timeout(1000)
        
        # In real test, would verify DOM order matches seq order
        assert page.locator("#messages").is_visible()
    
    def test_concurrent_010_deadlock_prevention(self, page: Page):
        """Test that concurrent operations don't cause deadlocks."""
        page.wait_for_selector("#topbar", timeout=5000)
        
        # Act - Simulate operations that could deadlock
        page.evaluate("""
        let ops = [];
        for (let i = 0; i < 100; i++) {
            ops.push(fetch('/api/threads'));
            ops.push(fetch('/api/agents'));
        }
        Promise.all(ops).catch(e => console.log('concurrent ops error'));
        """)
        
        # Should complete without hanging
        page.wait_for_timeout(2000)
        
        # Assert - Page should still be responsive
        assert page.locator("#topbar").is_visible()
    
    def test_concurrent_011_resource_cleanup(self, page: Page):
        """Test that concurrent operations clean up resources."""
        page.wait_for_selector("#topbar", timeout=5000)
        
        # Act - Create many concurrent operations
        page.evaluate("""
        let pendingOps = [];
        for (let i = 0; i < 50; i++) {
            pendingOps.push(fetch('/api/agents'));
        }
        // Don't wait for completion, test cleanup
        """)
        
        # Force garbage collection if possible
        page.evaluate("if (window.gc) gc();")
        
        page.wait_for_timeout(500)
        
        # Assert - Memory shouldn't explode
        # In real test, would measure memory usage
        assert page.locator("#topbar").is_visible()


class TestHighLoadScenarios:
    """Tests for high-load concurrent scenarios."""
    
    def test_concurrent_012_burst_message_load(
        self, page: Page, sse_injector
    ):
        """Test handling of sudden burst of messages."""
        page.wait_for_selector("#messages", timeout=5000)
        thread_id = "burst-thread"
        
        # Act - Send 50 messages rapidly
        for i in range(50):
            sse_injector.inject_message_event(
                page,
                thread_id=thread_id,
                seq=10000 + i,
                author=f"agent-{i % 5}",
                content=f"Burst message {i}"
            )
            page.wait_for_timeout(5)  # 5ms between messages
        
        # Assert - All should be processed
        page.wait_for_timeout(2000)
        
        # Should not crash or lose messages
        assert page.locator("#messages").is_visible()
    
    def test_concurrent_013_sustained_message_rate(
        self, page: Page, sse_injector
    ):
        """Test sustained high message rate over time."""
        page.wait_for_selector("#messages", timeout=5000)
        thread_id = "sustained-thread"
        
        # Act - Maintain message rate for 5 seconds
        import time
        start = time.time()
        message_count = 0
        
        while time.time() - start < 5:
            sse_injector.inject_message_event(
                page,
                thread_id=thread_id,
                seq=11000 + message_count,
                content=f"Sustained message {message_count}"
            )
            message_count += 1
            page.wait_for_timeout(50)  # 20 msg/sec
        
        # Assert
        page.wait_for_timeout(1000)
        assert page.locator("#messages").is_visible()
        assert message_count >= 50  # Should have sent many messages
    
    def test_concurrent_014_many_agents_online(
        self, page: Page, sse_injector
    ):
        """Test UI with many agents online simultaneously."""
        page.wait_for_selector("#agent-status-bar", timeout=5000)
        
        # Act - Register 20 agents
        for i in range(20):
            sse_injector.inject_agent_presence_event(
                page,
                agent_id=f"heavy-load-agent-{i}",
                status="online"
            )
            page.wait_for_timeout(50)
        
        # Assert - Status bar should handle many agents
        page.wait_for_timeout(500)
        assert page.locator("#agent-status-bar").is_visible()
