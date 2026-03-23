import * as path from 'path';

export type LaunchMode =
    | 'bundled-ts-service'
    | 'workspace-dev-service'
    | 'external-service'
    | 'external-service-extension-managed'
    | 'external-service-manual'
    | 'external-service-unknown';

export type BundledLaunchSpec = {
    command: string;
    args: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    launchMode: LaunchMode;
    resolvedBy: string;
};

export type HealthPayload = {
    status?: string;
    service?: string;
    engine?: string;
    version?: string;
    runtime?: string;
    transport?: string;
    startup_mode?: string;
    management?: {
        ownership_assignable?: boolean;
        owner_instance_id?: string | null;
        registered_sessions_count?: number;
    };
};

export type MetricsPayload = HealthPayload & Record<string, unknown>;

export type StartupProbeEndpoint = 'health' | 'metrics';

export type StartupProbeFailure = {
    status?: number;
    timedOut?: boolean;
    timeoutMs?: number;
    error?: string;
};

export type StartupProbeOutcome<T> =
    | {
        ok: true;
        payload?: T;
    }
    | ({
        ok: false;
    } & StartupProbeFailure);

export type StartupProbeResolution<T> = {
    ok: boolean;
    source: StartupProbeEndpoint | null;
    payload?: T;
    failureMessages: string[];
};

export const MIN_HOST_NODE_VERSION = {
    major: 20,
    minor: 0,
    patch: 0,
};

export const BUNDLED_RUNTIME_RESOLVED_BY =
    'Bundled agentchatbus-ts runtime packaged with the VS Code extension.';
export const WORKSPACE_DEV_RUNTIME_RESOLVED_BY =
    'Workspace-dev agentchatbus-ts runtime and local web-ui sources from the current AgentChatBus repo.';

function getStartupProbePath(endpoint: StartupProbeEndpoint): string {
    return endpoint === 'health' ? '/health' : '/api/metrics';
}

export function normalizeHealthString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
}

export function extractOwnershipAssignable(health?: HealthPayload): boolean | null {
    if (!health?.management || typeof health.management.ownership_assignable !== 'boolean') {
        return null;
    }
    return health.management.ownership_assignable;
}

export function classifyExternalStartupMode(health?: HealthPayload): LaunchMode {
    const ownershipAssignable = extractOwnershipAssignable(health);
    if (ownershipAssignable === true) {
        return 'external-service-extension-managed';
    }
    if (ownershipAssignable === false) {
        return 'external-service-manual';
    }
    return 'external-service-unknown';
}

export function classifyDetectedStartupMode(health?: HealthPayload): LaunchMode {
    const normalizedMode = normalizeHealthString(health?.startup_mode)?.toLowerCase();
    if (normalizedMode === 'bundled-ts-service') {
        return 'bundled-ts-service';
    }
    if (normalizedMode === 'workspace-dev-service') {
        return 'workspace-dev-service';
    }
    if (normalizedMode === 'external-service-extension-managed') {
        return 'external-service-extension-managed';
    }
    if (normalizedMode === 'external-service-manual') {
        return 'external-service-manual';
    }
    if (normalizedMode === 'external-service-unknown') {
        return 'external-service-unknown';
    }
    if (normalizedMode === 'external-service') {
        return 'external-service';
    }
    return classifyExternalStartupMode(health);
}

export function ensureSupportedHostNodeVersion(
    hostNodeVersion: string,
    minimum = MIN_HOST_NODE_VERSION
): { ok: boolean; message: string } {
    const parsed = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(hostNodeVersion.trim());
    if (!parsed) {
        return {
            ok: false,
            message: `Unable to parse IDE host Node version '${hostNodeVersion}'. Bundled MCP requires Node ${minimum.major}.${minimum.minor}.${minimum.patch}+ from the IDE host runtime.`,
        };
    }

    const [, majorRaw, minorRaw, patchRaw] = parsed;
    const major = Number(majorRaw);
    const minor = Number(minorRaw);
    const patch = Number(patchRaw);
    const supported = (
        major > minimum.major
        || (major === minimum.major && minor > minimum.minor)
        || (major === minimum.major && minor === minimum.minor && patch >= minimum.patch)
    );

    if (supported) {
        return {
            ok: true,
            message: `IDE host Node version ${hostNodeVersion} satisfies bundled MCP requirement ${minimum.major}.${minimum.minor}.${minimum.patch}+ .`,
        };
    }

    return {
        ok: false,
        message: `IDE host Node version ${hostNodeVersion} is too old for bundled MCP. AgentChatBus requires the IDE host runtime to provide Node ${minimum.major}.${minimum.minor}.${minimum.patch}+ .`,
    };
}

export function describeStartupProbeFailure(
    endpoint: StartupProbeEndpoint,
    failure: StartupProbeFailure,
): string {
    const probePath = getStartupProbePath(endpoint);

    if (failure.timedOut) {
        return `Startup probe ${probePath} timed out after ${failure.timeoutMs ?? 'unknown'}ms.`;
    }
    if (typeof failure.status === 'number') {
        return `Startup probe ${probePath} returned HTTP ${failure.status}.`;
    }
    if (failure.error) {
        return `Startup probe ${probePath} failed: ${failure.error}.`;
    }
    return `Startup probe ${probePath} failed.`;
}

