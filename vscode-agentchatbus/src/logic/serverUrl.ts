import * as net from 'net';

function normalizeHost(host: string): string {
    return host.trim().toLowerCase().split('%')[0];
}

function expandLocalIpSet(localIps: string[]): Set<string> {
    const expanded = new Set<string>();
    for (const ip of localIps) {
        const normalized = normalizeHost(ip);
        if (!normalized) {
            continue;
        }
        expanded.add(normalized);
        if (normalized.startsWith('::ffff:')) {
            expanded.add(normalized.slice('::ffff:'.length));
        }
    }
    return expanded;
}

export function getBrowserOpenUrl(rawUrl: string): string {
    try {
        const normalized = new URL(rawUrl);
        if (normalized.hostname === '0.0.0.0' || normalized.hostname === '::' || normalized.hostname === '[::]') {
            normalized.hostname = '127.0.0.1';
        }
        return normalized.toString();
    } catch {
        return rawUrl;
    }
}

export function isLocalServerUrlWithContext(
    rawUrl: string,
    context: {
        localHostName: string;
        localIps: string[];
    }
): boolean {
    try {
        const normalized = new URL(rawUrl);
        const host = normalizeHost(normalized.hostname);
        const localHostName = normalizeHost(context.localHostName);

        if (!host) {
            return false;
        }

        if (
            host === 'localhost'
            || host === '127.0.0.1'
            || host === '::1'
            || host === '0.0.0.0'
            || host === '::'
            || host === '::ffff:127.0.0.1'
            || host.startsWith('127.')
        ) {
            return true;
        }

        if (host === localHostName) {
            return true;
        }

        if (!net.isIP(host)) {
            return false;
        }

        const localIps = expandLocalIpSet(context.localIps);
        if (localIps.has(host)) {
            return true;
        }
        if (host.startsWith('::ffff:') && localIps.has(host.slice('::ffff:'.length))) {
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

export function formatLmError(err: unknown): string {
    if (!err) return 'Unknown error';
    if (err instanceof Error) return err.message;

    if (typeof err === 'object') {
        const maybe = err as { message?: unknown; code?: unknown; name?: unknown };
        const message = typeof maybe.message === 'string' ? maybe.message : '';
        const code = typeof maybe.code === 'string' ? maybe.code : '';
        const name = typeof maybe.name === 'string' ? maybe.name : '';
        if (code && message) return `${code}: ${message}`;
        if (code) return code;
        if (name && message) return `${name}: ${message}`;
        if (message) return message;
    }

    return String(err);
}
