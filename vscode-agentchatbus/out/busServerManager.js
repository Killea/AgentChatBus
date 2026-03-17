"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.BusServerManager = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const child_process = __importStar(require("child_process"));
const fs = __importStar(require("fs"));
const crypto_1 = require("crypto");
const util_1 = require("util");
const execFileAsync = (0, util_1.promisify)(child_process.execFile);
class BusServerManager {
    static MCP_PROVIDER_ID = 'agentchatbus.provider';
    static MCP_PROVIDER_LABEL = 'AgentChatBus Local Server';
    static MAX_ATTEMPTS = 40;
    outputChannel;
    serverProcess = null;
    setupProvider = null;
    mcpLogProvider = null;
    mcpDefinitionsChanged = new vscode.EventEmitter();
    mcpProviderRegistered = false;
    externalLogPoller = null;
    externalLogCursor = 0;
    serverStopping = false;
    lastStopFailureMessage = null;
    ideHeartbeatPoller = null;
    ideInstanceId = (0, crypto_1.randomUUID)();
    ideLabel = vscode.env.appName || 'VS Code';
    ideSessionToken = null;
    ownerBootToken = null;
    ideSessionState = {
        registered: false,
        ownership_assignable: false,
        is_owner: false,
        can_shutdown: false,
        registered_sessions_count: 0,
    };
    lastStartTime = null;
    serverMetadata = { resolutionAttempts: [] };
    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('AgentChatBus Server');
        void vscode.commands.executeCommand('setContext', 'agentchatbus:serverStopping', false);
    }
    setSetupProvider(provider) {
        this.setupProvider = provider;
    }
    setMcpLogProvider(provider) {
        this.mcpLogProvider = provider;
    }
    log(message, icon, description) {
        console.log(`[AgentChatBus Log] ${message}`);
        this.outputChannel.appendLine(`[AgentChatBus] ${message}`);
        if (this.setupProvider) {
            this.setupProvider.addLog(message, icon, description);
        }
        if (this.mcpLogProvider) {
            this.mcpLogProvider.addLog(`[Extension] ${message}`);
        }
    }
    getLastStopFailureMessage() {
        return this.lastStopFailureMessage;
    }
    setLastStopFailureMessage(message) {
        this.lastStopFailureMessage = message;
    }
    resetResolutionAttempts() {
        this.serverMetadata.resolutionAttempts = [];
    }
    recordResolutionAttempt(message) {
        const attempts = this.serverMetadata.resolutionAttempts || [];
        attempts.push(message);
        if (attempts.length > BusServerManager.MAX_ATTEMPTS) {
            attempts.shift();
        }
        this.serverMetadata.resolutionAttempts = attempts;
        this.log(message, 'search');
    }
    async ensureServerRunning() {
        this.log('Initialization sequence started.', 'info');
        const config = vscode.workspace.getConfiguration('agentchatbus');
        const autoStart = config.get('autoStartBusServer', true);
        const serverUrl = config.get('serverUrl', 'http://127.0.0.1:39765');
        if (!autoStart) {
            this.log('Auto-start is disabled in settings.', 'info');
            return true;
        }
        this.log(`Probing server at ${serverUrl}...`, 'sync~spin');
        try {
            const isRunning = await this.checkServer(serverUrl);
            if (isRunning) {
                this.serverMetadata.startupMode = 'external-service';
                this.serverMetadata.resolvedBy = 'Existing service detected via /health';
                this.ownerBootToken = null;
                this.recordResolutionAttempt('Detected an already-running AgentChatBus service via /health probe.');
                this.log('Server detected (Managed Externally). Switching to shared log API.', 'warning');
                this.startExternalLogPolling(serverUrl);
                await this.ensureIdeSessionRegistered(false);
                this.setServerReady(true);
                return true;
            }
        }
        catch (error) {
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
    async restartServer() {
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
        if (!this.serverProcess && this.serverMetadata.startupMode === 'external-service') {
            const stopped = await this.stopExternalService();
            if (!stopped) {
                return false;
            }
        }
        if (this.serverProcess) {
            if (process.platform === 'win32' && this.serverProcess.pid) {
                try {
                    child_process.execSync(`taskkill /pid ${this.serverProcess.pid} /f /t`);
                }
                catch {
                    this.serverProcess.kill();
                }
            }
            else {
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
    async stopServer() {
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
            }
            else {
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
        }
        finally {
            if (!success) {
                this.setServerReady(false);
                this.setServerStopping(false);
            }
        }
    }
    async stopExternalService() {
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
    async handleIdeDeactivate() {
        await this.unregisterIdeSession();
    }
    async ensureIdeSessionRegistered(claimOwner) {
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
                const payload = await response.json();
                this.ideSessionToken = payload.session_token || null;
                this.updateIdeSessionState(payload);
                this.startIdeHeartbeat();
                if (payload.is_owner) {
                    this.log(`IDE ownership registration granted. This session now owns MCP shutdown rights (${this.ideInstanceId}).`, 'plug');
                }
                else if (claimOwner) {
                    this.log(`IDE registration succeeded, but ownership was not granted. Current owner=${payload.owner_instance_id || 'none'}.`, 'warning');
                }
                else {
                    this.log(`IDE registration succeeded without owner claim. shutdownPermission=${payload.can_shutdown ? 'yes' : 'no'} owner=${payload.owner_instance_id || 'none'}`, 'plug');
                }
                return true;
            }
            catch (error) {
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
    startIdeHeartbeat() {
        if (!this.ideSessionToken || this.ideHeartbeatPoller) {
            return;
        }
        this.ideHeartbeatPoller = setInterval(() => {
            void this.sendIdeHeartbeat();
        }, 15000);
    }
    stopIdeHeartbeat() {
        if (this.ideHeartbeatPoller) {
            clearInterval(this.ideHeartbeatPoller);
            this.ideHeartbeatPoller = null;
        }
    }
    async sendIdeHeartbeat() {
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
            const payload = await response.json();
            this.updateIdeSessionState(payload);
        }
        catch (error) {
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
                const shouldClaimOwner = this.serverMetadata.startupMode !== 'external-service'
                    || Boolean(this.ideSessionState.ownership_assignable);
                const recovered = await this.ensureIdeSessionRegistered(shouldClaimOwner);
                if (!recovered) {
                    this.log('IDE heartbeat recovery failed: re-registration was not accepted.', 'error');
                }
            }
        }
    }
    async readErrorDetail(response) {
        try {
            const payload = await response.json();
            if (typeof payload.detail === 'string') {
                return payload.detail;
            }
            if (payload.detail && typeof payload.detail === 'object' && typeof payload.detail.message === 'string') {
                return payload.detail.message;
            }
        }
        catch {
            // Ignore non-JSON error payloads.
        }
        return '';
    }
    async unregisterIdeSession() {
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
            const payload = await response.json();
            this.updateIdeSessionState(payload);
            if (payload.transferred_to) {
                this.log(`Shutdown ownership transferred to IDE session ${payload.transferred_to}.`, 'info');
            }
            if (payload.shutdown_requested) {
                this.log('Server acknowledged last-owner exit and scheduled shutdown.', 'stop-circle');
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.log(`IDE unregister failed during deactivation: ${message}`, 'warning');
        }
        finally {
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
    updateIdeSessionState(payload) {
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
        }
        else if (previousCanShutdown && !currentCanShutdown) {
            this.log('This IDE session lost MCP shutdown permission.', 'warning');
        }
        if (!previousIsOwner && currentIsOwner) {
            this.log(`This IDE session is now the active MCP owner (${this.ideInstanceId}).`, 'check');
        }
    }
    setServerReady(ready) {
        if (ready) {
            this.setServerStopping(false);
        }
        void vscode.commands.executeCommand('setContext', 'agentchatbus:serverReady', ready);
    }
    setServerStopping(stopping) {
        this.serverStopping = stopping;
        void vscode.commands.executeCommand('setContext', 'agentchatbus:serverStopping', stopping);
    }
    async requestApiShutdown(force) {
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
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.log(`${mode} API request failed: ${message}`, 'warning');
            return false;
        }
    }
    async waitForServerShutdown(timeoutMs, pid) {
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
    async resolveServerPid() {
        if (this.serverProcess?.pid) {
            this.log(`Using managed child PID ${this.serverProcess.pid} for kill fallback.`, 'info');
            return this.serverProcess.pid;
        }
        try {
            const response = await fetch(`${this.getServerUrl()}/api/system/diagnostics`);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const payload = await response.json();
            if (typeof payload.pid === 'number' && Number.isFinite(payload.pid) && payload.pid > 0) {
                this.log(`Resolved external server PID from diagnostics: ${payload.pid}.`, 'info');
                return payload.pid;
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.log(`Failed to resolve server PID from diagnostics: ${message}`, 'warning');
        }
        return null;
    }
    forceKillProcess(pid) {
        try {
            if (process.platform === 'win32') {
                child_process.execFileSync('taskkill', ['/pid', String(pid), '/f', '/t']);
            }
            else {
                process.kill(pid, 'SIGKILL');
            }
            return true;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.log(`OS-level kill failed for PID ${pid}: ${message}`, 'error');
            return false;
        }
    }
    isProcessAlive(pid) {
        try {
            process.kill(pid, 0);
            return true;
        }
        catch (error) {
            const code = error.code;
            if (code === 'EPERM') {
                return true;
            }
            return false;
        }
    }
    async startAfterForceRestart() {
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
    handleServerStopped(reason, preserveReadyContext = false) {
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
    startExternalLogPolling(serverUrl) {
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
                const payload = await response.json();
                const entries = payload.entries || [];
                for (const entry of entries) {
                    this.externalLogCursor = Math.max(this.externalLogCursor, entry.id);
                    this.mcpLogProvider?.addLog(entry.line);
                }
                this.mcpLogProvider?.setStatusMessage(entries.length > 0 ? null : 'Connected to shared AgentChatBus log API.');
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.mcpLogProvider?.setStatusMessage(`Shared log API unavailable: ${message}`);
            }
        };
        void poll();
        this.externalLogPoller = setInterval(() => {
            void poll();
        }, 1500);
    }
    stopExternalLogPolling() {
        if (this.externalLogPoller) {
            clearInterval(this.externalLogPoller);
            this.externalLogPoller = null;
        }
        this.externalLogCursor = 0;
        this.mcpLogProvider?.setStatusMessage(null);
    }
    getServerUrl() {
        const config = vscode.workspace.getConfiguration('agentchatbus');
        const rawUrl = config.get('serverUrl', 'http://127.0.0.1:39765');
        return rawUrl.replace(/\/+$/, '');
    }
    notifyMcpDefinitionsChanged() {
        this.mcpDefinitionsChanged.fire();
    }
    createMcpServerDefinition() {
        return new vscode.McpHttpServerDefinition(BusServerManager.MCP_PROVIDER_LABEL, vscode.Uri.parse(`${this.getServerUrl()}/mcp/sse`), undefined, '1.0.0');
    }
    async checkServer(url) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 1000);
            const response = await fetch(`${url}/health`, { signal: controller.signal });
            clearTimeout(timeoutId);
            return response.ok;
        }
        catch {
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
                sseEndpoint: `${serverUrl}/mcp/sse`,
                requiredVscodeVersion: '^1.105.0'
            }
        };
    }
    getLanguageModelNamespace() {
        return vscode.lm;
    }
    async startServer() {
        this.resetResolutionAttempts();
        this.log('Scanning environment for AgentChatBus startup candidates...', 'search');
        const projectRoot = await this.findProjectRootAsync();
        if (projectRoot) {
            this.recordResolutionAttempt(`Recognized AgentChatBus source workspace at ${projectRoot}.`);
            const sourceSpec = await this.resolveWorkspaceLaunchSpec(projectRoot);
            if (sourceSpec) {
                return this.spawnServer(sourceSpec);
            }
        }
        else {
            this.recordResolutionAttempt('No AgentChatBus source workspace detected. Forcing pip/package resolution path.');
        }
        let installedSpec = await this.resolveInstalledLaunchSpec();
        if (!installedSpec) {
            this.log('Packaged AgentChatBus was not found. Attempting pip installation...', 'cloud-download');
            const installed = await this.installAgentChatBus();
            if (!installed) {
                this.log('pip installation attempts did not succeed.', 'error');
                return false;
            }
            installedSpec = await this.resolveInstalledLaunchSpec(installed);
        }
        if (!installedSpec) {
            this.log('AgentChatBus installation completed, but no runnable command or module could be resolved.', 'error');
            return false;
        }
        return this.spawnServer(installedSpec);
    }
    async resolveWorkspaceLaunchSpec(projectRoot) {
        const config = vscode.workspace.getConfiguration('agentchatbus');
        const configuredPython = config.get('pythonPath', 'python');
        const launchers = this.getPythonLaunchers(projectRoot, true, configuredPython);
        for (const launcher of launchers) {
            const usable = await this.canRunPythonLauncher(launcher);
            if (!usable) {
                this.recordResolutionAttempt(`Workspace launcher unavailable: ${launcher.label}`);
                continue;
            }
            this.recordResolutionAttempt(`Using workspace source mode with ${launcher.label}.`);
            return {
                command: launcher.command,
                args: [...launcher.baseArgs, '-m', 'src.main'],
                cwd: projectRoot,
                env: { ...process.env, PYTHONPATH: projectRoot },
                launchMode: 'workspace-source',
                resolvedBy: 'Actual AgentChatBus workspace detected; launching source server.',
                pythonLauncher: launcher.label,
                sourceRoot: projectRoot,
            };
        }
        this.log('AgentChatBus workspace is open, but no usable Python launcher was found for source mode.', 'warning');
        return null;
    }
    async resolveInstalledLaunchSpec(preferredLaunchers = []) {
        const pathExecutable = await this.findAgentChatBusExecutable();
        if (pathExecutable) {
            this.recordResolutionAttempt(`Resolved packaged executable directly: ${pathExecutable}`);
            return {
                command: pathExecutable,
                args: [],
                launchMode: 'pip-executable',
                resolvedBy: 'Resolved installed agentchatbus executable from PATH or Python Scripts directory.',
            };
        }
        const config = vscode.workspace.getConfiguration('agentchatbus');
        const configuredPython = config.get('pythonPath', 'python');
        const launchers = this.getPythonLaunchers(undefined, false, configuredPython, preferredLaunchers);
        for (const launcher of launchers) {
            const usable = await this.canRunPythonLauncher(launcher);
            if (!usable) {
                this.recordResolutionAttempt(`Python launcher unavailable for packaged mode: ${launcher.label}`);
                continue;
            }
            const scriptPath = await this.findAgentChatBusScriptForLauncher(launcher);
            if (scriptPath) {
                this.recordResolutionAttempt(`Resolved installed script via ${launcher.label}: ${scriptPath}`);
                return {
                    command: scriptPath,
                    args: [],
                    launchMode: 'pip-executable',
                    resolvedBy: `Located agentchatbus script in Python Scripts directory via ${launcher.label}.`,
                    pythonLauncher: launcher.label,
                };
            }
            const moduleInstalled = await this.isAgentChatBusInstalledInLauncher(launcher);
            if (moduleInstalled) {
                this.recordResolutionAttempt(`Resolved installed Python module via ${launcher.label}; using module fallback.`);
                return {
                    command: launcher.command,
                    args: [...launcher.baseArgs, '-m', 'agentchatbus.cli'],
                    launchMode: 'pip-module',
                    resolvedBy: `Python package is installed but script path could not be invoked directly; using python -m fallback via ${launcher.label}.`,
                    pythonLauncher: launcher.label,
                };
            }
            this.recordResolutionAttempt(`Launcher ${launcher.label} can run Python, but agentchatbus is not installed there.`);
        }
        return null;
    }
    async spawnServer(spec) {
        this.ownerBootToken = (0, crypto_1.randomUUID)();
        const env = {
            ...process.env,
            ...(spec.env || {}),
            AGENTCHATBUS_OWNER_BOOT_TOKEN: this.ownerBootToken,
            AGENTCHATBUS_RELOAD: '0',
        };
        this.serverMetadata = {
            command: spec.command,
            args: spec.args,
            cwd: spec.cwd,
            env,
            startupMode: spec.launchMode,
            resolvedBy: spec.resolvedBy,
            pythonLauncher: spec.pythonLauncher,
            sourceRoot: spec.sourceRoot,
            resolutionAttempts: [...(this.serverMetadata.resolutionAttempts || [])],
        };
        this.lastStartTime = new Date();
        this.stopExternalLogPolling();
        this.log(`Starting server process using ${spec.launchMode}.`, 'play');
        this.log(`Exec: ${spec.command} ${spec.args.join(' ')}`.trim(), 'terminal');
        this.log(`Resolution: ${spec.resolvedBy}`, 'info');
        if (spec.pythonLauncher) {
            this.log(`Python launcher: ${spec.pythonLauncher}`, 'info');
        }
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
            this.serverProcess.on('close', code => {
                this.log(`Server exited (code ${code})`, 'warning');
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
            this.log('Server failed to respond to health checks.', 'error');
            return false;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.log(`Fatal spawn error: ${message}`, 'error');
            return false;
        }
    }
    async installAgentChatBus() {
        const config = vscode.workspace.getConfiguration('agentchatbus');
        const configuredPython = config.get('pythonPath', 'python');
        const launchers = this.getPythonLaunchers(undefined, false, configuredPython);
        const successful = [];
        for (const launcher of launchers) {
            const usable = await this.canRunPythonLauncher(launcher);
            if (!usable) {
                this.recordResolutionAttempt(`Skipping install attempt because launcher is unavailable: ${launcher.label}`);
                continue;
            }
            const baseInstallArgs = [...launcher.baseArgs, '-m', 'pip', 'install', 'agentchatbus'];
            this.log(`Attempting pip install via ${launcher.label}...`, 'cloud-download');
            const primary = await this.runProcessWithLogging(launcher.command, baseInstallArgs, process.cwd());
            if (primary === 0) {
                this.log(`pip install succeeded via ${launcher.label}.`, 'check');
                successful.push(launcher);
                continue;
            }
            this.log(`pip install failed via ${launcher.label}; retrying with --user.`, 'warning');
            const userInstallArgs = [...launcher.baseArgs, '-m', 'pip', 'install', '--user', 'agentchatbus'];
            const secondary = await this.runProcessWithLogging(launcher.command, userInstallArgs, process.cwd());
            if (secondary === 0) {
                this.log(`pip install --user succeeded via ${launcher.label}.`, 'check');
                successful.push(launcher);
            }
            else {
                this.log(`pip install failed via ${launcher.label} (exit codes ${primary}/${secondary}).`, 'error');
            }
        }
        return successful.length > 0 ? successful : null;
    }
    async runProcessWithLogging(command, args, cwd) {
        return await new Promise(resolve => {
            const proc = child_process.spawn(command, args, { cwd, shell: false, env: process.env });
            proc.stdout?.on('data', data => {
                const text = data.toString();
                this.outputChannel.append(text);
                this.mcpLogProvider?.addLog(text);
            });
            proc.stderr?.on('data', data => {
                const text = data.toString();
                this.outputChannel.append(text);
                this.mcpLogProvider?.addLog(text);
            });
            proc.on('error', err => {
                this.log(`Command failed to start: ${command} ${args.join(' ')} :: ${err.message}`, 'error');
                resolve(-1);
            });
            proc.on('close', code => resolve(code ?? -1));
        });
    }
    getPythonLaunchers(projectRoot, includeWorkspaceVenv = false, configuredPython, preferred = []) {
        const launchers = [];
        const seen = new Set();
        const addLauncher = (launcher) => {
            const key = `${launcher.command}::${launcher.baseArgs.join(' ')}`;
            if (seen.has(key)) {
                return;
            }
            seen.add(key);
            launchers.push(launcher);
        };
        for (const launcher of preferred) {
            addLauncher(launcher);
        }
        if (includeWorkspaceVenv && projectRoot) {
            const venvPython = path.join(projectRoot, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
            if (fs.existsSync(venvPython)) {
                addLauncher({ command: venvPython, baseArgs: [], label: `workspace .venv (${venvPython})` });
            }
        }
        if (configuredPython && configuredPython.trim().length > 0) {
            addLauncher({ command: configuredPython.trim(), baseArgs: [], label: `configured pythonPath (${configuredPython.trim()})` });
        }
        if (process.platform === 'win32') {
            addLauncher({ command: 'py', baseArgs: ['-3'], label: 'Windows py launcher (py -3)' });
            for (const candidate of this.getWindowsPythonInstallCandidates()) {
                addLauncher({ command: candidate, baseArgs: [], label: `discovered Windows Python (${candidate})` });
            }
        }
        addLauncher({ command: 'python', baseArgs: [], label: 'python on PATH' });
        return launchers;
    }
    getWindowsPythonInstallCandidates() {
        if (process.platform !== 'win32') {
            return [];
        }
        const results = [];
        const roots = [
            process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Python') : null,
            process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Python') : null,
        ].filter((value) => Boolean(value));
        for (const root of roots) {
            if (!fs.existsSync(root)) {
                continue;
            }
            for (const entry of fs.readdirSync(root)) {
                const pythonExe = path.join(root, entry, 'python.exe');
                if (fs.existsSync(pythonExe)) {
                    results.push(pythonExe);
                }
            }
        }
        return results;
    }
    async canRunPythonLauncher(launcher) {
        try {
            await execFileAsync(launcher.command, [...launcher.baseArgs, '-c', 'import sys; print(sys.executable)'], { timeout: 3000 });
            return true;
        }
        catch {
            return false;
        }
    }
    async isAgentChatBusInstalledInLauncher(launcher) {
        try {
            const { stdout } = await execFileAsync(launcher.command, [...launcher.baseArgs, '-c', 'import importlib.util; print("1" if importlib.util.find_spec("agentchatbus") else "0")'], { timeout: 3000 });
            return stdout.trim() === '1';
        }
        catch {
            return false;
        }
    }
    async findAgentChatBusScriptForLauncher(launcher) {
        try {
            const script = [
                'import os, sysconfig, pathlib',
                'scripts = sysconfig.get_path("scripts") or ""',
                'name = "agentchatbus.exe" if os.name == "nt" else "agentchatbus"',
                'print(pathlib.Path(scripts) / name)',
            ].join('; ');
            const { stdout } = await execFileAsync(launcher.command, [...launcher.baseArgs, '-c', script], { timeout: 3000 });
            const candidate = stdout.trim();
            if (candidate && fs.existsSync(candidate)) {
                return candidate;
            }
        }
        catch {
            return null;
        }
        return null;
    }
    async findAgentChatBusExecutable() {
        try {
            const command = process.platform === 'win32' ? 'where' : 'which';
            this.recordResolutionAttempt(`Checking ${command} for agentchatbus on PATH.`);
            const { stdout } = await execFileAsync(command, ['agentchatbus'], { timeout: 3000 });
            const candidates = stdout
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(Boolean)
                .sort((left, right) => {
                const leftScore = left.toLowerCase().endsWith('.exe') ? 0 : 1;
                const rightScore = right.toLowerCase().endsWith('.exe') ? 0 : 1;
                return leftScore - rightScore;
            });
            for (const candidate of candidates) {
                if (fs.existsSync(candidate)) {
                    return candidate;
                }
            }
        }
        catch {
            this.recordResolutionAttempt('PATH lookup did not find a runnable agentchatbus executable.');
        }
        return null;
    }
    async isAgentChatBusProjectRoot(folderPath) {
        const mainPath = path.join(folderPath, 'src', 'main.py');
        const pyprojectPath = path.join(folderPath, 'pyproject.toml');
        const extensionPath = path.join(folderPath, 'vscode-agentchatbus', 'package.json');
        if (!fs.existsSync(mainPath) || !fs.existsSync(pyprojectPath) || !fs.existsSync(extensionPath)) {
            return false;
        }
        try {
            const pyproject = await fs.promises.readFile(pyprojectPath, 'utf8');
            return pyproject.includes('name = "agentchatbus"');
        }
        catch {
            return false;
        }
    }
    async findProjectRootAsync() {
        if (!vscode.workspace.workspaceFolders) {
            return null;
        }
        for (const folder of vscode.workspace.workspaceFolders) {
            if (await this.isAgentChatBusProjectRoot(folder.uri.fsPath)) {
                return folder.uri.fsPath;
            }
        }
        return null;
    }
    async registerMcpProvider(context) {
        const lm = this.getLanguageModelNamespace();
        if (!lm?.registerMcpServerDefinitionProvider) {
            this.log('VS Code MCP provider API is unavailable in this editor build.', 'warning');
            return;
        }
        const provider = {
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
exports.BusServerManager = BusServerManager;
//# sourceMappingURL=busServerManager.js.map