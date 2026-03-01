#!/usr/bin/env python3
"""Test script to debug context variable propagation in msg_wait"""

import json
import subprocess
import time

# Agent credentials from previous resume test
AGENT_ID = "agent-b"
AGENT_TOKEN = "b7aff0e9"
THREAD_ID = "thread-1"

def call_mcp(method, params):
    """Call MCP tool via stdio"""
    request = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": method,
            "arguments": params
        }
    }
    
    # Write to service (via shell)
    print(f"\n[TEST] Calling {method} with: {params}")
    print("-" * 60)
    

print("=" * 60)
print("Context Variable Propagation Test")
print("=" * 60)

# First, try agent_resume to set context
print("\n[STEP 1] Calling agent_resume to set context variables...")
call_mcp("agent_resume", {
    "agent_id": AGENT_ID,
    "token": AGENT_TOKEN
})

time.sleep(0.5)

# Then call msg_wait and check if context is available
print("\n[STEP 2] Calling msg_wait to check if context available...")
call_mcp("msg_wait", {
    "thread_id": THREAD_ID,
    "after_seq": 0,
    "timeout_ms": 2000
})

print("\n" + "=" * 60)
print("Test complete. Check server logs for:")
print("  [agent_resume] Set context for agent...")
print("  [msg_wait] explicit: agent_id=None, context: agent_id=agent-b")
print("=" * 60)
