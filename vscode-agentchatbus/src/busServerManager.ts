import * as vscode from 'vscode';
import * as path from 'path';
import * as child_process from 'child_process';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { SetupProvider } from './providers/setupProvider';
import { McpLogProvider } from './providers/mcpLogProvider';
import {
    buildBundledLaunchSpec,
    buildWorkspaceDevLaunchSpec,
    classifyDetectedStartupMode,
    ensureSupportedHostNodeVersion,
    extractOwnershipAssignable,
    normalizeHealthString,
    type BundledLaunchSpec as LaunchSpec,
    type HealthPayload,
    type LaunchMode,
} from './logic/busServerManager';
import {
    resolveWorkspaceDevContext,
    type WorkspaceDevContext,
} from './logic/workspaceDev';

type ServerMetadata = {
    command?: string;
    args?: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    startupMode?: LaunchMode;
    resolvedBy?: string;
    backendEngine?: string;
    backendVersion?: string;
    backendRuntime?: string;
    externalOwnershipAssignable?: boolean | null;
    resolutionAttempts?: string[];
};

type IdeSessionApiState = {
    instance_id?: string | null;
    session_token?: string | null;
    registered?: boolean;
    ownership_assignable?: boolean;
    owner_instance_id?: string | null;
    owner_ide_label?: string | null;
    is_owner?: boolean;
    can_shutdown?: boolean;
    registered_sessions_count?: number;
    shutdown_requested?: boolean;
    transferred_to?: string | null;
    was_owner?: boolean;
};

export class BusServerManager {
    private static readonly MCP_PROVIDER_ID = 'agentchatbus.provider';
    private static readonly MCP_PROVIDER_LABEL = 'AgentChatBus Local Server';
    private static readonly MAX_ATTEMPTS = 40;

    private outputChannel: vscode.OutputChannel;
    private serverProcess: child_process.ChildProcess | null = null;
    private setupProvider: SetupProvider | null = null;
    private mcpLogProvider: McpLogProvider | null = null;
    private readonly mcpDefinitionsChanged = new vscode.EventEmitter<void>();
    private mcpProviderRegistered = false;
    private externalLogPoller: NodeJS.Timeout | null = null;
    private externalLogCursor = 0;
    private serverStopping = false;
    private lastStopFailureMessage: string | null = null;
    private ideHeartbeatPoller: NodeJS.Timeout | null = null;
    private readonly ideInstanceId = randomUUID();
    private readonly ideLabel = vscode.env.appName || 'VS Code';
    private readonly extensionRoot: string;
    private readonly globalStoragePath: string;
    private readonly hostNodeExecutable: string;
    private readonly extensionVersion: string;
    private ideSessionToken: string | null = null;
    private ownerBootToken: string | null = null;
    private ideSessionState: IdeSessionApiState = {
        registered: false,
        ownership_assignable: false,
        is_owner: false,
        can_shutdown: false,
        registered_sessions_count: 0,
    };
    private lastStartTime: Date | null = null;
    private serverMetadata: ServerMetadata = { resolutionAttempts: [] };

    constructor(context: vscode.ExtensionContext) {
        this.extensionRoot = context.extensionPath;
        this.globalStoragePath = context.globalStorageUri.fsPath;
        this.hostNodeExecutable = process.execPath;
        this.extensionVersion = String(context.extension.packageJSON?.version || 'unknown');
        this.outputChannel = vscode.window.createOutputChannel('AgentChatBus Server');
        void vscode.commands.executeCommand('setContext', 'agentchatbus:serverStopping', false);
        this.updateRestartContexts();
    }

    setSetupProvider(provider: SetupProvider) {
        this.setupProvider = provider;
    }

    setMcpLogProvider(provider: McpLogProvider) {
        this.mcpLogProvider = provider;
    }

    log(message: string, icon?: string, description?: string) {
        console.log(`[AgentChatBus Log] ${message}`);
        this.outputChannel.appendLine(`[AgentChatBus] ${message}`);
        if (this.setupProvider) {
            this.setupProvider.addLog(message, icon, description);
        }
        if (this.mcpLogProvider) {
            this.mcpLogProvider.addLog(`[Extension] ${message}`);
        }
    }

    getLastStopFailureMessage(): string | null {
        return this.lastStopFailureMessage;
    }

    private setLastStopFailureMessage(message: string | null): void {
        this.lastStopFailureMessage = message;
    }

    private resetResolutionAttempts(): void {
        this.serverMetadata.resolutionAttempts = [];
    }

    getWorkspaceDevContext(): WorkspaceDevContext | null {
        const workspaceFolders = vscode.workspace.workspaceFolders || [];
        const candidateRoots = workspaceFolders
            .filter((folder) => folder.uri.scheme === 'file')
            .map((folder) => folder.uri.fsPath);
        return resolveWorkspaceDevContext(candidateRoots);
    }

    getRestartActionMode(): 'force-restart' | 'restart-workspace-dev' | 'switch-to-workspace-dev' {
        const workspaceDevContext = this.getWorkspaceDevContext();
        if (!workspaceDevContext) {
            return 'force-restart';
        }
        if (this.serverMetadata.startupMode === 'workspace-dev-service') {
            return 'restart-workspace-dev';
        }
        if (
            this.isExternalStartupMode(this.serverMetadata.startupMode)
            && this.isLoopbackServerUrl(this.getServerUrl())
        ) {
            return 'switch-to-workspace-dev';
        }
        return 'force-restart';
    }

