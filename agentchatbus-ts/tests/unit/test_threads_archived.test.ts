/**
 * test_threads_archived.test.ts
 * 
 * 移植自 Python: tests/test_threads_archived.py
 * 功能：Thread Archive Functionality (UP-19)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../../src/core/services/memoryStore.js';
import type { ThreadRecord } from '../../src/core/types/models.js';

describe('Threads Archived Unit Tests', () => {
    let store: MemoryStore;

    beforeEach(() => {
        process.env.AGENTCHATBUS_DB = ':memory:';
        store = new MemoryStore();
        store.reset();
    });

    // Helper - Create thread
    function createThread(topic: string): ThreadRecord {
        return store.createThread(topic).thread;
    }

    it('thread list include archived filtering and archive', () => {
        // 对应 Python: L9-50
        /** Test archiving threads and filtering. */
        const t1 = createThread("Thread A");
        const t2 = createThread("Thread B");

        // Initially, both show up regardless of includeArchived
        let threads = store.listThreads({ includeArchived: false });
        expect(threads.threads.map(t => t.id)).toEqual(expect.arrayContaining([t1.id, t2.id]));

        threads = store.listThreads({ includeArchived: true });
        expect(threads.threads.map(t => t.id)).toEqual(expect.arrayContaining([t1.id, t2.id]));

        // Archive one thread
        const ok = store.updateThreadStatus(t1.id, "archived");
        expect(ok).toBe(true);

        // Verify thread status changed to archived
        const archivedThread = store.getThread(t1.id);
        expect(archivedThread?.status).toBe("archived");

        // Explicit status filtering should work
        const archivedOnly = store.listThreads({ status: "archived" });
        expect(archivedOnly.threads.map(t => t.id)).toContain(t1.id);

        // Default listing should exclude archived
        threads = store.listThreads({ includeArchived: false });
        const threadIds = threads.threads.map(t => t.id);
        expect(threadIds).toContain(t2.id);
        expect(threadIds).not.toContain(t1.id);

        // includeArchived=true returns both
        threads = store.listThreads({ includeArchived: true });
        expect(threads.threads.map(t => t.id)).toEqual(expect.arrayContaining([t1.id, t2.id]));

        // Ensure state validator accepts 'archived'
        const ok2 = store.updateThreadStatus(t2.id, "archived");
        expect(ok2).toBe(true);

        // Both should now be archived
        const allArchived = store.listThreads({ status: "archived" });
        expect(allArchived.threads.length).toBe(2);
    });
});
