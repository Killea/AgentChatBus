import * as path from 'path';

export type LaunchMode =
    | 'bundled-ts-service'
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
    management?: {
        ownership_assignable?: boolean;
        owner_instance_id?: string | null;
        registered_sessions_count?: number;
    };
};

export const MIN_HOST_NODE_VERSION = {
    major: 20,
    minor: 0,
    patch: 0,
};

export const BUNDLED_RUNTIME_RESOLVED_BY =
    'Bundled agentchatbus-ts runtime packaged with the VS Code extension.';

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