    getRestartActionMessages(): {
        mode: 'force-restart' | 'restart-workspace-dev' | 'switch-to-workspace-dev';
        confirmLabel: string;
        confirmMessage: string;
        pendingMessage: string;
        failureMessage: string;
    } {
        const mode = this.getRestartActionMode();
        if (mode === 'switch-to-workspace-dev') {
            return {
                mode,
                confirmLabel: 'Switch to Managed Dev Service',
                confirmMessage:
                    'This workspace is AgentChatBus development mode. Switch from the current external/local test service back to the extension-managed workspace-dev service?',
                pendingMessage:
                    'Switching from external service to the extension-managed workspace-dev service is already in progress.',
                failureMessage:
                    'Failed to switch back to the extension-managed workspace-dev service.',
            };
        }
        if (mode === 'restart-workspace-dev') {
            return {
                mode,
                confirmLabel: 'Restart Managed Dev Service',
                confirmMessage:
                    'This workspace is AgentChatBus development mode. Restart the extension-managed workspace-dev service and keep using local agentchatbus-ts + local web-ui?',
                pendingMessage:
                    'Workspace-dev service restart is already in progress.',
                failureMessage:
                    'Failed to restart the extension-managed workspace-dev service.',
            };
        }
        return {
            mode,
            confirmLabel: 'Force Restart',
            confirmMessage:
                'Force restart AgentChatBus Server? This will force the current MCP process down and immediately start a fresh one.',
            pendingMessage:
                'Force restart is already in progress. Waiting for shutdown verification, kill fallback, or fresh startup.',
            failureMessage:
                'No extension-managed MCP service could be force stopped.',
        };
    }

    private recordResolutionAttempt(message: string): void {
        const attempts = this.serverMetadata.resolutionAttempts || [];
        attempts.push(message);
        if (attempts.length > BusServerManager.MAX_ATTEMPTS) {
            attempts.shift();
        }
        this.serverMetadata.resolutionAttempts = attempts;
        this.log(message, 'search');
    }

    private updateRestartContexts(): void {
        const restartMode = this.getRestartActionMode();
        void vscode.commands.executeCommand(
            'setContext',
            'agentchatbus:workspaceDevSwitchableExternal',
            restartMode === 'switch-to-workspace-dev'
        );
        void vscode.commands.executeCommand(
            'setContext',
            'agentchatbus:workspaceDevManaged',
            restartMode === 'restart-workspace-dev'
        );
    }

