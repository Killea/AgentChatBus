export type UiAgentAuth = {
    agent_id: string;
    token: string;
};

export function applyServerUrlChange(
    currentBaseUrl: string,
    nextBaseUrl: string,
    currentAuth: UiAgentAuth | null
): {
    baseUrl: string;
    uiAgentAuth: UiAgentAuth | null;
    shouldReconnectSse: boolean;
} {
    const didChange = nextBaseUrl !== currentBaseUrl;
    return {
        baseUrl: nextBaseUrl,
        uiAgentAuth: didChange ? null : currentAuth,
        shouldReconnectSse: didChange,
    };
}

export function parseUiAgentRegistrationPayload(payload: unknown): UiAgentAuth {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Invalid UI agent registration payload');
    }

    const maybe = payload as { agent_id?: unknown; token?: unknown };
    if (!maybe.agent_id || !maybe.token) {
        throw new Error('Invalid UI agent registration payload');
    }

    return {
        agent_id: String(maybe.agent_id),
        token: String(maybe.token),
    };
}

export function buildEventsUrl(baseUrl: string): string {
    return `${baseUrl}/events`;
}

export function parseSseEventData(raw: string): { ok: true; data: unknown } | { ok: false; error: unknown } {
    try {
        return { ok: true, data: JSON.parse(raw) };
    } catch (error) {
        return { ok: false, error };
    }
}
