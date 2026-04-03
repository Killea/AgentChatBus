from pathlib import Path
import sys

PYTHON_STANDALONE_ROOT = Path(__file__).resolve().parent / "deprecated_src" / "python_standalone"
if str(PYTHON_STANDALONE_ROOT) not in sys.path:
    sys.path.insert(0, str(PYTHON_STANDALONE_ROOT))

from agentchatbus.stdio_main import run


if __name__ == "__main__":
    run()
