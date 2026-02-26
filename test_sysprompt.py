import asyncio
import json
from src.mcp_server import server

async def main():
    # Call the msg_list tool via the raw MCP server API
    result = await server.call_tool("msg_list", {"thread_id": "89e9afd4-ed5d-4ae6-b38a-f36e2874460b", "after_seq": 0, "limit": 10})
    print(result[0].text)

if __name__ == "__main__":
    asyncio.run(main())
