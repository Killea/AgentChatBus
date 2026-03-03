#!/usr/bin/env python
"""Unregister the admin agent to completely disconnect it"""
import requests
import sqlite3

db_path = 'data/bus.db'
base_url = 'http://127.0.0.1:39765'
admin_id = '4e815ce2-7bbf-45ca-a0dc-a731e267a2f4'

# Get the new token we just generated (it's in the DB)
conn = sqlite3.connect(db_path)
token_row = conn.execute('SELECT token FROM agents WHERE id=?', (admin_id,)).fetchone()
new_token = token_row[0] if token_row else None
conn.close()

if not new_token:
    print('ERROR: Could not find agent token')
    exit(1)

# Unregister the agent
try:
    resp = requests.post(
        f'{base_url}/api/agents/unregister',
        json={'agent_id': admin_id, 'token': new_token},
        timeout=5
    )
    print(f'Unregister response: {resp.status_code}')
    print(f'  {resp.json()}')
except Exception as e:
    print(f'ERROR: {e}')
    exit(1)

# Verify admin is gone
agents = requests.get(f'{base_url}/api/agents', timeout=5).json()
found = [a for a in agents if a['id'] == admin_id]
print(f'Agent in list after unregister: {found}')

print('✅ Agent unregistered (fully disconnected)')
