"""Contract tests that prevent test code from using production databases."""

import os
import re
from pathlib import Path

import pytest


_ASSIGN_RE = re.compile(
    r"os\.environ\[['\"]AGENTCHATBUS_DB['\"]\]\s*=\s*['\"]([^'\"]+)['\"]"
)

_PROD_DB_LITERALS = (
    "data/bus.db",
    "data\\bus.db",
    ".agentchatbus/bus.db",
    ".agentchatbus\\bus.db",
)


def _read_text(path: Path) -> str:
    for enc in ("utf-8", "gbk"):
        try:
            return path.read_text(encoding=enc)
        except Exception:
            pass
    raise RuntimeError(f"Unable to read file: {path}")


def _is_test_scoped_db(value: str) -> bool:
    if value == ":memory:":
        return True
    normalized = value.replace("\\", "/").lower()
    name = Path(value).name.lower()
    return "test" in name or "/tests/" in normalized or "/test" in normalized


@pytest.mark.parametrize(
    "path",
    sorted(
        (
            p
            for p in Path("tests").glob("test_*.py")
            if p.name != Path(__file__).name
        ),
        key=lambda p: p.name,
    ),
)
def test_test_files_do_not_configure_production_database(path: Path) -> None:
    text = _read_text(path)

    # Fail on direct production DB literals in test files.
    lowered = text.lower()
    hits = [literal for literal in _PROD_DB_LITERALS if literal in lowered]
    assert not hits, f"{path}: contains production DB literal(s): {hits}"

    # Validate any explicit AGENTCHATBUS_DB assignments are test-scoped.
    bad_assignments = []
    for match in _ASSIGN_RE.finditer(text):
        value = match.group(1)
        if not _is_test_scoped_db(value):
            bad_assignments.append(value)

    assert not bad_assignments, (
        f"{path}: AGENTCHATBUS_DB assignment must be test-scoped or ':memory:'. "
        f"Found: {bad_assignments}"
    )


def test_runtime_agentchatbus_db_is_test_scoped() -> None:
    value = os.getenv("AGENTCHATBUS_DB", "")
    assert value, "AGENTCHATBUS_DB must be set during tests"

    normalized = value.replace("\\", "/").lower()
    assert normalized not in ("data/bus.db", str(Path.home() / ".agentchatbus" / "bus.db").replace("\\", "/").lower()), (
        f"Refusing to run tests with production DB path: {value}"
    )
    assert _is_test_scoped_db(value), (
        "AGENTCHATBUS_DB must point to a test database path (contains 'test' or tests directory) "
        f"or ':memory:'. Got: {value}"
    )


def test_conftest_enforces_database_guardrails() -> None:
    conftest = _read_text(Path("tests/conftest.py"))
    assert "def enforce_test_database" in conftest
    assert "AGENTCHATBUS_DB" in conftest
