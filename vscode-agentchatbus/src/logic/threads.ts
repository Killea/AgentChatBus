import type { Thread } from '../api/types';

function toTimestamp(value: string | undefined): number {
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? parsed : 0;
}

export function filterAndSortThreads(threads: Thread[], statuses: Iterable<string>): Thread[] {
    const allowedStatuses = new Set(statuses);
    return threads
        .filter((thread) => allowedStatuses.has(thread.status))
        .sort((a, b) => toTimestamp(b.created_at) - toTimestamp(a.created_at));
}

export function getThreadStatusIconFileName(status: string | undefined): string {
    switch (status) {
        case 'implement':
            return 'thread-implement.svg';
        case 'review':
            return 'thread-review.svg';
        case 'done':
            return 'thread-done.svg';
        case 'closed':
            return 'thread-closed.svg';
        case 'archived':
            return 'thread-archived.svg';
        case 'discuss':
        default:
            return 'thread-discuss.svg';
    }
}

export function shouldRefreshThreadsForEventType(type: string | undefined): boolean {
    return Boolean(type && (type.startsWith('thread.') || type === 'msg.new'));
}

export function shouldIncludeArchivedThreadStatus(statuses: Iterable<string>): boolean {
    return new Set(statuses).has('archived');
}

export function buildThreadItemViewModel(thread: Thread): {
    label: string;
    tooltip: string;
    description: string;
    iconFile: string;
    contextValue: string;
    commandId: string;
    commandArguments: [Thread];
} {
    return {
        label: thread.topic || 'Untitled Thread',
        tooltip: `ID: ${thread.id}\nStatus: ${thread.status}`,
        description: thread.status,
        iconFile: getThreadStatusIconFileName(thread.status),
        contextValue: `thread:${thread.status}`,
        commandId: 'agentchatbus.openThread',
        commandArguments: [thread],
    };
}
