/**
 * Test server fixture for real HTTP integration tests.
 * Similar to Python tests/conftest.py server fixture.
 */
import { spawn, ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_PORT = 39769;
const TEST_BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

export interface TestServer {
  baseUrl: string;
  port: number;
  dbPath: string;
}

let serverProcess: ChildProcess | null = null;
let testDbPath: string | null = null;
let isRunning = false;

/**
 * Wait for server to be ready by polling /health endpoint
 */
async function waitForServer(baseUrl: string, maxRetries = 30, delayMs = 500): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return true;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return false;
}

/**
 * Start test server - call in beforeAll() with session scope simulation
 */
export async function startTestServer(): Promise<TestServer> {
  if (isRunning && serverProcess) {
    return { baseUrl: TEST_BASE_URL, port: TEST_PORT, dbPath: testDbPath! };
  }

  // Create temp directory for test database
  const tempDir = mkdtempSync(join(tmpdir(), 'agentchatbus-test-'));
  testDbPath = join(tempDir, 'test.db');

  const env = {
    ...process.env,
    AGENTCHATBUS_PORT: String(TEST_PORT),
    AGENTCHATBUS_DB: testDbPath,
    AGENTCHATBUS_RATE_LIMIT_ENABLED: 'false', // Disable rate limiting for tests
    NODE_ENV: 'test',
  };

  // Start server process
  serverProcess = spawn('node', ['dist/cli/index.js', 'serve'], {
    env,
    stdio: ['ignore', 'inherit', 'inherit'], // Show logs for debugging
    detached: false,
  });

  // Handle process errors
  serverProcess.on('error', (err) => {
    console.error('Test server error:', err);
  });

  // Wait for server to be ready
  const ready = await waitForServer(TEST_BASE_URL);
  if (!ready) {
    await stopTestServer();
    throw new Error(`Test server failed to start at ${TEST_BASE_URL}`);
  }

  isRunning = true;
  console.log(`Test server started at ${TEST_BASE_URL}`);

  return { baseUrl: TEST_BASE_URL, port: TEST_PORT, dbPath: testDbPath };
}

/**
 * Stop test server - call in afterAll()
 */
export async function stopTestServer(): Promise<void> {
  if (!serverProcess) {
    return;
  }

  console.log('Stopping test server...');

  // Try graceful shutdown first
  serverProcess.kill('SIGTERM');

  // Wait for exit with timeout
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      // Force kill if graceful shutdown fails
      if (serverProcess) {
        console.log('Force killing test server...');
        serverProcess.kill('SIGKILL');
      }
      resolve();
    }, 3000);

    serverProcess!.on('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  serverProcess = null;
  isRunning = false;

  // Cleanup temp directory
  if (testDbPath) {
    try {
      const tempDir = join(testDbPath, '..');
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    testDbPath = null;
  }

  console.log('Test server stopped');
}

/**
 * Check if server is running
 */
export function isServerRunning(): boolean {
  return isRunning;
}

/**
 * Make HTTP request to test server
 */
export async function request(
  method: string,
  path: string,
  options?: {
    body?: unknown;
    headers?: Record<string, string>;
    token?: string;
  }
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const url = `${TEST_BASE_URL}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options?.headers,
  };

  if (options?.token) {
    headers['X-Agent-Token'] = options.token;
  }

  const response = await fetch(url, {
    method,
    headers,
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });

  let body: unknown;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    body = await response.json();
  } else {
    body = await response.text();
  }

  return { status: response.status, body, headers: response.headers };
}

// Helper functions for common operations
export async function registerAgent(ide = 'VS Code', model = 'GPT-4'): Promise<{ agentId: string; token: string }> {
  const { body } = await request('POST', '/api/agents/register', {
    body: { ide, model },
  });
  return { agentId: (body as any).agent_id, token: (body as any).token };
}

export async function createThread(topic: string, creatorId?: string, token?: string): Promise<string> {
  const { body } = await request('POST', '/api/threads', {
    body: { topic, creator_agent_id: creatorId },
    token,
  });
  return (body as any).id;
}

export async function getSyncContext(threadId: string): Promise<{ currentSeq: number; replyToken: string }> {
  const { body } = await request('POST', `/api/threads/${threadId}/sync-context`, { body: {} });
  return { currentSeq: (body as any).current_seq, replyToken: (body as any).reply_token };
}

export async function postMessage(
  threadId: string,
  author: string,
  content: string,
  sync?: { currentSeq: number; replyToken: string }
): Promise<unknown> {
  const ctx = sync || await getSyncContext(threadId);
  const { body } = await request('POST', `/api/threads/${threadId}/messages`, {
    body: {
      author,
      content,
      expected_last_seq: ctx.currentSeq,
      reply_token: ctx.replyToken,
    },
  });
  return body;
}
