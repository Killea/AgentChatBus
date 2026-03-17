/**
 * Global test setup for real server integration tests.
 * Matches Python tests/conftest.py session-scoped server fixture.
 */
import { startTestServer, stopTestServer, isServerRunning } from './testServer';

// Track if we started the server (vs using existing)
let startedByUs = false;

/**
 * Session-scoped setup - runs once before all tests
 */
export async function setup() {
  // Check if server is already running (e.g., manually started for debugging)
  try {
    const response = await fetch('http://127.0.0.1:39769/health');
    if (response.ok) {
      console.log('Using existing test server at http://127.0.0.1:39769');
      return;
    }
  } catch {
    // Server not running, we'll start it
  }

  await startTestServer();
  startedByUs = true;
}

/**
 * Session-scoped teardown - runs once after all tests
 */
export async function teardown() {
  if (startedByUs) {
    await stopTestServer();
  }
}