    async ensureServerRunning(): Promise<boolean> {
        const workspaceDevContext = this.getWorkspaceDevContext();
        if (workspaceDevContext) {
            this.log(
                `Workspace-dev detected. Using local agentchatbus-ts + local web-ui from ${workspaceDevContext.repoRoot}. Auto-reload enabled for dev sources.`,
                'tools'
            );
        }
        this.log('Initialization sequence started.', 'info');

        const config = vscode.workspace.getConfiguration('agentchatbus');
        const autoStart = config.get<boolean>('autoStartBusServer', true);
        const serverUrl = config.get<string>('serverUrl', 'http://127.0.0.1:39765');

        if (!autoStart) {
            this.log('Auto-start is disabled in settings.', 'info');
            return true;
        }

        this.log(`Probing server at ${serverUrl}...`, 'sync~spin');

        try {
            const probe = await this.probeServer(serverUrl);
            if (probe.ok) {
                const startupMode = classifyDetectedStartupMode(probe.health);
                this.serverMetadata.startupMode = startupMode;
                this.serverMetadata.resolvedBy = 'Existing service detected via /health';
                this.serverMetadata.backendEngine = normalizeHealthString(probe.health?.engine);
                this.serverMetadata.backendVersion = normalizeHealthString(probe.health?.version);
                this.serverMetadata.backendRuntime = normalizeHealthString(probe.health?.runtime);
                this.serverMetadata.externalOwnershipAssignable =
                    extractOwnershipAssignable(probe.health);
                this.ownerBootToken = null;
                this.recordResolutionAttempt(
                    `Detected an already-running AgentChatBus service via /health probe (mode=${startupMode}).`
                );
                if (this.serverMetadata.backendEngine || this.serverMetadata.backendVersion) {
                    this.recordResolutionAttempt(
                        `External backend details: engine=${this.serverMetadata.backendEngine || 'unknown'}, version=${this.serverMetadata.backendVersion || 'unknown'}.`
                    );
                }
                if (
                    workspaceDevContext
                    && startupMode !== 'workspace-dev-service'
                    && this.isLoopbackServerUrl(serverUrl)
                ) {
                    this.log(
                        `Workspace-dev requested. Existing local service at ${serverUrl} is mode=${startupMode}. Restarting into workspace-dev runtime...`,
                        'sync~spin'
                    );
                    return this.stopServer();
                }
                if (startupMode === 'workspace-dev-service') {
                    this.log('Workspace-dev service detected. Switching to shared log API.', 'warning');
                } else {
                    this.log('Server detected (Managed Externally). Switching to shared log API.', 'warning');
                }
                this.updateRestartContexts();
                this.startExternalLogPolling(serverUrl);
                await this.ensureIdeSessionRegistered(false);
                this.setServerReady(true);
                return true;
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.log(`Probe failed: ${message}`, 'warning');
        }

        this.log('Server not responding. Attempting to start...', 'search');
        const started = await this.startServer();
        if (started) {
            this.setServerReady(true);
            return true;
        }

        this.log('Failed to start AgentChatBus server.', 'error');
        return false;
    }

    async restartServer(): Promise<boolean> {
        if (this.serverStopping) {
            this.log('Restart denied because a force-stop operation is currently in progress.', 'warning');
            return false;
        }
        if (this.mcpLogProvider) {
            this.mcpLogProvider.clear();
            this.mcpLogProvider.setIsManaged(false);
            this.mcpLogProvider.setStatusMessage('Restarting MCP service. Waiting for fresh logs...');
        }
        this.log('Force restart initiated. Log panel was cleared for a fresh startup session.', 'sync~spin');

        if (this.ideSessionState.registered && !this.ideSessionState.can_shutdown) {
            this.log('Restart denied because this IDE session does not currently hold shutdown ownership.', 'warning');
            return false;
        }

        if (!this.serverProcess && this.isExternalStartupMode(this.serverMetadata.startupMode)) {
            const stopped = await this.stopExternalService();
            if (!stopped) {
                return false;
            }
        }

        if (this.serverProcess) {
            if (process.platform === 'win32' && this.serverProcess.pid) {
                try {
                    child_process.execSync(`taskkill /pid ${this.serverProcess.pid} /f /t`);
                } catch {
                    this.serverProcess.kill();
                }
            } else {
                this.serverProcess.kill();
            }
            this.serverProcess = null;
        }
        this.setServerReady(false);
        this.stopExternalLogPolling();
        this.stopIdeHeartbeat();
        this.ideSessionToken = null;
        if (this.mcpLogProvider) {
            this.mcpLogProvider.setIsManaged(false);
        }

        await new Promise(resolve => setTimeout(resolve, 1000));

        const started = await this.startServer();
        if (started) {
            this.setServerReady(true);
            return true;
        }
        return false;
    }

    async stopServer(): Promise<boolean> {
        this.log('Force restart requested...', 'debug-stop');
        this.setLastStopFailureMessage(null);

        if (this.serverStopping) {
            const message = 'Force restart is already in progress.';
            this.setLastStopFailureMessage(message);
            this.log(message, 'warning');
            return false;
        }

        this.setServerStopping(true);
        let success = false;
        try {
            if (this.mcpLogProvider) {
                this.mcpLogProvider.clear();
                this.mcpLogProvider.setIsManaged(false);
                this.mcpLogProvider.setStatusMessage('Force restarting MCP service. Stopping current process...');
            }

            const pidBeforeShutdown = await this.resolveServerPid();
            if (pidBeforeShutdown) {
                this.log(`Resolved target PID before force restart: ${pidBeforeShutdown}.`, 'info');
            }

            const apiAccepted = await this.requestApiShutdown(true);
            if (apiAccepted) {
                this.log('Force-shutdown API request was accepted. Waiting for server process to exit...', 'debug-stop');
            } else {
                this.log('Force-shutdown API request was not accepted. Falling back to process kill if needed...', 'warning');
            }

            const stoppedByApi = await this.waitForServerShutdown(4000, pidBeforeShutdown);
            if (stoppedByApi) {
                this.handleServerStopped('force-shutdown API', true);
                const restarted = await this.startAfterForceRestart();
                success = restarted;
                return restarted;
            }

            const pid = pidBeforeShutdown ?? await this.resolveServerPid();
            if (!pid) {
                const message = 'Server did not exit after force-shutdown API, and no PID could be resolved for kill fallback.';
                this.setLastStopFailureMessage(message);
                this.log(message, 'error');
                return false;
            }

            this.log(`Server process is still alive after API force-shutdown. Attempting kill fallback for PID ${pid}...`, 'debug-stop');
            const killed = this.forceKillProcess(pid);
            if (!killed) {
                const message = `Kill fallback failed for PID ${pid}.`;
                this.setLastStopFailureMessage(message);
                this.log(message, 'error');
                return false;
            }

            this.log(`Kill signal sent to PID ${pid}. Verifying process exit...`, 'debug-stop');
            const stoppedByKill = await this.waitForServerShutdown(4000, pid);
            if (stoppedByKill) {
                this.handleServerStopped(`kill fallback (PID ${pid})`, true);
                const restarted = await this.startAfterForceRestart();
                success = restarted;
                return restarted;
            }

            const message = `Force restart failed: process ${pid} is still alive after kill fallback.`;
            this.setLastStopFailureMessage(message);
            this.log(message, 'error');
            return false;
        } finally {
            if (!success) {
                this.setServerReady(false);
                this.setServerStopping(false);
            }
        }
    }

    private async stopExternalService(): Promise<boolean> {
        this.setLastStopFailureMessage(null);

        const claimOwner = Boolean(this.ideSessionState.ownership_assignable);
        if (!this.ideSessionToken || !this.ideSessionState.registered) {
            this.log('IDE session is not registered yet. Attempting registration before external shutdown...', 'info');
            const registered = await this.ensureIdeSessionRegistered(claimOwner);
            if (!registered) {
                const message = 'External shutdown aborted because IDE registration could not be established.';
                this.setLastStopFailureMessage(message);
                this.log(message, 'error');
                return false;
            }
        }

        if (!this.ideSessionState.can_shutdown) {
            const ownerId = this.ideSessionState.owner_instance_id || 'none';
            const message = this.ideSessionState.ownership_assignable
                ? `External shutdown denied because this IDE session does not own shutdown rights. Current owner=${ownerId}.`
                : 'External shutdown denied because this service was not started by an owning IDE session.';
            this.setLastStopFailureMessage(message);
            this.log(message, 'warning');
            return false;
        }

        const accepted = await this.requestApiShutdown(false);
        if (!accepted) {
            const message = 'The shutdown API did not accept the external shutdown request.';
            this.setLastStopFailureMessage(message);
            return false;
        }
        return true;
    }

    async handleIdeDeactivate(): Promise<void> {
        await this.unregisterIdeSession();
    }

    private async ensureIdeSessionRegistered(claimOwner: boolean): Promise<boolean> {
        const serverUrl = this.getServerUrl();
        const requestBody = {
            instance_id: this.ideInstanceId,
            ide_label: this.ideLabel,
            claim_owner: claimOwner,
            owner_boot_token: claimOwner ? this.ownerBootToken : null,
        };

        for (let attempt = 1; attempt <= 5; attempt++) {
            try {
                const response = await fetch(`${serverUrl}/api/ide/register`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(requestBody),
                });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                const payload = await response.json() as IdeSessionApiState;
                this.ideSessionToken = payload.session_token || null;
                this.updateIdeSessionState(payload);
                this.startIdeHeartbeat();
                if (payload.is_owner) {
                    this.log(
                        `IDE ownership registration granted. This session now owns MCP shutdown rights (${this.ideInstanceId}).`,
                        'plug'
                    );
                } else if (claimOwner) {
                    this.log(
                        `IDE registration succeeded, but ownership was not granted. Current owner=${payload.owner_instance_id || 'none'}.`,
                        'warning'
                    );
                } else {
                    this.log(
                        `IDE registration succeeded without owner claim. shutdownPermission=${payload.can_shutdown ? 'yes' : 'no'} owner=${payload.owner_instance_id || 'none'}`,
                        'plug'
                    );
                }
                return true;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.log(`IDE registration attempt ${attempt} failed: ${message}`, 'warning');
                await new Promise(resolve => setTimeout(resolve, 400));
            }
        }

        this.updateIdeSessionState({
            registered: false,
            is_owner: false,
            can_shutdown: false,
        });
        this.log('IDE registration failed after all retry attempts.', 'error');
        return false;
    }

