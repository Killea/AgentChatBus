"""
Conftest for UI tests.
"""
import os
import pytest

# Use the same test port as the main conftest to connect to the test server
TEST_PORT = 39766
BASE_URL = f"http://127.0.0.1:{TEST_PORT}"

# Override the default BASE_URL for UI tests
os.environ["AGENTCHATBUS_BASE_URL"] = BASE_URL
