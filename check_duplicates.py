"""Check duplicate topics in database"""
import sqlite3

DB_PATH = "data/bus.db"
conn = sqlite3.connect(DB_PATH)
cursor = conn.cursor()

print("=" * 60)
print("Checking for duplicate topics...")
print("=" * 60)

cursor.execute("""
    SELECT topic, COUNT(*) as cnt FROM threads 
    GROUP BY topic HAVING cnt > 1
""")
duplicates = cursor.fetchall()

if duplicates:
    print(f"❌ Found {len(duplicates)} topics with duplicates:")
    for topic, cnt in duplicates:
        print(f"  Topic '{topic}': {cnt} threads")
        cursor.execute("SELECT id, created_at FROM threads WHERE topic = ? ORDER BY created_at", (topic,))
        rows = cursor.fetchall()
        for rid, created_at in rows:
            print(f"    - {rid[:8]}... (created: {created_at})")
else:
    print("✅ No duplicates found")

print("\n" + "=" * 60)
print("All threads:")
print("=" * 60)
cursor.execute("SELECT topic, COUNT(*) as cnt FROM threads GROUP BY topic ORDER BY COUNT(*) DESC")
all_topics = cursor.fetchall()
for topic, cnt in all_topics:
    print(f"  '{topic}': {cnt}")

conn.close()
