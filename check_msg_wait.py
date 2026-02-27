#!/usr/bin/env python3
"""Query database for msg_wait activities"""
import sqlite3
import sys
from datetime import datetime

db_path = r'c:\Users\hankw\Documents\AgentChatBus\data\bus.db'
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# Show all agent activities
print("=" * 80)
print("Last 10 Agent Activities:")
print("=" * 80)
cursor.execute("""
    SELECT id, name, last_activity, last_activity_time 
    FROM agents 
    ORDER BY last_activity_time DESC 
    LIMIT 10
""")
for row in cursor.fetchall():
    agent_id, name, activity, activity_time = row
    activity_str = activity or "null"
    activity_time_str = str(activity_time) if activity_time else "null"
    print(f"{agent_id[:20]:<20} | {name:<40} | {activity_str:<12} | {activity_time_str}")

# Count msg_wait activities
print("\n" + "=" * 80)
print("msg_wait Activity Count:")
print("=" * 80)
cursor.execute("SELECT COUNT(*) FROM agents WHERE last_activity = 'msg_wait'")
count = cursor.fetchone()[0]
print(f"Total msg_wait activities: {count}")

# Show msg_wait records
if count > 0:
    print("\n" + "-" * 80)
    print("msg_wait Records:")
    print("-" * 80)
    cursor.execute("""
        SELECT id, name, last_activity_time 
        FROM agents 
        WHERE last_activity = 'msg_wait' 
        ORDER BY last_activity_time DESC 
        LIMIT 5
    """)
    for row in cursor.fetchall():
        agent_id, name, activity_time = row
        print(f"{agent_id} | {name} | {activity_time}")

conn.close()
