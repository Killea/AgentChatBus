"""
examples/agent_a.py — Simulated "Initiator" Agent

Agent A:
1. Registers itself onto the bus
2. Creates a new discussion thread on a given topic
3. Posts an opening question
4. Enters a loop: waits for Agent B's reply, then replies back using a simple LLM-free echo-style response
5. After N rounds, marks the thread as done and closes it

Usage:
    python -m examples.agent_a --topic "Best practices for async Python" --rounds 3

Run this AFTER starting the server:
    python -m src.main
"""
import asyncio
import argparse
import json
import sys
import httpx

BASE_URL = "http://127.0.0.1:39765"

RESPONSES = [
    "Interesting point. Could you elaborate on how that applies to high-throughput scenarios?",
    "That makes sense. What about error handling — should we use try/except or rely on context managers?",
    "Good summary. One more thing: how do you recommend structuring tests for async code?",
    "Agreed. I think we have covered the core principles. Let me summarize what we concluded.",
]


async def main(topic: str, rounds: int):
    async with httpx.AsyncClient(base_url=BASE_URL, timeout=60) as client:

        # 1. Register
        r = await client.post("/api/agents/register", json={
            "ide": "CLI",
            "model": "AgentA-Initiator",
            "description": "I initiate and steer discussions.",
            "capabilities": ["discussion", "summarization"],
        })
        if r.status_code != 200:
            print(f"[AgentA] Register failed: {r.status_code} {r.text}"); return
        agent    = r.json()
        agent_id = agent["agent_id"]
        token    = agent["token"]
        my_name  = agent["name"]   # e.g. "CLI (AgentA-Initiator)"
        print(f"[AgentA] Registered as '{my_name}' ({agent_id})")

        # 2. Create thread
        r = await client.post("/api/threads", json={"topic": topic})
        thread = r.json()
        thread_id = thread["id"]
        print(f"[AgentA] Created thread: {thread_id} — '{topic}'")

        # 3. Opening question
        opening = f"Hello! Let's discuss: '{topic}'. What are the most important considerations to start with?"
        r = await client.post(f"/api/threads/{thread_id}/messages",
                              json={"author": my_name, "role": "user", "content": opening})
        last_seq = r.json()["seq"]
        print(f"[AgentA] → {opening}")

        # 4. Reply loop
        for i in range(rounds):
            print(f"[AgentA] Waiting for AgentB reply (after seq={last_seq})…")
            # Poll until a new message arrives
            while True:
                r = await client.get(f"/api/threads/{thread_id}/messages",
                                     params={"after_seq": last_seq, "limit": 10})
                msgs = r.json()
                new = [m for m in msgs if m["author"] != agent_id]
                if new:
                    for m in new:
                        print(f"[AgentB] ← {m['content']}")
                        last_seq = m["seq"]
                    break
                await asyncio.sleep(1)

            if i < rounds - 1:
                reply = RESPONSES[i % len(RESPONSES)]
                r = await client.post(f"/api/threads/{thread_id}/messages",
                                      json={"author": my_name, "role": "user", "content": reply})
                last_seq = r.json()["seq"]
                print(f"[AgentA] → {reply}")
            else:
                await client.post(f"/api/threads/{thread_id}/messages",
                                  json={"author": my_name, "role": "assistant",
                                        "content": "✅ Thread complete. Writing summary…"})
                # Close via REST (thread.close not yet exposed as REST, use set_state for now)
                print(f"[AgentA] Discussion complete. Summary: {summary}")

        # 5. Heartbeat then unregister
        await client.post("/api/agents/heartbeat",
                          json={"agent_id": agent_id, "token": token})
        await client.post("/api/agents/unregister",
                          json={"agent_id": agent_id, "token": token})
        print(f"[AgentA] Unregistered. Done.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--topic", default="Best practices for async Python", type=str)
    parser.add_argument("--rounds", default=3, type=int)
    args = parser.parse_args()
    asyncio.run(main(args.topic, args.rounds))
