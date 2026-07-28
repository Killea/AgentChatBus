import { describe, it, expect, beforeEach } from 'vitest';
import '../../../web-ui/js/shared-threads.js';

const {
  normalizeThreadTagInput,
  deriveKnownTags,
  filterThreadsForDisplay,
  setActiveTagFilter,
  clearActiveTagFilter,
  getActiveTagFilter,
} = window.AcbThreads;

describe('thread tag helpers', () => {
  beforeEach(() => {
    clearActiveTagFilter();
  });

  it('normalizeThreadTagInput lowercases and validates slugs', () => {
    expect(normalizeThreadTagInput(' Feature-Alpha ')).toBe('feature-alpha');
    expect(normalizeThreadTagInput('bad tag')).toBeNull();
    expect(normalizeThreadTagInput('')).toBeNull();
  });

  it('deriveKnownTags collects unique sorted tags', () => {
    const tags = deriveKnownTags([
      { id: 't1', tags: ['beta', 'alpha'] },
      { id: 't2', tags: ['alpha'] },
      { id: 't3', tags: [] },
    ]);
    expect(tags).toEqual(['alpha', 'beta']);
  });

  it('filterThreadsForDisplay applies status and tag filters together', () => {
    const selectedStatuses = new Set(['discuss', 'implement']);
    const threads = [
      { id: 't1', status: 'discuss', tags: ['alpha'] },
      { id: 't2', status: 'implement', tags: ['alpha'] },
      { id: 't3', status: 'discuss', tags: ['beta'] },
      { id: 't4', status: 'closed', tags: ['alpha'] },
    ];

    const filtered = filterThreadsForDisplay(threads, selectedStatuses, 'alpha');
    expect(filtered.map((thread) => thread.id)).toEqual(['t1', 't2']);
  });

  it('setActiveTagFilter stores normalized active tag', () => {
    setActiveTagFilter('Docs');
    expect(getActiveTagFilter()).toBe('docs');
    clearActiveTagFilter();
    expect(getActiveTagFilter()).toBeNull();
  });
});
