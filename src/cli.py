import argparse

import uvicorn

from src.config import HOST, PORT


def main() -> None:
    parser = argparse.ArgumentParser(description="Run AgentChatBus HTTP/SSE server")
    parser.add_argument("--host", default=HOST, help="Bind host")
    parser.add_argument("--port", type=int, default=PORT, help="Bind port")
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Enable auto-reload for development",
    )
    args = parser.parse_args()

    uvicorn.run(
        "src.main:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level="info",
        timeout_graceful_shutdown=3,
    )


if __name__ == "__main__":
    main()
