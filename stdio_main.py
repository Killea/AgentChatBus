import asyncio
import argparse
from mcp.server.stdio import stdio_server
from src.mcp_server import server, _session_language

async def main():
    parser = argparse.ArgumentParser(description="AgentChatBus MCP stdio mode")
    parser.add_argument("--lang", type=str, default=None, help="Preferred language")
    args = parser.parse_args()

    if args.lang:
        _session_language.set(args.lang)

    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options()
        )

if __name__ == "__main__":
    # Disable logging to stdout to avoid corrupting MCP JSON-RPC
    import logging
    logging.getLogger().setLevel(logging.CRITICAL)
    asyncio.run(main())
