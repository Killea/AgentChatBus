"""Manually clean up duplicates"""
import sqlite3

DB_PATH = "data/bus.db"
conn = sqlite3.connect(DB_PATH)
cursor = conn.cursor()

print("Manually cleaning bus200 duplicate...")
# Keep the newer one (2beb4899), delete the older one (ec9d433a)
cursor.execute("DELETE FROM threads WHERE topic = 'bus200' AND id = 'ec9d433a-79d7-40de-b36d-d38d4da31e9f'")
conn.commit()

# Verify
cursor.execute("SELECT id FROM threads WHERE topic = 'bus200'")
remaining = cursor.fetchall()
print(f"Remaining threads for 'bus200': {len(remaining)}")
for (tid,) in remaining:
    print(f"  - {tid}")

print("\nNow attempting to create UNIQUE INDEX...")
try:
    cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_topic ON threads(topic)")
    conn.commit()
    print("✅ UNIQUE INDEX created successfully!")
except sqlite3.IntegrityError as e:
    print(f"❌ Still have duplicates: {e}")
except Exception as e:
    print(f"Error: {e}")

conn.close()
