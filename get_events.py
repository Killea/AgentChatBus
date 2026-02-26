import sqlite3
db = sqlite3.connect('data/bus.db')
c = db.cursor()
c.execute('SELECT payload FROM events WHERE thread_id="138311d0-a96a-4529-9de8-15d1404c1ffc" ORDER BY id DESC LIMIT 5')
for row in c.fetchall():
    print(row[0])
db.close()
