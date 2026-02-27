"""
examples/agent_b.py — Simulated "Responder" Agent [DEMONSTRATION ONLY]

NOTE: This script is for demonstration purposes only and should NOT be run
in production or shared collaboration environments like Bus11x threads. 
It has been disabled to prevent unsolicited automated responses.

To enable this demo agent, restore the auto_reply_enabled flag below.

Original Usage:
    python -m examples.agent_b

Run this AFTER starting the server AND agent_a (or any message-producing agent):
    python -m src.main          # terminal 1
    python -m examples.agent_a # terminal 2
    python -m examples.agent_b # terminal 3 (DISABLED)
"""
import asyncio
import random
import httpx

BASE_URL = "http://127.0.0.1:39765"

# OVERRIDE: Disable auto-replies to prevent unwanted messages in shared threads
AUTO_REPLY_ENABLED = False

# Pre-canned expert replies (no LLM needed for the demo)
# These are DISABLED by AUTO_REPLY_ENABLED flag
EXPERT_REPLIES = [
    (
        "Great question! The most important consideration is separating I/O-bound vs CPU-bound work. "
        "For I/O-bound tasks, `asyncio` with `await` is ideal. For CPU-bound, use `concurrent.futures.ProcessPoolExecutor`."
    ),
    (
        "For error handling in async code, context managers (`async with`) are usually cleaner. "
        "They ensure resources are released even on exceptions. Use `try/except` only when you need "
        "fine-grained recovery logic."
    ),
    (
        "Testing async code: use `pytest-asyncio` with `@pytest.mark.asyncio`. "
        "Mock external I/O with `AsyncMock`. Keep tests deterministic by avoiding real sleep — "
        "patch `asyncio.sleep` where needed."
    ),
    (
        "One more tip: always set a timeout on `await` calls using `asyncio.wait_for(coro, timeout=N)`. "
        "Silent hangs are the hardest async bugs to diagnose."
    ),
    (
        "Agreed on all points. If I had to summarize: *use async for I/O, process pools for CPU, "
        "context managers for cleanup, and always set timeouts*. That covers 90% of real-world cases."
    ),
]


async def heartbeat_loop(client: httpx.AsyncClient, agent_id: str, token: str):
    """Send periodic heartbeats to stay marked as online."""
    while True:
        try:
            await client.post("/api/agents/heartbeat",
                              json={"agent_id": agent_id, "token": token})
        except Exception:
            pass
        await asyncio.sleep(10)


async def watch_thread(client: httpx.AsyncClient, thread_id: str, my_name: str):
    """Monitor a single thread (and optionally reply to messages from other agents)."""
    last_seq = 0
    reply_index = 0
    print(f"[AgentB] 👀 Watching thread {thread_id[:8]}…")

    while True:
        r = await client.get(f"/api/threads/{thread_id}/messages",
                             params={"after_seq": last_seq, "limit": 20})
        if r.status_code != 200:
            await asyncio.sleep(1)
            continue

        msgs = r.json()
        for m in msgs:
            if m["seq"] > last_seq:
                last_seq = m["seq"]
            if m["author"] == my_name:
                continue  # skip own messages
            if m["role"] == "system" and "✅" in m["content"]:
                print(f"[AgentB] Thread {thread_id[:8]} closed. Stopping watcher.")
                return

            print(f"[AgentB] ← [{thread_id[:8]}] {m['author']}: {m['content'][:80]}…")

            # AUTO-REPLY DISABLED (see AUTO_REPLY_ENABLED flag at top)
            if AUTO_REPLY_ENABLED:
                # "Thinking" delay (simulates LLM processing time)
                await asyncio.sleep(random.uniform(1.5, 3.0))

                reply = EXPERT_REPLIES[reply_index % len(EXPERT_REPLIES)]
                reply_index += 1
                await client.post(f"/api/threads/{thread_id}/messages",
                                  json={"author": my_name, "role": "assistant", "content": reply})
                print(f"[AgentB] → [{thread_id[:8]}] {reply[:80]}…")

        await asyncio.sleep(1)


async def main():
    if not AUTO_REPLY_ENABLED:
        print("[AgentB] ⚠️  AUTO-REPLY IS DISABLED (intended for production/collaboration threads)")
        print("[AgentB] This agent will register and monitor threads, but NOT send automated responses.")
        print("[AgentB] To enable replies, set AUTO_REPLY_ENABLED = True at the top of this file.")
        print()
    
    async with httpx.AsyncClient(base_url=BASE_URL, timeout=30) as client:

        # 1. Register
        r = await client.post("/api/agents/register", json={
            "ide": "CLI",
            "model": "AgentB-Responder",
            "description": "Monitor agent (auto-reply currently disabled)." if not AUTO_REPLY_ENABLED else "I listen to threads and respond with expert knowledge.",
            "capabilities": ["async-python", "expert-replies"],
        })
        if r.status_code != 200:
            print(f"[AgentB] Register failed: {r.status_code} {r.text}"); return
        agent    = r.json()
        agent_id = agent["agent_id"]
        token    = agent["token"]
        my_name  = agent["name"]   # e.g. "CLI (AgentB-Responder)" or "CLI (AgentB-Responder) 2"
        print(f"[AgentB] Registered as '{my_name}' ({agent_id})")
        print(f"[AgentB] Polling for threads… (Ctrl+C to stop)")

        # 2. Start heartbeat in the background
        asyncio.create_task(heartbeat_loop(client, agent_id, token))

        # 3. Discovery loop: watch for new threads and spawn a watcher per thread
        watched: set[str] = set()
        try:
            while True:
                r = await client.get("/api/threads", params={"status": "discuss"})
                if r.status_code == 200:
                    for t in r.json():
                        if t["id"] not in watched:
                            watched.add(t["id"])
                            asyncio.create_task(watch_thread(client, t["id"], my_name))
                await asyncio.sleep(2)

        except (KeyboardInterrupt, asyncio.CancelledError):
            print("\n[AgentB] Shutting down…")
            await client.post("/api/agents/unregister",
                              json={"agent_id": agent_id, "token": token})
            print("[AgentB] Unregistered. Bye.")


if __name__ == "__main__":
    asyncio.run(main())
