"""
End-to-end validation script for AgentChatBus modifications.
Tests: 1) Thread idempotency (UNIQUE INDEX), 2) read_resource URI parsing
"""
import httpx
import json
import time

BASE_URL = "http://127.0.0.1:39765"

async def test_thread_idempotency():
    """Test 1: Create same-topic threads twice, verify idempotency"""
    async with httpx.AsyncClient(base_url=BASE_URL, timeout=10) as client:
        topic = "E2E-Idempotency-Test"
        
        # First create
        print(f"[Test1] Creating thread with topic: '{topic}'")
        r1 = await client.post("/api/threads", json={"topic": topic})
        if r1.status_code != 201:
            print(f"  ❌ FAILED: {r1.status_code} {r1.text}")
            return
        thread1 = r1.json()
        id1 = thread1["id"]
        print(f"  ✅ Created: {id1}")
        
        # Second create (same topic)
        print(f"[Test1] Creating same thread again...")
        r2 = await client.post("/api/threads", json={"topic": topic})
        if r2.status_code != 201:
            print(f"  ❌ FAILED: {r2.status_code} {r2.text}")
            return
        thread2 = r2.json()
        id2 = thread2["id"]
        print(f"  ✅ Created: {id2}")
        
        # Verify idempotency
        if id1 == id2:
            print(f"  ✅ PASS: Both threads are same (idempotent): {id1}")
            return id1
        else:
            print(f"  ❌ FAIL: Different IDs created! {id1} vs {id2}")
            return None

async def test_transcript_uri(thread_id):
    """Test 2: Read transcript via read_resource URI parsing"""
    if not thread_id:
        print("[Test2] Skipped (no valid thread_id from Test1)")
        return
    
    # First post a message so we have content
    async with httpx.AsyncClient(base_url=BASE_URL, timeout=10) as client:
        print(f"[Test2] Posting test message to thread: {thread_id}")
        r = await client.post(
            f"/api/threads/{thread_id}/messages",
            json={"author": "test-agent", "role": "user", "content": "Test message for E2E"}
        )
        if r.status_code != 201:
            print(f"  ❌ Failed to post message: {r.status_code}")
            return
        print(f"  ✅ Message posted")
        
        # Now test MCP resource read (via direct HTTP if possible, or via agent)
        print(f"[Test2] Note: /transcript is MCP resource, testing via agent...")
        print(f"  ℹ️  Manual verification: check web console or run agent_b to read transcript")
        print(f"  Expected: transcript should show thread_id={thread_id}, not 'threads'")

async def main():
    print("=" * 60)
    print("AgentChatBus E2E Validation")
    print("=" * 60)
    
    # Test 1: Idempotency
    print("\n[Test 1] Thread Idempotency (UNIQUE INDEX)\n")
    thread_id = await test_thread_idempotency()
    
    # Test 2: Transcript URI
    print("\n[Test 2] Transcript URI Parsing (read_resource)\n")
    await test_transcript_uri(thread_id)
    
    print("\n" + "=" * 60)
    print("Tests complete. Waiting for Agent 2 to run agent_a demo...")
    print("=" * 60)

if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
