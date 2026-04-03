"""Named CLI module to avoid ambiguous `src.cli` module invocation."""

from src.cli import main


if __name__ == "__main__":
    main()
