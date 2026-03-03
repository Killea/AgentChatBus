#!/usr/bin/env python
"""Kick admin: 1) set a new online admin, 2) backdate heartbeat to offline"""
import sqlite3
import datetime
import requests

db_path = 'data/bus.db'
base_url = 'http://127.0.0.1:39765'
thread_id = '63536384-2584-4524-b56c-989e05085be4'

# Step 1: Find first online agent (not the one we kicked before)
agents = requests.get(f'{base_url}/api/agents', timeout=5).json()
online = [a for a in agents if a['is_online']]
if not online:
    print('ERROR: no online agents')
    exit(1)

# Skip last kicked one, pick another
new_admin_id = None
for a in online:
    if a['id'] != '88065430-21f4-4c98-9e61-fed6dda7322c':
        new_admin_id = a['id']
        new_admin_name = a['display_name'] or a['name']
        break

if not new_admin_id:
    new_admin_id = online[0]['id']
    new_admin_name = online[0]['display_name'] or online[0]['name']

print(f'Selected new admin: {new_admin_id[:8]}... {new_admin_name}')

# Step 2: Write this admin to thread_settings
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
before = conn.execute('SELECT creator_admin_id, creator_admin_name FROM thread_settings WHERE thread_id=?', (thread_id,)).fetchone()
conn.execute('UPDATE thread_settings SET creator_admin_id=?, creator_admin_name=? WHERE thread_id=?', (new_admin_id, new_admin_name, thread_id))
conn.commit()
after = conn.execute('SELECT creator_admin_id, creator_admin_name FROM thread_settings WHERE thread_id=?', (thread_id,)).fetchone()

print(f'thread_settings updated:')
print(f'  before: {dict(before) if before else None}')
print(f'  after:  {dict(after) if after else None}')

# Step 3: Backdate heartbeat to offline (120s in past)
ts = (datetime.datetime.utcnow() - datetime.timedelta(seconds=120)).isoformat() + '+00:00'
conn.execute('UPDATE agents SET last_heartbeat=? WHERE id=?', (ts, new_admin_id))
conn.commit()

agent_info = conn.execute('SELECT id, display_name, last_heartbeat FROM agents WHERE id=?', (new_admin_id,)).fetchone()
print(f'Agent backdated to offline:')
print(f'  agent_id: {new_admin_id[:8]}...')
print(f'  display_name: {agent_info["display_name"]}')
print(f'  last_heartbeat: {agent_info["last_heartbeat"]}')

# Step 4: Verify via API
admin_status = requests.get(f'{base_url}/api/threads/{thread_id}/admin', timeout=5).json()
agent_status = [a for a in requests.get(f'{base_url}/api/agents', timeout=5).json() if a['id'] == new_admin_id][0]
print(f'API verification:')
print(f'  thread admin: {admin_status}')
print(f'  agent is_online: {agent_status["is_online"]}')

conn.close()
print('\n✅ Done: admin set and then kicked offline. UI should show switch button.')