    private startIdeHeartbeat(): void {
        if (!this.ideSessionToken || this.ideHeartbeatPoller) {
            return;
        }
        this.ideHeartbeatPoller = setInterval(() => {
            void this.sendIdeHeartbeat();
        }, 15000);
    }

    private stopIdeHeartbeat(): void {
        if (this.ideHeartbeatPoller) {
            clearInterval(this.ideHeartbeatPoller);
            this.ideHeartbeatPoller = null;
        }
    }

    private async sendIdeHeartbeat(): Promise<void> {
        if (!this.ideSessionToken) {
            return;
        }

        try {
            const response = await fetch(`${this.getServerUrl()}/api/ide/heartbeat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    instance_id: this.ideInstanceId,
                    session_token: this.ideSessionToken,
                }),
            });
            if (!response.ok) {
                const detail = await this.readErrorDetail(response);
                throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
            }
            const payload = await response.json() as IdeSessionApiState;
            this.updateIdeSessionState(payload);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.log(`IDE heartbeat failed: ${message}`, 'warning');

            if (message.includes('HTTP 404') || message.includes('HTTP 403')) {
                this.log('IDE session was rejected by the server. Clearing local session token and attempting re-registration...', 'warning');
                this.stopIdeHeartbeat();
                this.ideSessionToken = null;
                this.updateIdeSessionState({
                    registered: false,
                    is_owner: false,
                    can_shutdown: false,
                });

                const shouldClaimOwner = !this.isExternalStartupMode(this.serverMetadata.startupMode)
                    || Boolean(this.ideSessionState.ownership_assignable);
                const recovered = await this.ensureIdeSessionRegistered(shouldClaimOwner);
                if (!recovered) {
                    this.log('IDE heartbeat recovery failed: re-registration was not accepted.', 'error');
                }
            }
        }
    }

    private async readErrorDetail(response: Response): Promise<string> {
        try {
            const payload = await response.json() as { detail?: string | { message?: string } };
            if (typeof payload.detail === 'string') {
                return payload.detail;
            }
            if (payload.detail && typeof payload.detail === 'object' && typeof payload.detail.message === 'string') {
                return payload.detail.message;
            }
        } catch {
            // Ignore non-JSON error payloads.
        }
        return '';
    }

    private async unregisterIdeSession(): Promise<void> {
        this.stopIdeHeartbeat();
        if (!this.ideSessionToken) {
            return;
        }

        try {
            const response = await fetch(`${this.getServerUrl()}/api/ide/unregister`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    instance_id: this.ideInstanceId,
                    session_token: this.ideSessionToken,
                }),
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const payload = await response.json() as IdeSessionApiState;
            this.updateIdeSessionState(payload);
            if (payload.transferred_to) {
                this.log(`Shutdown ownership transferred to IDE session ${payload.transferred_to}.`, 'info');
            }
            if (payload.shutdown_requested) {
                this.log('Server acknowledged last-owner exit and scheduled shutdown.', 'stop-circle');
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.log(`IDE unregister failed during deactivation: ${message}`, 'warning');
        } finally {
            this.ideSessionToken = null;
            this.updateIdeSessionState({
                registered: false,
                is_owner: false,
                can_shutdown: false,
                owner_instance_id: null,
                owner_ide_label: null,
            });
        }
    }

    private updateIdeSessionState(payload: IdeSessionApiState): void {
        const previousOwnerId = this.ideSessionState.owner_instance_id || null;
        const previousCanShutdown = this.ideSessionState.can_shutdown || false;
        const previousIsOwner = this.ideSessionState.is_owner || false;

        this.ideSessionState = {
            ...this.ideSessionState,
            ...payload,
        };

        const currentOwnerId = this.ideSessionState.owner_instance_id || null;
        const currentCanShutdown = this.ideSessionState.can_shutdown || false;
        const currentIsOwner = this.ideSessionState.is_owner || false;

        if (currentOwnerId !== previousOwnerId) {
            this.log(`MCP shutdown owner changed from ${previousOwnerId || 'none'} to ${currentOwnerId || 'none'}.`, 'info');
        }

        if (!previousCanShutdown && currentCanShutdown) {
            this.log('This IDE session now has permission to shut down the MCP service.', 'check');
        } else if (previousCanShutdown && !currentCanShutdown) {
            this.log('This IDE session lost MCP shutdown permission.', 'warning');
        }

        if (!previousIsOwner && currentIsOwner) {
            this.log(`This IDE session is now the active MCP owner (${this.ideInstanceId}).`, 'check');
        }
    }

    private setServerReady(ready: boolean) {
        if (ready) {
            this.setServerStopping(false);
        }
        this.updateRestartContexts();
        void vscode.commands.executeCommand('setContext', 'agentchatbus:serverReady', ready);
    }

    private setServerStopping(stopping: boolean): void {
        this.serverStopping = stopping;
        void vscode.commands.executeCommand('setContext', 'agentchatbus:serverStopping', stopping);
    }

    private async requestApiShutdown(force: boolean): Promise<boolean> {
        const serverUrl = this.getServerUrl();
        const mode = force ? 'force-shutdown' : 'shutdown';
        this.log(`Attempting ${mode} via API at ${serverUrl}/api/shutdown...`, 'debug-stop');

        if (!force && !this.ideSessionToken) {
            this.log(`Cannot call ${mode} API because IDE session token is unavailable.`, 'warning');
            return false;
        }

        try {
            const response = await fetch(`${serverUrl}/api/shutdown`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    instance_id: this.ideInstanceId || '',
                    session_token: this.ideSessionToken || '',
                    force,
                }),
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            this.log(`${mode} API request accepted by server.`, 'debug-stop');
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.log(`${mode} API request failed: ${message}`, 'warning');
            return false;
        }
    }

    private async waitForServerShutdown(timeoutMs: number, pid?: number | null): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        const serverUrl = this.getServerUrl();
        while (Date.now() < deadline) {
            const running = await this.checkServer(serverUrl);
            const processAlive = pid ? this.isProcessAlive(pid) : false;
            if (!running && (!pid || !processAlive)) {
                this.log('Server health check no longer responds and the target process has exited. Shutdown confirmed.', 'check');
                return true;
            }
            if (!running && pid && processAlive) {
                this.log(`Server health check is down, but PID ${pid} is still alive. Continuing shutdown verification...`, 'warning');
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        this.log('Server shutdown verification window expired before full process exit.', 'warning');
        return false;
    }

    private async resolveServerPid(): Promise<number | null> {
        if (this.serverProcess?.pid) {
            this.log(`Using managed child PID ${this.serverProcess.pid} for kill fallback.`, 'info');
            return this.serverProcess.pid;
        }

        try {
            const response = await fetch(`${this.getServerUrl()}/api/system/diagnostics`);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const payload = await response.json() as { pid?: number };
            if (typeof payload.pid === 'number' && Number.isFinite(payload.pid) && payload.pid > 0) {
                this.log(`Resolved external server PID from diagnostics: ${payload.pid}.`, 'info');
                return payload.pid;
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.log(`Failed to resolve server PID from diagnostics: ${message}`, 'warning');
        }
        return null;
    }

    private forceKillProcess(pid: number): boolean {
        try {
            if (process.platform === 'win32') {
                child_process.execFileSync('taskkill', ['/pid', String(pid), '/f', '/t']);
            } else {
                process.kill(pid, 'SIGKILL');
            }
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.log(`OS-level kill failed for PID ${pid}: ${message}`, 'error');
            return false;
        }
    }

    private isProcessAlive(pid: number): boolean {
        try {
            process.kill(pid, 0);
            return true;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EPERM') {
                return true;
            }
            return false;
        }
    }

    private async startAfterForceRestart(): Promise<boolean> {
        this.log('Starting a fresh MCP service after force restart...', 'sync~spin');
        if (this.mcpLogProvider) {
            this.mcpLogProvider.clear();
            this.mcpLogProvider.setStatusMessage('Starting MCP service after force restart...');
        }

        const started = await this.startServer();
        if (started) {
            this.setServerReady(true);
            this.log('Force restart completed successfully.', 'check');
            return true;
        }

        const message = 'Force restart stopped the previous process, but failed to start a new MCP service.';
        this.setLastStopFailureMessage(message);
        this.log(message, 'error');
        return false;
    }

    private handleServerStopped(reason: string, preserveReadyContext = false): void {
        this.setLastStopFailureMessage(null);
        this.serverProcess = null;
        this.stopExternalLogPolling();
        this.stopIdeHeartbeat();
        this.ideSessionToken = null;
        if (!preserveReadyContext) {
            this.setServerReady(false);
        }
        this.mcpLogProvider?.setIsManaged(false);
        void vscode.commands.executeCommand('setContext', 'agentchatbus:mcpServerActive', false);
        this.log(`Force stop completed via ${reason}.`, 'stop-circle');
    }

    private startExternalLogPolling(serverUrl: string): void {
        this.stopExternalLogPolling();
        this.externalLogCursor = 0;
        if (this.mcpLogProvider) {
            this.mcpLogProvider.clear();
            this.mcpLogProvider.setIsManaged(false);
            this.mcpLogProvider.setStatusMessage('Reading logs from shared AgentChatBus API...');
        }

        const normalizedServerUrl = serverUrl.replace(/\/+$/, '');
        const poll = async () => {
            try {
                const response = await fetch(`${normalizedServerUrl}/api/logs?after=${this.externalLogCursor}&limit=200`);
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                const payload = await response.json() as { entries?: Array<{ id: number; line: string }> };
                const entries = payload.entries || [];
                for (const entry of entries) {
                    this.externalLogCursor = Math.max(this.externalLogCursor, entry.id);
                    this.mcpLogProvider?.addLog(entry.line);
                }
                this.mcpLogProvider?.setStatusMessage(entries.length > 0 ? null : 'Connected to shared AgentChatBus log API.');
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.mcpLogProvider?.setStatusMessage(`Shared log API unavailable: ${message}`);
            }
        };

        void poll();
        this.externalLogPoller = setInterval(() => {
            void poll();
        }, 1500);
    }

    private stopExternalLogPolling(): void {
        if (this.externalLogPoller) {
            clearInterval(this.externalLogPoller);
            this.externalLogPoller = null;
        }
        this.externalLogCursor = 0;
        this.mcpLogProvider?.setStatusMessage(null);
    }

    private getServerUrl(): string {
        const config = vscode.workspace.getConfiguration('agentchatbus');
        const rawUrl = config.get<string>('serverUrl', 'http://127.0.0.1:39765');
        return rawUrl.replace(/\/+$/, '');
    }

    notifyMcpDefinitionsChanged() {
        this.mcpDefinitionsChanged.fire();
    }

    private createMcpServerDefinition(): vscode.McpHttpServerDefinition {
        return new vscode.McpHttpServerDefinition(
            BusServerManager.MCP_PROVIDER_LABEL,
            vscode.Uri.parse(`${this.getServerUrl()}/mcp`),
            undefined,
            '1.0.0'
        );
    }

    private async probeServer(url: string): Promise<{ ok: boolean; health?: HealthPayload }> {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 1000);
            const response = await fetch(`${url}/health`, { signal: controller.signal });
            clearTimeout(timeoutId);
            if (!response.ok) {
                return { ok: false };
            }
            let health: HealthPayload | undefined;
            try {
                health = await response.json() as HealthPayload;
            } catch {
                // Allow legacy health endpoints that return non-JSON.
            }
            return { ok: true, health };
        } catch {
            return { ok: false };
        }
    }

    private async checkServer(url: string): Promise<boolean> {
        const probe = await this.probeServer(url);
        return probe.ok;
    }

    private isExternalStartupMode(mode: LaunchMode | undefined): boolean {
        return Boolean(mode && mode.startsWith('external-service'));
    }

    private isLoopbackServerUrl(rawUrl: string): boolean {
        try {
            const parsed = new URL(rawUrl);
            const host = String(parsed.hostname || '').trim().toLowerCase();
            return (
                host === '127.0.0.1'
                || host === 'localhost'
                || host === '::1'
                || host === '::ffff:127.0.0.1'
            );
        } catch {
            return false;
        }
    }

    getStatusMetadata() {
        const serverUrl = this.getServerUrl();
        const lm = this.getLanguageModelNamespace();
        return {
            pid: this.serverProcess?.pid,
            startTime: this.lastStartTime?.toISOString(),
            ...this.serverMetadata,
            platform: process.platform,
            arch: process.arch,
            nodeVersion: process.version,
            hostNodeExecutable: this.hostNodeExecutable,
            extensionVersion: this.extensionVersion,
            vscodeVersion: vscode.version,
            ide: {
                instanceId: this.ideInstanceId,
                label: this.ideLabel,
                registered: this.ideSessionState.registered ?? false,
                isOwner: this.ideSessionState.is_owner ?? false,
                canShutdown: this.ideSessionState.can_shutdown ?? false,
                ownershipAssignable: this.ideSessionState.ownership_assignable ?? false,
                ownerInstanceId: this.ideSessionState.owner_instance_id ?? null,
                ownerLabel: this.ideSessionState.owner_ide_label ?? null,
                registeredSessionsCount: this.ideSessionState.registered_sessions_count ?? 0,
            },
            mcp: {
                apiAvailable: typeof lm?.registerMcpServerDefinitionProvider === 'function',
                providerRegistered: this.mcpProviderRegistered,
                providerId: BusServerManager.MCP_PROVIDER_ID,
                providerLabel: BusServerManager.MCP_PROVIDER_LABEL,
                transport: 'http+sse',
                serverUrl,
                sseEndpoint: `${serverUrl}/mcp`,
                requiredVscodeVersion: '^1.105.0'
            }
        };
    }

    private getLanguageModelNamespace(): { registerMcpServerDefinitionProvider?: typeof vscode.lm.registerMcpServerDefinitionProvider } | undefined {
        return (vscode as unknown as { lm?: typeof vscode.lm }).lm;
    }

    private resolvePreferredCliWorkspace(): string | undefined {
        const activeEditorUri = vscode.window.activeTextEditor?.document?.uri;
        if (activeEditorUri?.scheme === 'file') {
            const activeFolder = vscode.workspace.getWorkspaceFolder(activeEditorUri);
            if (activeFolder?.uri.scheme === 'file') {
                return activeFolder.uri.fsPath;
            }
        }

        const workspaceFolders = vscode.workspace.workspaceFolders || [];
        const firstFileWorkspace = workspaceFolders.find((folder) => folder.uri.scheme === 'file');
        return firstFileWorkspace?.uri.fsPath;
    }

    private async startServer(): Promise<boolean> {
        this.resetResolutionAttempts();
        const workspaceDevContext = this.getWorkspaceDevContext();
        if (workspaceDevContext) {
            this.log(
                `Workspace-dev detected. Using local agentchatbus-ts + local web-ui from ${workspaceDevContext.repoRoot}. Auto-reload enabled for dev sources.`,
                'tools'
            );
        }
        const launchSpec = await this.resolveLaunchSpec();
        if (!launchSpec) {
            this.log('AgentChatBus runtime could not be resolved for startup.', 'error');
            return false;
        }
        return this.spawnServer(launchSpec);
    }

    private async resolveLaunchSpec(): Promise<LaunchSpec | null> {
        const workspaceDevContext = this.getWorkspaceDevContext();
        if (workspaceDevContext) {
            this.log('Preparing workspace-dev AgentChatBus TS runtime...', 'search');
            const workspaceDevSpec = await this.resolveWorkspaceDevLaunchSpec(workspaceDevContext);
            if (workspaceDevSpec) {
                return workspaceDevSpec;
            }
            this.log('Workspace-dev runtime could not be resolved. Falling back to bundled runtime...', 'warning');
        } else {
            this.log('Preparing bundled AgentChatBus TS runtime...', 'search');
        }
        return this.resolveBundledLaunchSpec();
    }

    private async resolveBundledLaunchSpec(): Promise<LaunchSpec | null> {
        const serverEntry = path.join(this.extensionRoot, 'resources', 'bundled-server', 'dist', 'cli', 'index.js');
        const webUiDir = path.join(this.extensionRoot, 'resources', 'web-ui');
        const hostNodeVersionCheck = ensureSupportedHostNodeVersion(process.version);

        if (!fs.existsSync(serverEntry)) {
            this.recordResolutionAttempt(`Bundled TS entrypoint is missing: ${serverEntry}`);
            return null;
        }

        if (!fs.existsSync(webUiDir)) {
            this.recordResolutionAttempt(`Bundled web-ui assets are missing: ${webUiDir}`);
            return null;
        }

        if (!hostNodeVersionCheck.ok) {
            this.recordResolutionAttempt(hostNodeVersionCheck.message);
            this.log(hostNodeVersionCheck.message, 'error');
            return null;
        }

        await fs.promises.mkdir(this.globalStoragePath, { recursive: true });

        const serverUrl = this.getServerUrl();
        const config = vscode.workspace.getConfiguration('agentchatbus');
        const cliWorkspacePath = this.resolvePreferredCliWorkspace();
        const msgWaitMinTimeoutMs = Math.max(0, Math.floor(config.get<number>('msgWaitMinTimeoutMs', 60000)));
        const enforceMsgWaitMinTimeout = Boolean(config.get<boolean>('enforceMsgWaitMinTimeout', false));
        const parsedUrl = new URL(serverUrl);
        const port = Number(parsedUrl.port || (parsedUrl.protocol === 'https:' ? '443' : '80'));
        const dbPath = path.join(this.globalStoragePath, 'bus-ts.db');
        const configFile = path.join(this.globalStoragePath, 'config.json');

        this.recordResolutionAttempt(`Resolved bundled TS entrypoint: ${serverEntry}`);
        this.recordResolutionAttempt(`Using extension storage for TS runtime data: ${this.globalStoragePath}`);
        this.recordResolutionAttempt(
            `Using IDE host Node runtime ${process.version} from ${this.hostNodeExecutable} to launch bundled MCP.`
        );
        if (cliWorkspacePath) {
            this.recordResolutionAttempt(`Using VS Code workspace as CLI working root: ${cliWorkspacePath}`);
        } else {
            this.recordResolutionAttempt('No file-based VS Code workspace detected for CLI working root; backend fallback will be used.');
        }

        return buildBundledLaunchSpec({
            serverEntry,
            webUiDir,
            extensionRoot: this.extensionRoot,
            globalStoragePath: this.globalStoragePath,
            hostNodeExecutable: this.hostNodeExecutable,
            serverUrl,
            cliWorkspacePath,
            msgWaitMinTimeoutMs,
            enforceMsgWaitMinTimeout,
            processEnv: process.env,
        });
    }

    private async resolveWorkspaceDevLaunchSpec(
        workspaceDevContext: WorkspaceDevContext
    ): Promise<LaunchSpec | null> {
        const hostNodeVersionCheck = ensureSupportedHostNodeVersion(process.version);
        if (!hostNodeVersionCheck.ok) {
            this.recordResolutionAttempt(hostNodeVersionCheck.message);
            this.log(hostNodeVersionCheck.message, 'error');
            return null;
        }

        if (!fs.existsSync(workspaceDevContext.tsxCliEntrypoint)) {
            this.recordResolutionAttempt(
                `Workspace-dev tsx CLI is missing: ${workspaceDevContext.tsxCliEntrypoint}`
            );
            return null;
        }

        if (!fs.existsSync(path.join(workspaceDevContext.webUiRoot, 'index.html'))) {
            this.recordResolutionAttempt(
                `Workspace-dev web-ui assets are missing: ${workspaceDevContext.webUiRoot}`
            );
            return null;
        }

        await fs.promises.mkdir(this.globalStoragePath, { recursive: true });

        const serverUrl = this.getServerUrl();
        const config = vscode.workspace.getConfiguration('agentchatbus');
        const cliWorkspacePath = this.resolvePreferredCliWorkspace();
        const msgWaitMinTimeoutMs = Math.max(0, Math.floor(config.get<number>('msgWaitMinTimeoutMs', 60000)));
        const enforceMsgWaitMinTimeout = Boolean(config.get<boolean>('enforceMsgWaitMinTimeout', false));

        this.recordResolutionAttempt(`Resolved workspace-dev repo root: ${workspaceDevContext.repoRoot}`);
        this.recordResolutionAttempt(`Resolved workspace-dev tsx CLI: ${workspaceDevContext.tsxCliEntrypoint}`);
        this.recordResolutionAttempt(`Resolved workspace-dev web-ui: ${workspaceDevContext.webUiRoot}`);
        this.recordResolutionAttempt(`Using extension storage for TS runtime data: ${this.globalStoragePath}`);
        this.recordResolutionAttempt(
            `Using IDE host Node runtime ${process.version} from ${this.hostNodeExecutable} to launch workspace-dev MCP.`
        );
        if (cliWorkspacePath) {
            this.recordResolutionAttempt(`Using VS Code workspace as CLI working root: ${cliWorkspacePath}`);
        } else {
            this.recordResolutionAttempt('No file-based VS Code workspace detected for CLI working root; backend fallback will be used.');
        }

        return buildWorkspaceDevLaunchSpec({
            tsxCliEntrypoint: workspaceDevContext.tsxCliEntrypoint,
            tsServerRoot: workspaceDevContext.tsServerRoot,
            webUiDir: workspaceDevContext.webUiRoot,
            globalStoragePath: this.globalStoragePath,
            hostNodeExecutable: this.hostNodeExecutable,
            serverUrl,
            cliWorkspacePath,
            msgWaitMinTimeoutMs,
            enforceMsgWaitMinTimeout,
            processEnv: process.env,
        });
    }

    private async spawnServer(spec: LaunchSpec): Promise<boolean> {
        this.ownerBootToken = randomUUID();
        const env = {
            ...process.env,
            ...(spec.env || {}),
            AGENTCHATBUS_OWNER_BOOT_TOKEN: this.ownerBootToken,
            ...(spec.env?.AGENTCHATBUS_RELOAD ? {} : { AGENTCHATBUS_RELOAD: '0' }),
        };
        this.serverMetadata = {
            command: spec.command,
            args: spec.args,
            cwd: spec.cwd,
            env,
            startupMode: spec.launchMode,
            resolvedBy: spec.resolvedBy,
            backendEngine: 'node',
            backendVersion: undefined,
            backendRuntime: `node ${process.version}`,
            externalOwnershipAssignable: null,
            resolutionAttempts: [...(this.serverMetadata.resolutionAttempts || [])],
        };
        this.updateRestartContexts();
        this.lastStartTime = new Date();
        this.stopExternalLogPolling();

        this.log(`Starting server process using ${spec.launchMode}.`, 'play');
        this.log(`Exec: ${spec.command} ${spec.args.join(' ')}`.trim(), 'terminal');
        this.log(`Resolution: ${spec.resolvedBy}`, 'info');

        try {
            this.serverProcess = child_process.spawn(spec.command, spec.args, {
                cwd: spec.cwd || process.cwd(),
                env,
                shell: false,
            });

            void vscode.commands.executeCommand('setContext', 'agentchatbus:mcpServerActive', true);
            if (this.mcpLogProvider) {
                this.mcpLogProvider.setIsManaged(true);
                this.mcpLogProvider.setStatusMessage(null);
            }

            this.serverProcess.stdout?.on('data', data => {
                const text = data.toString();
                this.outputChannel.append(text);
                this.mcpLogProvider?.addLog(text);
            });

            this.serverProcess.stderr?.on('data', data => {
                const text = data.toString();
                this.outputChannel.append(text);
                this.mcpLogProvider?.addLog(text);
            });

            this.serverProcess.on('error', err => {
                this.log(`Spawn error: ${err.message}`, 'error');
            });

            this.serverProcess.on('close', (code, signal) => {
                const exitDetail = signal
                    ? `signal ${signal}`
                    : `code ${code ?? 'unknown'}`;
                this.log(`Server exited (${exitDetail}). Check "MCP Server Logs" for startup details.`, 'warning');
                this.serverProcess = null;
                this.setServerReady(false);
                void vscode.commands.executeCommand('setContext', 'agentchatbus:mcpServerActive', false);
                this.mcpLogProvider?.setIsManaged(false);
            });

            this.log('Waiting for health check response...', 'sync~spin');
            const serverUrl = this.getServerUrl();
            let retries = 20;
            while (retries > 0) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                if (await this.checkServer(serverUrl)) {
                    this.log('Server is online and ready.', 'check');
                    await this.ensureIdeSessionRegistered(true);
                    return true;
                }
                retries--;
            }

            this.log('Server failed to respond to health checks. Review the MCP Server Logs panel for startup stderr/stdout.', 'error');
            return false;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.log(`Fatal spawn error: ${message}`, 'error');
            return false;
        }
    }

    async registerMcpProvider(context: vscode.ExtensionContext): Promise<void> {
        const lm = this.getLanguageModelNamespace();
        if (!lm?.registerMcpServerDefinitionProvider) {
            this.log('VS Code MCP provider API is unavailable in this editor build.', 'warning');
            return;
        }

        const provider: vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition> = {
            onDidChangeMcpServerDefinitions: this.mcpDefinitionsChanged.event,
            provideMcpServerDefinitions: () => [this.createMcpServerDefinition()],
            resolveMcpServerDefinition: async () => {
                const isReady = await this.ensureServerRunning();
                if (!isReady) {
                    throw new Error('AgentChatBus server could not be started.');
                }
                return this.createMcpServerDefinition();
            },
        };

        context.subscriptions.push(this.mcpDefinitionsChanged);
        context.subscriptions.push(lm.registerMcpServerDefinitionProvider(BusServerManager.MCP_PROVIDER_ID, provider));
        this.mcpProviderRegistered = true;
        this.log('Registered AgentChatBus MCP definition provider.', 'plug');
    }

    dispose() {
        this.stopExternalLogPolling();
        this.stopIdeHeartbeat();
        this.outputChannel.dispose();
    }
}
