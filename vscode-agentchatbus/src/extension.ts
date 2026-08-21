import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { AgentChatBusApiClient } from './api/client';
import { ThreadsTreeProvider, ThreadItem } from './providers/threadsProvider';
import { AgentsTreeProvider } from './providers/agentsProvider';
import { ChatPanel } from './views/chatPanel';
import type { Thread } from './api/types';
import { BusServerManager } from './busServerManager';
import { AgentMcpConfigManager } from './agentMcpConfigManager';
import { SetupProvider } from './providers/setupProvider';
import { McpLogProvider } from './providers/mcpLogProvider';
import { SettingsProvider } from './providers/settingsProvider';
import { StatusPanel } from './views/statusPanel';
import { SettingsPanel } from './views/settingsPanel';
import { formatLmError, getBrowserOpenUrl, isLocalServerUrlWithContext } from './logic/serverUrl';

let apiClient: AgentChatBusApiClient | undefined;
let mcpLogProvider: McpLogProvider | undefined;
let settingsProvider: SettingsProvider | undefined;
let agentMcpConfigManager: AgentMcpConfigManager | undefined;
let serverManagerInstance: BusServerManager | undefined;
let mainViewsInitialized = false;
let workspaceDevUiWatcherRegistered = false;

function isLocalServerUrl(rawUrl: string): boolean {
    const localIps: string[] = [];
    const interfaces = os.networkInterfaces();
    for (const infos of Object.values(interfaces)) {
        for (const info of infos || []) {
            const address = String(info.address || '').trim().toLowerCase();
            if (address) {
                localIps.push(address);
            }
        }
    }
    return isLocalServerUrlWithContext(rawUrl, {
        localHostName: os.hostname(),
        localIps,
    });
}

function getLanguageModelNamespace(): typeof vscode.lm | undefined {
    return (vscode as unknown as { lm?: typeof vscode.lm }).lm;
}

type LmProbeModelInfo = {
    name: string;
    id: string;
    vendor: string;
    family: string;
    version: string;
    maxInputTokens: number;
    canSendRequest: 'yes' | 'no' | 'unknown';
};

type LmProbeResult = {
    apiAvailable: boolean;
    selectChatModelsAvailable: boolean;
    supportedForProactiveInvocation: boolean;
    supportedForCopilotVendor: boolean;
    probeAt: string;
    models: LmProbeModelInfo[];
    copilotModels: LmProbeModelInfo[];
    notes: string[];
    error?: string;
};

