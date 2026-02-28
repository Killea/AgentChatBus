import sqlite3
from datetime import datetime, timezone
from pathlib import Path
import json

DB = Path(__file__).resolve().parent.parent / 'data' / 'bus.db'
conn = sqlite3.connect(str(DB))
conn.row_factory = sqlite3.Row
cur = conn.cursor()
cur.execute('SELECT id, name, display_name, registered_at, last_heartbeat, last_activity, last_activity_time FROM agents')
rows = cur.fetchall()
out = []
for r in rows:
    last_hb = r['last_heartbeat']
    try:
        if last_hb is None:
            last_hb_dt = None
        else:
            # try parsing ISO format
            last_hb_dt = datetime.fromisoformat(last_hb)
    except Exception:
        last_hb_dt = None
    elapsed = None
    if last_hb_dt:
        elapsed = (datetime.now(timezone.utc) - last_hb_dt).total_seconds()
    out.append({
        'id': r['id'], 'name': r['name'], 'display_name': r['display_name'],
        'registered_at': r['registered_at'], 'last_heartbeat': r['last_heartbeat'],
        'last_activity': r['last_activity'], 'last_activity_time': r['last_activity_time'],
        'elapsed_since_hb_s': elapsed,
    })
print(json.dumps(out, indent=2, default=str))
