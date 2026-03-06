import subprocess
import sys
from pathlib import Path
import shutil


def test_ruff_critical_gate() -> None:
    """Ensure critical Ruff checks pass when running the pytest suite."""
    repo_root = Path(__file__).resolve().parent.parent
    primary_cmd = [sys.executable, "-m", "ruff", "check", "."]
    result = subprocess.run(
        primary_cmd,
        cwd=repo_root,
        capture_output=True,
        text=True,
    )

    # Some local environments run pytest from a venv without ruff installed,
    # while a global ruff binary is available on PATH.
    if result.returncode != 0 and "No module named ruff" in result.stderr:
        ruff_bin = shutil.which("ruff")
        if ruff_bin:
            result = subprocess.run(
                [ruff_bin, "check", "."],
                cwd=repo_root,
                capture_output=True,
                text=True,
            )

    assert result.returncode == 0, (
        "Ruff critical check failed.\n"
        f"STDOUT:\n{result.stdout}\n"
        f"STDERR:\n{result.stderr}"
    )
