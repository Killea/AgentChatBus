import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryStore } from '../../src/core/services/memoryStore.js';
import type { ThreadRecord } from '../../src/core/types/models.js';

describe('Thread Wait State', () => {
    let store: MemoryStore;

    beforeEach(() => {
        process.env.AGENTCHATBUS_DB = ':memory:';
        store = new MemoryStore();
        store.reset();
    });

    function createThread(topic: string = "test-wait-state"): ThreadRecord {
        return store.createThread(topic).thread;
    }

    describe('getThreadWaitStates', () => {
        it('returns empty object for thread with no waiters', () => {
            const thread = createThread();
            const result = store.getThreadWaitStates(thread.id);

            expect(result).toEqual({});
        });

        it('returns empty object for non-existent thread', () => {
            const result = store.getThreadWaitStates('non-existent-thread-id');

            expect(result).toEqual({});
        });

        it('returns active waiter after enterWaitState', () => {
            const thread = createThread();
            const agentId = 'agent-abc-123';
            const timeoutMs = 300_000;

            (store as any).enterWaitState(thread.id, agentId, timeoutMs);

            const result = store.getThreadWaitStates(thread.id);

            expect(Object.keys(result)).toHaveLength(1);
            expect(result[agentId]).toBeDefined();
            expect(result[agentId].timeout_ms).toBe(timeoutMs);
            expect(result[agentId].entered_at).toBeTruthy();
        });

        it('returns multiple waiters on the same thread', () => {
            const thread = createThread();

            (store as any).enterWaitState(thread.id, 'agent-1', 300_000);
            (store as any).enterWaitState(thread.id, 'agent-2', 120_000);

            const result = store.getThreadWaitStates(thread.id);

            expect(Object.keys(result)).toHaveLength(2);
            expect(result['agent-1']).toBeDefined();
            expect(result['agent-2']).toBeDefined();
            expect(result['agent-1'].timeout_ms).toBe(300_000);
            expect(result['agent-2'].timeout_ms).toBe(120_000);
        });

        it('does not return waiter after exitWaitState', () => {
            const thread = createThread();
            const agentId = 'agent-exit-test';

            (store as any).enterWaitState(thread.id, agentId, 300_000);
            store.exitWaitState(thread.id, agentId);

            const result = store.getThreadWaitStates(thread.id);

            expect(result).toEqual({});
        });

        it('prunes expired waiter before returning', () => {
            const thread = createThread();
            const agentId = 'agent-expired';

            (store as any).enterWaitState(thread.id, agentId, 1);

            vi.useFakeTimers();
            vi.advanceTimersByTime(100);

            const result = store.getThreadWaitStates(thread.id);

            expect(result).toEqual({});

            vi.useRealTimers();
        });

        it('keeps valid waiter while pruning expired one', () => {
            const thread = createThread();

            (store as any).enterWaitState(thread.id, 'agent-expired', 1);
            (store as any).enterWaitState(thread.id, 'agent-valid', 600_000);

            vi.useFakeTimers();
            vi.advanceTimersByTime(100);

            const result = store.getThreadWaitStates(thread.id);

            expect(Object.keys(result)).toHaveLength(1);
            expect(result['agent-valid']).toBeDefined();
            expect(result['agent-expired']).toBeUndefined();

            vi.useRealTimers();
        });

        it('isolates wait states between threads', () => {
            const thread1 = createThread("thread-1");
            const thread2 = createThread("thread-2");

            (store as any).enterWaitState(thread1.id, 'agent-t1', 300_000);
            (store as any).enterWaitState(thread2.id, 'agent-t2', 300_000);

            const result1 = store.getThreadWaitStates(thread1.id);
            const result2 = store.getThreadWaitStates(thread2.id);

            expect(Object.keys(result1)).toHaveLength(1);
            expect(result1['agent-t1']).toBeDefined();
            expect(result1['agent-t2']).toBeUndefined();

            expect(Object.keys(result2)).toHaveLength(1);
            expect(result2['agent-t2']).toBeDefined();
            expect(result2['agent-t1']).toBeUndefined();
        });
    });
});
