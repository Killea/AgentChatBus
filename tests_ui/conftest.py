import os
import pytest

# By default, skip UI tests which may start interactive processes or long waits.
# Set environment variable RUN_UI_TESTS=1 to run these tests locally or in CI when intended.
if not os.getenv("RUN_UI_TESTS"):
    reason = "Skipping UI tests by default; set RUN_UI_TESTS=1 to enable"

    def pytest_runtest_setup(item):
        pytest.skip(reason)
