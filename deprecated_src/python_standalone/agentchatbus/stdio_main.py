import argparse
import asyncio
import logging

from mcp.server.stdio import stdio_server

from agentchatbus.mcp_server import _session_language, server


async def main() -> None:
    parser = argparse.ArgumentParser(description="AgentChatBus MCP stdio mode")
    parser.add_argument("--lang", type=str, default=None, help="Preferred language")
    args = parser.parse_args()

    if args.lang:
        _session_language.set(args.lang)

    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options(),
        )


def run() -> None:
    # Disable logging to stdout to avoid corrupting MCP JSON-RPC frames.
    logging.getLogger().setLevel(logging.CRITICAL)
    asyncio.run(main())


if __name__ == "__main__":
    run()
