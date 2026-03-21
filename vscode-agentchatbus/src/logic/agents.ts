import type { Agent } from '../api/types';

function toTimestamp(value: string | undefined): number {
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? parsed : 0;
}

export function getAgentActivityTimestamp(agent: Agent): number {
    return toTimestamp(agent.last_activity_time || agent.last_heartbeat);
}

export function filterAndSortAgents(
    agents: Agent[],
    options?: {
        showOnlyRecent?: boolean;
        nowMs?: number;
    }
): Agent[] {
    const showOnlyRecent = options?.showOnlyRecent ?? true;
    const nowMs = options?.nowMs ?? Date.now();
    const oneHourAgo = nowMs - 60 * 60 * 1000;

    const filtered = showOnlyRecent
        ? agents.filter((agent) => getAgentActivityTimestamp(agent) > oneHourAgo || agent.is_online)
        : agents.slice();

    return filtered.sort((a, b) => {
        if (a.is_online !== b.is_online) {
            return a.is_online ? -1 : 1;
        }
        return getAgentActivityTimestamp(b) - getAgentActivityTimestamp(a);
    });
}

export function getRelativeTimeString(date: Date, nowMs = Date.now()): string {
    const delta = Math.round((nowMs - date.getTime()) / 1000);
    if (delta < 60) return 'just now';
    if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
    if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
    return `${Math.floor(delta / 86400)}d ago`;
}

export function shouldRefreshAgentsForEventType(type: string | undefined): boolean {
    return Boolean(type && (type.startsWith('agent.') || type === 'msg.new'));
}

export function buildAgentItemViewModel(
    agent: Agent,
    options?: {
        nowMs?: number;
    }
): {
    label: string;
    tooltip: string;
    description: string;
    iconId: string;
    colorId: string;
    contextValue: string;
} {
    const displayName = agent.display_name || agent.name || agent.id;
    const lastSeen = agent.last_activity_time || agent.last_heartbeat;
    const relativeTime = lastSeen
        ? getRelativeTimeString(new Date(lastSeen), options?.nowMs)
        : 'Never';

    return {
        label: displayName,
        tooltip: `IDE: ${agent.ide || 'N/A'}\nModel: ${agent.model || 'N/A'}\nLast Seen: ${relativeTime}\nActivity: ${agent.last_activity || 'None'}`,
        description: agent.is_online ? 'Online' : `Last seen ${relativeTime}`,
        iconId: agent.is_online ? 'circle-filled' : 'circle-outline',
        colorId: agent.is_online ? 'testing.iconPassed' : 'testing.iconUntested',
        contextValue: 'agent',
    };
}
