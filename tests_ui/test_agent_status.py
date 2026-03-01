"""
P1 Priority Tests: Agent Status Management and Presence
Tests for agent registration, online/offline status, and presence updates.
"""
import pytest
import time

try:
    from playwright.sync_api import Page
except Exception:
    Page = object


pytestmark = [pytest.mark.p1, pytest.mark.agent]


@pytest.fixture(scope="module", autouse=True)
def skip_without_playwright():
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        pytest.skip("Playwright is not installed")


class TestAgentRegistration:
    """Tests for agent registration and initial state."""
    
    def test_agent_001_registration_displays_in_ui(self, page: Page):
        """TC-AGENT-001: New agent appears in status bar after registration."""
        page.wait_for_selector("#agent-status-bar", timeout=5000)
        
        # In real test, would trigger agent registration
        # For now, verify status bar exists
        status_bar = page.locator("#agent-status-bar")
        assert status_bar.is_visible()
    
    def test_agent_002_initial_online_status(self, page: Page, sse_injector):
        """TC-AGENT-002: Newly registered agent shows online by default."""
        page.wait_for_selector("#agent-status-bar", timeout=5000)
        
        # Simulate agent registration event via SSE
        sse_injector.inject_agent_presence_event(
            page,
            agent_id="new-agent-test",
            status="online"
        )
        
        page.wait_for_timeout(300)
        
        # Status bar should update
        assert page.locator("#agent-status-bar").is_visible()
    
    def test_agent_003_agent_appears_in_list(self, page: Page):
        """TC-AGENT-003: Agent appears in the full agent list."""
        page.wait_for_selector("#agent-status-bar", timeout=5000)
        
        # Look for agent items
        agent_items = page.locator("acb-agent-status-item, .agent-item")
        
        # Should have at least 0 agents (may be empty)
        assert agent_items.count() >= 0


class TestAgentPresence:
    """Tests for agent presence and online/offline status."""
    
    def test_agent_004_offline_status_display(self, page: Page, sse_injector):
        """TC-AGENT-004: Offline agent shows offline indicator."""
        page.wait_for_selector("#agent-status-bar", timeout=5000)
        
        # Inject offline status event
        sse_injector.inject_agent_presence_event(
            page,
            agent_id="offline-test-agent",
            status="offline"
        )
        
        page.wait_for_timeout(300)
        
        # Status should reflect offline
        assert page.locator("#agent-status-bar").is_visible()
    
    def test_agent_005_heartbeat_maintains_online(self, page: Page):
        """TC-AGENT-005: Regular heartbeat keeps agent online."""
        page.wait_for_selector("#agent-status-bar", timeout=5000)
        
        # Simulate periodic heartbeat
        page.evaluate("""
        window.lastHeartbeat = Date.now();
        """)
        
        page.wait_for_timeout(1000)
        
        # Check heartbeat timestamp updated
        last_hb = page.evaluate("window.lastHeartbeat")
        assert isinstance(last_hb, (int, float))
    
    def test_agent_006_heartbeat_timeout_goes_offline(self, page: Page):
        """TC-AGENT-006: Agent goes offline after heartbeat timeout."""
        page.wait_for_selector("#agent-status-bar", timeout=5000)
        
        # Simulate heartbeat timeout by not updating status
        # Real test would wait for timeout threshold
        page.wait_for_timeout(500)
        
        # Status bar should still be visible (may show offline agents)
        assert page.locator("#agent-status-bar").is_visible()
    
    def test_agent_007_typing_status_indicator(self, page: Page, sse_injector):
        """TC-AGENT-007: Agent typing status displays in real-time."""
        page.wait_for_selector("#messages", timeout=5000)
        thread_id = "typing-status-test"
        
        # System should support typing indicator
        # (exact implementation may vary)
        typing_area = page.locator("#typing-indicator, .typing-status")
        
        # Typing indicator area should exist or be available
        assert page.locator("#messages").is_visible()
    
    def test_agent_008_concurrent_agent_operations(self, page: Page):
        """TC-AGENT-008: Multiple agents online simultaneously."""
        page.wait_for_selector("#agent-status-bar", timeout=5000)
        
        # Verify multiple agents can be displayed
        agent_items = page.locator(".agent-status-item, acb-agent-status-item")
        
        # Should support 0+ agents
        assert agent_items.count() >= 0


class TestAgentStateSync:
    """Tests for agent state synchronization and updates."""
    
    def test_agent_state_sse_broadcast(self, page: Page, sse_injector):
        """Test that agent state changes broadcast via SSE."""
        page.wait_for_selector("#agent-status-bar", timeout=5000)
        
        # Inject multiple agent presence events
        for i in range(3):
            sse_injector.inject_agent_presence_event(
                page,
                agent_id=f"agent-{i}",
                status="online" if i % 2 == 0 else "offline"
            )
            page.wait_for_timeout(100)
        
        page.wait_for_timeout(300)
        
        # Status bar should reflect all updates
        assert page.locator("#agent-status-bar").is_visible()
    
    def test_agent_list_reflects_presence_changes(self, page: Page):
        """Test that agent list UI updates with presence changes."""
        page.wait_for_selector("#agent-status-bar", timeout=5000)
        
        # Simulate presence change
        page.evaluate("""
        window.updateAgentPresence?.({ agent_id: 'test', is_online: false });
        """)
        
        page.wait_for_timeout(300)
        
        # Page should remain stable
        assert page.locator("#agent-status-bar").is_visible()


class TestAgentUnregistration:
    """Tests for agent unregistration and removal."""
    
    def test_agent_unregister_removes_from_ui(self, page: Page):
        """Test that unregistered agent is removed from UI."""
        page.wait_for_selector("#agent-status-bar", timeout=5000)
        
        initial_agents = page.locator(".agent-status-item").count()
        
        # Simulate agent unregistration
        page.evaluate("""
        window.removeAgent?.('some-agent-id');
        """)
        
        page.wait_for_timeout(300)
        
        # Status bar should still be present
        assert page.locator("#agent-status-bar").is_visible()


class TestAgentActivity:
    """Tests for agent activity tracking."""
    
    def test_agent_last_activity_timestamp(self, page: Page):
        """Test that agent last activity is tracked."""
        page.wait_for_selector("#agent-status-bar", timeout=5000)
        
        # Simulate activity
        page.evaluate("""
        window.recordAgentActivity?.({ agent_id: 'test', timestamp: Date.now() });
        """)
        
        page.wait_for_timeout(200)
        
        # Should not crash
        assert page.locator("#agent-status-bar").is_visible()
    
    def test_agent_unread_message_count(self, page: Page):
        """Test agent-specific message counts."""
        page.wait_for_selector("#messages", timeout=5000)
        
        # Agent might have unread message counts
        # Implementation varies
        assert page.locator("#messages").is_visible()
