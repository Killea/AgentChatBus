/**
 * Test helpers for AgentChatBus TypeScript tests
 */

import { randomUUID } from 'crypto';

export interface TestAgentConfig {
  ide: string;
  model: string;
  display_name?: string;
  capabilities?: string[];
}

export interface TestThreadConfig {
  topic: string;
  system_prompt?: string;
}

/**
 * Generate a unique ID for tests
 */
export function generateTestId(prefix = 'test'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/**
 * Create a test agent configuration
 */
export function createTestAgentConfig(config: Partial<TestAgentConfig> = {}): TestAgentConfig {
  return {
    ide: config.ide || 'TestIDE',
    model: config.model || 'TestModel',
    display_name: config.display_name,
    capabilities: config.capabilities,
  };
}

/**
 * Create a test thread configuration
 */
export function createTestThreadConfig(topic: string, systemPrompt?: string): TestThreadConfig {
  return {
    topic,
    system_prompt: systemPrompt,
  };
}

/**
 * Sleep helper
 */
export async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry helper for flaky operations
 */
export async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  delayMs = 100
): Promise<T> {
  let lastError: Error;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxAttempts) {
        await sleep(delayMs);
      }
    }
  }
  
  throw lastError!;
}
