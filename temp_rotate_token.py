#!/usr/bin/env python
"""Force admin offline by rotating token"""
import sqlite3
import uuid

db_path = 'data/bus.db'
admin_id = '4e815ce2-7bbf-45ca-a0dc-a731e267a2f4'

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row

old = conn.execute('SELECT token FROM agents WHERE id=?', (admin_id,)).fetchone()
new_token = str(uuid.uuid4())
conn.execute('UPDATE agents SET token=? WHERE id=?', (new_token, admin_id))
conn.commit()

print(f'Token rotated for admin:')
print(f'  admin_id: {admin_id[:8]}...')
print(f'  old_token: {old["token"][:16] if old else "N/A"}...')
print(f'  new_token: {new_token[:16]}...')
print(f'  (old connections will be invalid on next call)')

conn.close()
print('✅ Token rotated. Admin connection will fail on next heartbeat/msg_wait.')
