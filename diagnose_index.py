"""Check if UNIQUE INDEX exists on threads.topic"""
import sqlite3

DB_PATH = "data/bus.db"
conn = sqlite3.connect(DB_PATH)
cursor = conn.cursor()

# List all indexes on threads table
print("=" * 60)
print("SQLite Indexes on 'threads' table:")
print("=" * 60)
cursor.execute("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='threads'")
indexes = cursor.fetchall()
for name, sql in indexes:
    print(f"Name: {name}")
    print(f"SQL: {sql}")
    print()

# Check if idx_threads_topic exists
print("=" * 60)
cursor.execute("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_threads_topic'")
idx = cursor.fetchone()
if idx:
    print("✅ idx_threads_topic EXISTS")
else:
    print("❌ idx_threads_topic NOT FOUND")

# Try to manually create it and see what happens
print("=" * 60)
print("Attempting to create UNIQUE INDEX...")
try:
    cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_topic_test ON threads(topic)")
    conn.commit()
    print("✅ CREATE UNIQUE INDEX succeeded")
    
    # Now try duplicate insert
    print("\nTesting duplicate insert...")
    cursor.execute("INSERT INTO threads (id, topic, status, created_at) VALUES (?, ?, 'test', datetime('now'))", ('test-1', 'test-topic'))
    conn.commit()
    print("✅ First insert succeeded")
    
    cursor.execute("INSERT INTO threads (id, topic, status, created_at) VALUES (?, ?, 'test', datetime('now'))", ('test-2', 'test-topic'))
    conn.commit()
    print("❌ Second insert succeeded (should have failed!)")
    
except sqlite3.IntegrityError as e:
    print(f"✅ Got IntegrityError as expected: {e}")
except Exception as e:
    print(f"Error: {type(e).__name__}: {e}")
finally:
    conn.close()
