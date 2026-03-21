export type McpLogRow = {
    message: string;
    index: number;
    description?: string;
    iconId?: string;
    colorId?: string;
};

export function appendLogLines(existingLogs: string[], data: string, maxLogs = 500): string[] {
    const nextLogs = [...existingLogs];
    const lines = data.split(/\r?\n/).filter(line => line.trim().length > 0);
    for (const line of lines) {
        nextLogs.push(line);
        if (nextLogs.length > maxLogs) {
            nextLogs.shift();
        }
    }
    return nextLogs;
}

export function getMcpLogRows(
    logs: string[],
    isManaged: boolean,
    statusMessage: string | null
): McpLogRow[] {
    if (!isManaged && logs.length === 0) {
        return [
            {
                message: statusMessage || 'Ready (Managed Externally)',
                index: -1,
                description: 'Extension is reading logs from the shared AgentChatBus log API.',
                iconId: 'info',
                colorId: 'descriptionForeground',
            },
        ];
    }

    if (logs.length === 0) {
        return [
            {
                message: 'Waiting for logs...',
                index: -2,
                iconId: 'sync~spin',
            },
        ];
    }

    return logs.map((log, index) => ({
        message: log,
        index,
        ...getMcpLogPresentation(log, index),
    }));
}

export function getMcpLogPresentation(
    message: string,
    index: number
): Pick<McpLogRow, 'description' | 'iconId' | 'colorId'> {
    if (index === -1) {
        return {
            description: 'Extension is reading logs from the shared AgentChatBus log API.',
            iconId: 'info',
            colorId: 'descriptionForeground',
        };
    }

    if (index === -2) {
        return {
            iconId: 'sync~spin',
        };
    }

    if (message.includes('ERROR') || message.includes('Exception') || message.includes('failed')) {
        return {
            iconId: 'error',
            colorId: 'errorForeground',
        };
    }

    if (message.includes('WARNING')) {
        return {
            iconId: 'warning',
            colorId: 'problemsWarningIcon.foreground',
        };
    }

    if (message.includes('Exec:') || message.includes('Starting')) {
        return {
            iconId: 'terminal',
        };
    }

    return {};
}
