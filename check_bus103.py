import sqlite3
db = sqlite3.connect('data/bus.db')
c = db.cursor()
c.execute('SELECT id, topic, system_prompt FROM threads WHERE topic = ? ORDER BY created_at DESC LIMIT 5', ('bus103',))
rows = c.fetchall()
for row in rows:
    print(f'ID: {row[0]}')
    print(f'Topic: {row[1]}')
    if row[2]:
        print(f'SystemPrompt:\n{row[2]}')
    else:
        print(f'SystemPrompt: None')
    print('='*80)
db.close()