async function probeLanguageModelsForStatus(context: vscode.ExtensionContext): Promise<LmProbeResult> {
    const probeAt = new Date().toISOString();
    const notes: string[] = [];

    const lm = getLanguageModelNamespace();
    const selectChatModelsAvailable = typeof lm?.selectChatModels === 'function';

    const base: LmProbeResult = {
        apiAvailable: Boolean(lm),
        selectChatModelsAvailable,
        supportedForProactiveInvocation: false,
        supportedForCopilotVendor: false,
        probeAt,
        models: [],
        copilotModels: [],
        notes,
    };

    if (!lm) {
        notes.push('vscode.lm is not available in this IDE build.');
        notes.push('This extension cannot proactively invoke an IDE coding agent via runNewCopilotSession.');
        return base;
    }

    if (!selectChatModelsAvailable) {
        notes.push('vscode.lm.selectChatModels is not available.');
        notes.push('This extension cannot probe or invoke IDE chat models in the current environment.');
        return base;
    }

    try {
        const models = await lm.selectChatModels();
        const accessInfo = (context as unknown as { languageModelAccessInformation?: vscode.LanguageModelAccessInformation })
            .languageModelAccessInformation;

        base.models = models.map((model) => {
            let canSend: boolean | undefined = undefined;
            try {
                canSend = accessInfo?.canSendRequest(model);
            } catch {
                canSend = undefined;
            }

            return {
                name: model.name,
                id: model.id,
                vendor: model.vendor,
                family: model.family,
                version: model.version,
                maxInputTokens: model.maxInputTokens,
                canSendRequest: canSend === true ? 'yes' : canSend === false ? 'no' : 'unknown',
            };
        });

        base.copilotModels = base.models.filter((m) => m.vendor === 'copilot');
        base.supportedForProactiveInvocation = base.models.length > 0;
        base.supportedForCopilotVendor = base.copilotModels.length > 0;

        if (base.models.length === 0) {
            notes.push('No chat models were exposed to extensions via vscode.lm.');
            notes.push('This extension cannot proactively invoke an IDE coding agent (runNewCopilotSession) here.');
        } else {
            notes.push('Models were discovered via vscode.lm.selectChatModels().');
            notes.push('canSendRequest=unknown usually means consent has not been asked yet; invoking will prompt the user.');
            if (base.copilotModels.length === 0) {
                notes.push('No vendor=copilot models were found. If you expected Copilot, check that it is installed and signed in.');
            }
        }

        return base;
    } catch (err) {
        const error = formatLmError(err);
        return {
            ...base,
            supportedForProactiveInvocation: false,
            supportedForCopilotVendor: false,
            notes: [
                ...notes,
                'Language model probing threw an exception.',
                'This extension cannot treat IDE agent invocation as available in the current environment.'
            ],
            error,
        };
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('[AgentChatBus] Activating extension...');

    ChatPanel.setExtensionPath(context.extensionPath);

    // Register webview panel serializers to handle restored panels gracefully
    context.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer(ChatPanel.VIEW_TYPE, {
            async deserializeWebviewPanel(panel: vscode.WebviewPanel, _state: unknown) {
                try {
                    console.log('[AgentChatBus] Deserializing webview panel (v2)...');
                    ChatPanel.reviveRecoveredPanel(panel);
                } catch (err) {
                    console.error('[AgentChatBus] Failed to deserialize panel (v2):', err);
                    panel.dispose();
                }
            }
        }),
        vscode.window.registerWebviewPanelSerializer(ChatPanel.LEGACY_VIEW_TYPE, {
            async deserializeWebviewPanel(panel: vscode.WebviewPanel, _state: unknown) {
                try {
                    console.log('[AgentChatBus] Deserializing webview panel (legacy)...');
                    ChatPanel.reviveRecoveredPanel(panel);
                } catch (err) {
                    console.error('[AgentChatBus] Failed to deserialize panel (legacy):', err);
                    panel.dispose();
                }
            }
        })
    );

    const serverManager = new BusServerManager(context);
    const workspaceDevContext = serverManager.getWorkspaceDevContext();
    ChatPanel.setWorkspaceDevWebUiRoot(workspaceDevContext?.webUiRoot);
    serverManagerInstance = serverManager;
    agentMcpConfigManager = new AgentMcpConfigManager();
    const setupProvider = new SetupProvider();
    mcpLogProvider = new McpLogProvider();
    
    serverManager.setSetupProvider(setupProvider);
    serverManager.setMcpLogProvider(mcpLogProvider);
    
    context.subscriptions.push(serverManager);
    context.subscriptions.push(setupProvider);
    context.subscriptions.push(mcpLogProvider);
    
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('agentchatbus.setup', setupProvider),
        vscode.window.registerTreeDataProvider('agentchatbus.mcpLogs', mcpLogProvider)
    );

    // Set initial context for agent filter
    vscode.commands.executeCommand('setContext', 'agentchatbus:agentsFilterActive', true);

    const runSetup = async () => {
        try {
            console.log('[AgentChatBus] Starting setup process...');
            const isReady = await serverManager.ensureServerRunning();
            if (isReady) {
                console.log('[AgentChatBus] Server is ready, initializing main views.');
                initializeMainViews(context, serverManager);
            } else {
                console.warn('[AgentChatBus] Server failed to start.');
            }
        } catch (error) {
            console.error('[AgentChatBus] Fatal error during setup:', error);
            serverManager.log(`Fatal error: ${error}`, 'error');
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('agentchatbus.retrySetup', () => {
            console.log('[AgentChatBus] Retry command triggered.');
            setupProvider.reset();
            runSetup();
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(event => {
            if (!event.affectsConfiguration('agentchatbus.serverUrl') &&
                !event.affectsConfiguration('agentchatbus.autoStartBusServer') &&
                !event.affectsConfiguration('agentchatbus.msgWaitMinTimeoutMs') &&
                !event.affectsConfiguration('agentchatbus.enforceMsgWaitMinTimeout') &&
                !event.affectsConfiguration('agentchatbus.ptyUseConpty') &&
                !event.affectsConfiguration('agentchatbus.agentTransport') &&
                !event.affectsConfiguration('agentchatbus.threadTimeoutMinutes')) {
                return;
            }

            serverManager.notifyMcpDefinitionsChanged();
        })
    );

    // Register MCP provider (asynchronous definition provision)
    serverManager.registerMcpProvider(context);

    // Start setup asynchronously to avoid blocking the activate() call
    Promise.resolve().then(() => {
        setTimeout(() => {
            runSetup();
        }, 500);
    });
}

function initializeMainViews(context: vscode.ExtensionContext, serverManager: BusServerManager) {
    if (mainViewsInitialized) return;
    mainViewsInitialized = true;

    console.log('[AgentChatBus] Initializing main views...');
    ChatPanel.setWorkspaceDevWebUiRoot(serverManager.getWorkspaceDevContext()?.webUiRoot);
    registerWorkspaceDevUiWatcher(context, serverManager);
    apiClient = new AgentChatBusApiClient();
    apiClient.connectSSE();

    const threadsProvider = new ThreadsTreeProvider(apiClient);
    const agentsProvider = new AgentsTreeProvider(apiClient);
    settingsProvider = new SettingsProvider();

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('agentchatbus.threads', threadsProvider),
        vscode.window.registerTreeDataProvider('agentchatbus.settings', settingsProvider),
        vscode.window.registerTreeDataProvider('agentchatbus.agents', agentsProvider)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('agentchatbus.refreshThreads', () => threadsProvider.refresh()),
        vscode.commands.registerCommand('agentchatbus.refreshAgents', () => agentsProvider.refresh()),
        vscode.commands.registerCommand('agentchatbus.toggleAgentFilter', () => agentsProvider.toggleRecentFilter()),
        vscode.commands.registerCommand('agentchatbus.clearMcpLogs', () => {
            mcpLogProvider?.clear();
        }),
        vscode.commands.registerCommand('agentchatbus.stopServer', async () => {
            const messages = serverManager.getRestartActionMessages();
            const status = serverManager.getStatusMetadata();
            const isExternal = String(status.startupMode || '').startsWith('external-service');
            const confirmed = await vscode.window.showWarningMessage(
                messages.mode === 'force-restart'
                    ? (
                        isExternal
                            ? 'Force restart the externally managed AgentChatBus service? The extension will try force-shutdown via API, verify process exit, then kill the process if needed before starting a fresh service.'
                            : messages.confirmMessage
                    )
                    : messages.confirmMessage,
                { modal: true },
                messages.confirmLabel
            );
            if (confirmed === messages.confirmLabel) {
                const stopped = await serverManager.stopServer();
                if (!stopped) {
                    const failure = serverManager.getLastStopFailureMessage();
                    vscode.window.showWarningMessage(
                        failure
                            ? failure
                            : messages.mode === 'force-restart'
                                ? (
                                    isExternal
                                        ? 'The external AgentChatBus service did not accept the shutdown request.'
                                        : messages.failureMessage
                                )
                                : messages.failureMessage
                    );
                }
            }
        }),
        vscode.commands.registerCommand('agentchatbus.switchToManagedDevService', async () => {
            await vscode.commands.executeCommand('agentchatbus.stopServer');
        }),
        vscode.commands.registerCommand('agentchatbus.restartManagedDevService', async () => {
            await vscode.commands.executeCommand('agentchatbus.stopServer');
        }),
        vscode.commands.registerCommand('agentchatbus.stopServerPending', () => {
            vscode.window.showInformationMessage(serverManager.getRestartActionMessages().pendingMessage);
        }),
        vscode.commands.registerCommand('agentchatbus.switchToManagedDevServicePending', () => {
            vscode.window.showInformationMessage(serverManager.getRestartActionMessages().pendingMessage);
        }),
        vscode.commands.registerCommand('agentchatbus.restartManagedDevServicePending', () => {
            vscode.window.showInformationMessage(serverManager.getRestartActionMessages().pendingMessage);
        }),
        vscode.commands.registerCommand('agentchatbus.openFullLog', () => {
            const logs = mcpLogProvider?.getLogs() || [];
            const panel = vscode.window.createWebviewPanel(
                'agentchatbusLogs',
                'AgentChatBus Full Logs',
                vscode.ViewColumn.One,
                {}
            );
            panel.webview.html = `<html><body><pre style="padding: 10px; font-family: monospace;">${logs.join('\n')}</pre></body></html>`;
        }),
        vscode.commands.registerCommand('agentchatbus.openWebConsole', () => {
            const config = vscode.workspace.getConfiguration('agentchatbus');
            const url = config.get<string>('serverUrl', 'http://127.0.0.1:39765');
            // When bound to 0.0.0.0, prefer a LAN IP so the console is reachable
            // from other devices on the network.
            const lanIps: string[] = [];
            try {
                const parsed = new URL(url);
                if (parsed.hostname === '0.0.0.0' || parsed.hostname === '::' || parsed.hostname === '[::]') {
                    const ifaces = os.networkInterfaces();
                    for (const infos of Object.values(ifaces)) {
                        for (const iface of infos || []) {
                            if (iface.family === 'IPv4' && !iface.internal) {
                                lanIps.push(iface.address);
                            }
                        }
                    }
                }
            } catch {
                // ignore parse errors — fall back to default behavior
            }
            const browserUrl = getBrowserOpenUrl(url, lanIps.length > 0 ? lanIps : undefined);
            vscode.env.openExternal(vscode.Uri.parse(browserUrl));
        }),
        vscode.commands.registerCommand('agentchatbus.serverSettings', () => {
            SettingsPanel.createOrShow();
        }),
        vscode.commands.registerCommand('agentchatbus.filterThreads', async () => {
            const statuses = ['discuss', 'implement', 'review', 'done', 'closed', 'archived'];
            const currentFilter = threadsProvider.getStatusFilter();
            
            const items: (vscode.QuickPickItem & { status: string })[] = statuses.map(s => ({
                label: s.charAt(0).toUpperCase() + s.slice(1),
                status: s,
                picked: currentFilter.includes(s),
                description: s === 'archived' ? '(archived threads are hidden by default)' : undefined
            }));

            const result = await vscode.window.showQuickPick(items, {
                canPickMany: true,
                placeHolder: 'Select thread statuses to display',
                ignoreFocusOut: true
            });

            if (result) {
                const selectedStatuses = result.map(i => i.status);
                threadsProvider.setStatusFilter(selectedStatuses);
            }
        }),
        vscode.commands.registerCommand('agentchatbus.openThread', (thread: Thread) => {
            console.log('[AgentChatBus] openThread called, thread:', thread?.id, 'apiClient:', !!apiClient);
            if (thread && apiClient) {
                ChatPanel.createOrShow(thread, apiClient);
            } else {
                console.error('[AgentChatBus] openThread: missing thread or apiClient', { thread, apiClient: !!apiClient });
            }
        }),
         vscode.commands.registerCommand('agentchatbus.showMcpStatus', async () => {
             const metadata = serverManager.getStatusMetadata();
             let backendEngine = String(metadata.backendEngine || 'unknown').trim().toLowerCase() || 'unknown';
             let backendEngineSource = metadata.backendEngine ? 'startup-probe' : 'startup-heuristic';
             let backendVersion = String(metadata.backendVersion || '').trim() || undefined;
             let backendRuntime = String(metadata.backendRuntime || '').trim() || undefined;
             let backendStartedAt = undefined as string | undefined;
             let backendUptimeSeconds = undefined as number | undefined;
             let serverReachable = false;
             const serverUrl = String(metadata?.mcp?.serverUrl || apiClient?.getBaseUrl() || '').trim();
             const localServer = isLocalServerUrl(serverUrl);
             const serverScope = localServer ? 'local' : 'remote';
             const lmProbe = await probeLanguageModelsForStatus(context);

            try {
                if (apiClient) {
                    try {
                        const health = await apiClient.getHealth();
                        serverReachable = true;
                        const healthEngine = String(health?.engine || '').trim().toLowerCase();
                        if (healthEngine === 'node' || healthEngine === 'python') {
                            backendEngine = healthEngine;
                            backendEngineSource = 'health';
                        }
                        const healthVersion = String(health?.version || '').trim();
                        if (healthVersion) {
                            backendVersion = healthVersion;
                        }
                        const healthRuntime = String(health?.runtime || '').trim();
                        if (healthRuntime) {
                            backendRuntime = healthRuntime;
                        }
                    } catch {
                        // Ignore health probe failures and continue with metrics / heuristics.
                    }

                    const metrics = await apiClient.getMetrics();
                    serverReachable = true;
                    const engine = String(metrics?.engine || '').trim().toLowerCase();
                    if (engine === 'node' || engine === 'python') {
                        backendEngine = engine;
                        backendEngineSource = 'api/metrics';
                    }
                    const startedAt = String(metrics?.started_at || '').trim();
                    if (startedAt) {
                        backendStartedAt = startedAt;
                    }
                    const uptimeRaw = Number(metrics?.uptime_seconds);
                    if (!Number.isNaN(uptimeRaw) && uptimeRaw >= 0) {
                        backendUptimeSeconds = uptimeRaw;
                    }
                    const metricsAgentTransport = String(metrics?.agent_transport || '').trim().toLowerCase();
                    if (metricsAgentTransport === 'v2-socket' || metricsAgentTransport === 'v1-http') {
                        metadata.agentTransport = metricsAgentTransport;
                    }
                }
            } catch {
                // Ignore metrics probe failures and keep fallback heuristics.
            }

            if (backendEngine === 'unknown') {
                const command = String(metadata.command || '').toLowerCase();
                const args = Array.isArray(metadata.args)
                    ? metadata.args.map((item: unknown) => String(item || '').toLowerCase()).join(' ')
                    : '';
                if (metadata.startupMode === 'bundled-ts-service' || metadata.startupMode === 'workspace-dev-service') {
                    backendEngine = 'node';
                    backendEngineSource = 'startup-mode';
                } else if (
                    command.includes('python')
                    || args.includes('python')
                    || args.includes('uvicorn')
                    || args.includes('src.main')
                ) {
                    backendEngine = 'python';
                    backendEngineSource = 'command-heuristic';
                } else if (command.includes('node') || args.includes('node')) {
                    backendEngine = 'node';
                    backendEngineSource = 'command-heuristic';
                }
            }

             // Derive bind host and LAN IPs for the Server Instance card.
             const bindHost = (() => {
                 try {
                     const u = new URL(serverUrl);
                     return u.hostname || 'unknown';
                 } catch {
                     return 'unknown';
                 }
             })();
             const lanIps: string[] = [];
             if (bindHost === '0.0.0.0' || bindHost === '::') {
                 const ifaces = os.networkInterfaces();
                 for (const name of Object.keys(ifaces)) {
                     for (const iface of ifaces[name] ?? []) {
                         if (iface.family === 'IPv4' && !iface.internal) {
                             lanIps.push(iface.address);
                         }
                     }
                 }
             }

             StatusPanel.createOrShow({
                 ...metadata,
                 backendEngine,
                 backendEngineSource,
                 backendVersion,
                 backendRuntime,
                 backendStartedAt,
                 backendUptimeSeconds,
                 serverReachable,
                 serverScope,
                 serverUrl,
                 bindHost,
                 lanIps,
                 lmProbe,
                 agentTransport: metadata.agentTransport,
                 privacyWarning: localServer
                     ? ''
                     : 'Remote server detected. Sensitive host/process fields are hidden for safety.',
             });
         }),
        vscode.commands.registerCommand('agentchatbus.openAgentMcpConfig', async () => {
            if (!agentMcpConfigManager) {
                void vscode.window.showErrorMessage('Agent MCP config manager is not initialized.');
                return;
            }
            const clients = agentMcpConfigManager.getClients();
            const items: (vscode.QuickPickItem & { clientIndex: number })[] = clients.map((c, i) => ({
                label: c.name,
                description: c.format.toUpperCase(),
                detail: `~/${c.configPath}`,
                clientIndex: i,
            }));
            const selected = await vscode.window.showQuickPick(items, {
                title: 'Open Agent MCP Config — select client',
                placeHolder: 'Choose which agent client\'s MCP config file to open',
            });
            if (!selected || selected.clientIndex < 0) return;
            const client = clients[selected.clientIndex];
            const fullPath = agentMcpConfigManager.getConfigPath(client);
            try {
                const doc = await vscode.workspace.openTextDocument(fullPath);
                await vscode.window.showTextDocument(doc);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const followUp = await vscode.window.showErrorMessage(
                    `Failed to open ${client.name} MCP config (${fullPath}): ${message}`,
                    'Create File'
                );
                if (followUp === 'Create File') {
                    try {
                        const fs = await import('fs/promises');
                        const pathMod = await import('path');
                        await fs.mkdir(pathMod.dirname(fullPath), { recursive: true });
                        const defaultContent = client.format === 'toml'
                            ? ''
                            : '{\n  "mcpServers": {}\n}\n';
                        await fs.writeFile(fullPath, defaultContent, 'utf-8');
                        const doc = await vscode.workspace.openTextDocument(fullPath);
                        await vscode.window.showTextDocument(doc);
                    } catch (err2) {
                        void vscode.window.showErrorMessage(
                            `Failed to create config file: ${err2 instanceof Error ? err2.message : String(err2)}`
                        );
                    }
                }
            }
        }),
        vscode.commands.registerCommand('agentchatbus.configureAgentMcp', async () => {
            if (!agentMcpConfigManager) {
                void vscode.window.showErrorMessage('Agent MCP config manager is not initialized.');
                return;
            }
            const config = vscode.workspace.getConfiguration('agentchatbus');
            const transport = config.get<'v2-socket' | 'v1-http'>('agentTransport', 'v2-socket');
            const serverUrl = config.get<string>('serverUrl', 'http://127.0.0.1:39765');
            const clients = agentMcpConfigManager.getClients();

            // Build quick-pick items for each known client
            const items: (vscode.QuickPickItem & { clientIndex: number })[] = clients.map((c, i) => ({
                label: c.name,
                description: c.format.toUpperCase(),
                detail: `~/${c.configPath} — ${c.description}`,
                clientIndex: i,
                picked: true,
            }));
            items.push({
                label: '$(check-all) All known clients',
                description: '',
                detail: 'Patch every known MCP config file at once',
                clientIndex: -1,
            });

            const selected = await vscode.window.showQuickPick(items, {
                title: 'Configure Agent MCP — select target client(s)',
                canPickMany: true,
                placeHolder: transport === 'v2-socket'
                    ? 'V2 Socket mode: agents connect via stdio proxy → Unix socket (no IP needed)'
                    : 'V1 HTTP mode: agents connect via HTTP + SSE to the server URL',
            });
            if (!selected || selected.length === 0) return;

            const allSelected = selected.some((s) => s.clientIndex === -1);
            const targetClients = allSelected
                ? clients
                : selected
                    .filter((s) => s.clientIndex >= 0)
                    .map((s) => clients[s.clientIndex]);

            if (targetClients.length === 0) return;

            // Build the patch input
            const v2SharedDir = path.join(os.homedir(), '.agentchatbus');
            const proxyScriptPath = transport === 'v2-socket'
                ? path.join(v2SharedDir, 'proxy.mjs')
                : undefined;
            const socketPath = transport === 'v2-socket'
                ? path.join(v2SharedDir, 'agent.sock')
                : undefined;

            const confirmed = await vscode.window.showInformationMessage(
                transport === 'v2-socket'
                    ? `Patch ${targetClients.length} MCP config(s) for V2 Socket mode? Agents will connect via stdio proxy → ${socketPath}.`
                    : `Patch ${targetClients.length} MCP config(s) for V1 HTTP mode? Agents will connect to ${serverUrl.replace(/\/+$/, '')}/mcp.`,
                { modal: true },
                'Patch Config'
            );
            if (confirmed !== 'Patch Config') return;

            const input = {
                transport,
                proxyScriptPath,
                socketPath,
                serverUrl,
                nodeExecutable: process.execPath,
            };

            const results: { name: string; changed: boolean; error?: string; path: string }[] = [];
            for (const client of targetClients) {
                const result = await agentMcpConfigManager.patchClient(client, input);
                results.push({
                    name: client.name,
                    changed: result.changed,
                    error: result.error,
                    path: agentMcpConfigManager.getConfigPath(client),
                });
            }

            const changedCount = results.filter((r) => r.changed).length;
            const errorCount = results.filter((r) => r.error).length;
            const summary = `${changedCount} patched, ${results.length - changedCount - errorCount} up to date, ${errorCount} errors`;
            const detailLines = results.map((r) =>
                `${r.changed ? '✅' : r.error ? '❌' : '⏭️'} ${r.name}: ${r.error || (r.changed ? 'patched' : 'already up to date')} (${r.path})`
            ).join('\n');

            if (errorCount > 0) {
                const action = await vscode.window.showErrorMessage(
                    `Agent MCP config: ${summary}\n${detailLines}`,
                    'Open Output Channel'
                );
            } else {
                const action = await vscode.window.showInformationMessage(
                    `Agent MCP config: ${summary}`,
                    'Show Details'
                );
                if (action === 'Show Details') {
                    void vscode.window.showInformationMessage(detailLines);
                }
            }
        }),
        vscode.commands.registerCommand('agentchatbus.copyThreadId', (item: ThreadItem) => {
            if (item?.thread?.id) {
                vscode.env.clipboard.writeText(item.thread.id);
                vscode.window.showInformationMessage(`Copied Thread ID: ${item.thread.id}`);
            }
        }),
        vscode.commands.registerCommand('agentchatbus.deleteThread', async (item: ThreadItem) => {
            if (!item?.thread?.id || !apiClient) return;
            const confirmed = await vscode.window.showWarningMessage(
                `Are you sure you want to PERMANENTLY delete thread "${item.thread.topic}"? This cannot be undone.`,
                { modal: true },
                'Delete'
            );
            if (confirmed === 'Delete') {
                const ok = await apiClient.deleteThread(item.thread.id);
                if (ok) {
                    vscode.window.showInformationMessage('Thread deleted.');
                    threadsProvider.refresh();
                } else {
                    vscode.window.showErrorMessage('Failed to delete thread.');
                }
            }
        }),
        vscode.commands.registerCommand('agentchatbus.archiveThread', async (item: ThreadItem) => {
            if (!item?.thread?.id || !apiClient) return;
            const ok = await apiClient.archiveThread(item.thread.id);
            if (ok) {
                threadsProvider.refresh();
            } else {
                vscode.window.showErrorMessage('Failed to archive thread.');
            }
        }),
        vscode.commands.registerCommand('agentchatbus.unarchiveThread', async (item: ThreadItem) => {
            if (!item?.thread?.id || !apiClient) return;
            const ok = await apiClient.unarchiveThread(item.thread.id);
            if (ok) {
                threadsProvider.refresh();
            } else {
                vscode.window.showErrorMessage('Failed to unarchive thread.');
            }
        }),
        vscode.commands.registerCommand('agentchatbus.changeThreadStatus', async (item: ThreadItem) => {
            if (!item?.thread?.id || !apiClient) return;
            const statuses = ['discuss', 'implement', 'review', 'done', 'closed'];
            const result = await vscode.window.showQuickPick(statuses, {
                placeHolder: `Change status for "${item.thread.topic}" (current: ${item.thread.status})`
            });
            if (result && result !== item.thread.status) {
                const ok = await apiClient.setThreadState(item.thread.id, result);
                if (ok) {
                    threadsProvider.refresh();
                } else {
                    vscode.window.showErrorMessage('Failed to change thread status.');
                }
            }
        })
    );

    context.subscriptions.push({
        dispose: () => apiClient?.disconnectSSE()
    });
}

export async function deactivate() {
    if (serverManagerInstance) {
        await serverManagerInstance.handleIdeDeactivate();
    }
    if (apiClient) {
        apiClient.disconnectSSE();
    }
}

function registerWorkspaceDevUiWatcher(
    context: vscode.ExtensionContext,
    serverManager: BusServerManager
) {
    if (workspaceDevUiWatcherRegistered) {
        return;
    }

    const workspaceDevContext = serverManager.getWorkspaceDevContext();
    if (!workspaceDevContext) {
        return;
    }

    workspaceDevUiWatcherRegistered = true;
    const pattern = new vscode.RelativePattern(
        vscode.Uri.file(workspaceDevContext.webUiRoot),
        'extension/**/*'
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    let refreshTimer: NodeJS.Timeout | undefined;
    const scheduleRefresh = () => {
        ChatPanel.setWorkspaceDevWebUiRoot(serverManager.getWorkspaceDevContext()?.webUiRoot);
        if (refreshTimer) {
            clearTimeout(refreshTimer);
        }
        refreshTimer = setTimeout(() => {
            ChatPanel.reloadCurrentPanelForSourceChange();
        }, 150);
    };

    watcher.onDidChange(scheduleRefresh, undefined, context.subscriptions);
    watcher.onDidCreate(scheduleRefresh, undefined, context.subscriptions);
    watcher.onDidDelete(scheduleRefresh, undefined, context.subscriptions);
    context.subscriptions.push(watcher);
    context.subscriptions.push({
        dispose: () => {
            workspaceDevUiWatcherRegistered = false;
            if (refreshTimer) {
                clearTimeout(refreshTimer);
            }
        }
    });
}
