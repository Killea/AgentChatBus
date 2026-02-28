import asyncio
from src.db.database import get_db
from src.db import crud
import src.mcp_server as mcp_server

async def main():
    db = await get_db()
    agents = await crud.agent_list(db)
    active_agent_ids = {v.get('agent_id') for v in mcp_server._connection_agents.values() if v.get('agent_id')}
    out = []
    for a in agents:
        is_online = bool(a.is_online or (a.id in active_agent_ids))
        out.append({'id': a.id, 'name': a.name, 'is_online': is_online, 'in_active_map': (a.id in active_agent_ids)})
    print(out)

asyncio.run(main())