export function resolveStartupProbeResult(input: {
    health: StartupProbeOutcome<HealthPayload>;
    metrics?: StartupProbeOutcome<MetricsPayload>;
}): StartupProbeResolution<HealthPayload | MetricsPayload> {
    if (input.health.ok) {
        return {
            ok: true,
            source: 'health',
            payload: input.health.payload,
            failureMessages: [],
        };
    }

    const failureMessages = [describeStartupProbeFailure('health', input.health)];

    if (input.metrics?.ok) {
        return {
            ok: true,
            source: 'metrics',
            payload: input.metrics.payload,
            failureMessages,
        };
    }

    if (input.metrics && !input.metrics.ok) {
        failureMessages.push(describeStartupProbeFailure('metrics', input.metrics));
    }

    return {
        ok: false,
        source: null,
        payload: undefined,
        failureMessages,
    };
}

export function createSingleFlightRunner<T>(operation: () => Promise<T>): () => Promise<T> {
    let inFlight: Promise<T> | null = null;

    return () => {
        if (inFlight) {
            return inFlight;
        }

        let execution: Promise<T>;
        try {
            execution = Promise.resolve(operation());
        } catch (error) {
            execution = Promise.reject(error);
        }
        const wrapped = execution.finally(() => {
            if (inFlight === wrapped) {
                inFlight = null;
            }
        });

        inFlight = wrapped;
        return wrapped;
    };
}

export function buildBundledLaunchSpec(input: {
    serverEntry: string;
    webUiDir: string;
    extensionRoot: string;
    globalStoragePath: string;
    hostNodeExecutable: string;
    serverUrl: string;
    cliWorkspacePath?: string;
    msgWaitMinTimeoutMs: number;
    enforceMsgWaitMinTimeout: boolean;
    processEnv?: NodeJS.ProcessEnv;
}): BundledLaunchSpec {
    const parsedUrl = new URL(input.serverUrl);
    const port = Number(parsedUrl.port || (parsedUrl.protocol === 'https:' ? '443' : '80'));
    const dbPath = path.join(input.globalStoragePath, 'bus-ts.db');
    const configFile = path.join(input.globalStoragePath, 'config.json');

    return {
        command: input.hostNodeExecutable,
        args: [input.serverEntry, 'serve'],
        cwd: input.extensionRoot,
        env: {
            ...(input.processEnv || {}),
            AGENTCHATBUS_HOST: parsedUrl.hostname,
            AGENTCHATBUS_PORT: String(port),
            AGENTCHATBUS_DB: dbPath,
            AGENTCHATBUS_APP_DIR: input.globalStoragePath,
            AGENTCHATBUS_CONFIG_FILE: configFile,
            AGENTCHATBUS_WEB_UI_DIR: input.webUiDir,
            ...(input.cliWorkspacePath
                ? { AGENTCHATBUS_CLI_WORKSPACE: input.cliWorkspacePath }
                : {}),
            AGENTCHATBUS_WAIT_MIN_TIMEOUT_MS: String(input.msgWaitMinTimeoutMs),
            AGENTCHATBUS_ENFORCE_MSG_WAIT_MIN_TIMEOUT: input.enforceMsgWaitMinTimeout ? '1' : '0',
        },
        launchMode: 'bundled-ts-service',
        resolvedBy: BUNDLED_RUNTIME_RESOLVED_BY,
    };
}

export function buildWorkspaceDevLaunchSpec(input: {
    tsxCliEntrypoint: string;
    tsServerRoot: string;
    webUiDir: string;
    globalStoragePath: string;
    hostNodeExecutable: string;
    serverUrl: string;
    cliWorkspacePath?: string;
    msgWaitMinTimeoutMs: number;
    enforceMsgWaitMinTimeout: boolean;
    processEnv?: NodeJS.ProcessEnv;
}): BundledLaunchSpec {
    const parsedUrl = new URL(input.serverUrl);
    const port = Number(parsedUrl.port || (parsedUrl.protocol === 'https:' ? '443' : '80'));
    const dbPath = path.join(input.globalStoragePath, 'bus-ts.db');
    const configFile = path.join(input.globalStoragePath, 'config.json');

    return {
        command: input.hostNodeExecutable,
        args: [input.tsxCliEntrypoint, 'watch', 'src/cli/index.ts', 'serve'],
        cwd: input.tsServerRoot,
        env: {
            ...(input.processEnv || {}),
            AGENTCHATBUS_HOST: parsedUrl.hostname,
            AGENTCHATBUS_PORT: String(port),
            AGENTCHATBUS_DB: dbPath,
            AGENTCHATBUS_APP_DIR: input.globalStoragePath,
            AGENTCHATBUS_CONFIG_FILE: configFile,
            AGENTCHATBUS_WEB_UI_DIR: input.webUiDir,
            ...(input.cliWorkspacePath
                ? { AGENTCHATBUS_CLI_WORKSPACE: input.cliWorkspacePath }
                : {}),
            AGENTCHATBUS_WAIT_MIN_TIMEOUT_MS: String(input.msgWaitMinTimeoutMs),
            AGENTCHATBUS_ENFORCE_MSG_WAIT_MIN_TIMEOUT: input.enforceMsgWaitMinTimeout ? '1' : '0',
            AGENTCHATBUS_RELOAD: '1',
            AGENTCHATBUS_WORKSPACE_DEV: '1',
        },
        launchMode: 'workspace-dev-service',
        resolvedBy: WORKSPACE_DEV_RUNTIME_RESOLVED_BY,
    };
}
