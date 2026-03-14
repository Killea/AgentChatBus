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
class BusServerManager {
    outputChannel;
    serverProcess = null;
    setupProvider = null;
    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('AgentChatBus Server');
    }
    setSetupProvider(provider) {
        this.setupProvider = provider;
    }
    async ensureServerRunning() {
        const config = vscode.workspace.getConfiguration('agentchatbus');
        const autoStart = config.get('autoStartBusServer', true);
        const serverUrl = config.get('serverUrl', 'http://127.0.0.1:39765');
        if (!autoStart) {
            return true;
        }
        this.updateSetupSteps([{ label: 'Checking AgentChatBus Server...', icon: 'sync~spin' }]);
        const isRunning = await this.checkServer(serverUrl);
        if (isRunning) {
            this.outputChannel.appendLine('[AgentChatBus] Server is already running.');
            this.setServerReady(true);
            return true;
        }
        this.outputChannel.appendLine('[AgentChatBus] Server not detected. Attempting to start...');
        const started = await this.startServer();
        if (started) {
            this.setServerReady(true);
            return true;
        }
        return false;
    }
    setServerReady(ready) {
        vscode.commands.executeCommand('setContext', 'agentchatbus:serverReady', ready);
    }
    updateSetupSteps(steps) {
        if (this.setupProvider) {
            this.setupProvider.setSteps(steps);
        }
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
    async startServer() {
        const projectRoot = this.findProjectRoot();
        const config = vscode.workspace.getConfiguration('agentchatbus');
        let pythonPath = config.get('pythonPath', 'python');
        // Case 1: In a project workspace
        if (projectRoot) {
            this.updateSetupSteps([{ label: 'Found AgentChatBus project, starting from source...', icon: 'sync~spin' }]);
            // Auto-detect .venv if pythonPath is default
            if (pythonPath === 'python') {
                const venvPath = path.join(projectRoot, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
                if (fs.existsSync(venvPath)) {
                    pythonPath = venvPath;
                    this.outputChannel.appendLine(`[AgentChatBus] Detected virtual env at: ${pythonPath}`);
                }
            }
            return await this.spawnServer(pythonPath, ['-m', 'src.main'], projectRoot);
        }
        // Case 2: Use global 'agentchatbus' command
        this.updateSetupSteps([{ label: 'Locating agentchatbus command...', icon: 'sync~spin' }]);
        const globalCmd = await this.findAgentChatBusExecutable();
        if (globalCmd) {
            this.updateSetupSteps([{ label: 'Starting global AgentChatBus server...', icon: 'sync~spin' }]);
            return await this.spawnServer(globalCmd, []);
        }
        // Case 3: Not found anywhere, offer to install
        this.updateSetupSteps([
            { label: 'AgentChatBus not found.', icon: 'error' },
            { label: 'Click to attempt "pip install agentchatbus"', icon: 'cloud-download', description: 'Requires Python and pip' }
        ]);
        const selection = await vscode.window.showErrorMessage('AgentChatBus server not found. Would you like to attempt to install it via pip?', 'Install', 'Cancel');
        if (selection === 'Install') {
            const installed = await this.installAgentChatBus();
            if (installed) {
                // Try again after install
                const newCmd = await this.findAgentChatBusExecutable();
                if (newCmd) {
                    return await this.spawnServer(newCmd, []);
                }
            }
        }
        return false;
    }
    async spawnServer(command, args, cwd) {
        this.outputChannel.appendLine(`[AgentChatBus] Spawning: ${command} ${args.join(' ')}`);
        const env = { ...process.env };
        if (cwd) {
            env.PYTHONPATH = cwd;
        }
        // Ensure paths are quoted if they contain spaces
        const spawnCmd = command.includes(' ') ? `"${command}"` : command;
        try {
            this.serverProcess = child_process.spawn(command, args, {
                cwd: cwd || process.cwd(),
                env,
                shell: true // Required for some Windows path resolutions
            });
            this.serverProcess.stdout?.on('data', (data) => {
                this.outputChannel.append(data.toString());
            });
            this.serverProcess.stderr?.on('data', (data) => {
                this.outputChannel.append(data.toString());
            });
            this.serverProcess.on('error', (err) => {
                this.outputChannel.appendLine(`[AgentChatBus] Failed to start process: ${err.message}`);
            });
            this.serverProcess.on('close', (code) => {
                this.outputChannel.appendLine(`[AgentChatBus] Server process exited with code ${code}`);
                this.serverProcess = null;
                this.setServerReady(false);
            });
            // Wait for server to become ready
            const config = vscode.workspace.getConfiguration('agentchatbus');
            const serverUrl = config.get('serverUrl', 'http://127.0.0.1:39765');
            let retries = 20;
            while (retries > 0) {
                await new Promise(r => setTimeout(r, 1000));
                if (await this.checkServer(serverUrl)) {
                    this.outputChannel.appendLine('[AgentChatBus] Server is now ready.');
                    this.updateSetupSteps([{ label: 'Server Ready', icon: 'check' }]);
                    return true;
                }
                retries--;
            }
            this.outputChannel.appendLine('[AgentChatBus] Timeout waiting for server health check.');
            return false;
        }
        catch (e) {
            this.outputChannel.appendLine(`[AgentChatBus] Spawn error: ${e.message}`);
            return false;
        }
    }
    async findAgentChatBusExecutable() {
        // 1. Check if it's in PATH
        try {
            const cmd = process.platform === 'win32' ? 'where' : 'which';
            const out = child_process.execSync(`${cmd} agentchatbus`, { encoding: 'utf8' }).trim().split('\r\n')[0].split('\n')[0];
            if (out && fs.existsSync(out))
                return out;
        }
        catch { }
        // 2. Check Windows specific user scripts folder
        if (process.platform === 'win32') {
            const appData = process.env.APPDATA;
            if (appData) {
                // Often in Local/Programs/Python/PythonXX/Scripts (but APPDATA is Roaming)
                const localAppData = process.env.LOCALAPPDATA || path.join(path.dirname(appData), 'Local');
                const pythonBase = path.join(localAppData, 'Programs', 'Python');
                if (fs.existsSync(pythonBase)) {
                    const versions = fs.readdirSync(pythonBase);
                    for (const v of versions) {
                        const scriptsPath = path.join(pythonBase, v, 'Scripts', 'agentchatbus.exe');
                        if (fs.existsSync(scriptsPath))
                            return scriptsPath;
                    }
                }
                // Also check Roaming/Python/PythonXX/Scripts
                const roamingPython = path.join(appData, 'Python');
                if (fs.existsSync(roamingPython)) {
                    const versions = fs.readdirSync(roamingPython);
                    for (const v of versions) {
                        const scriptsPath = path.join(roamingPython, v, 'Scripts', 'agentchatbus.exe');
                        if (fs.existsSync(scriptsPath))
                            return scriptsPath;
                    }
                }
            }
        }
        return null;
    }
    async installAgentChatBus() {
        this.updateSetupSteps([{ label: 'Installing AgentChatBus...', icon: 'sync~spin' }]);
        this.outputChannel.show();
        this.outputChannel.appendLine('[AgentChatBus] Running: pip install agentchatbus');
        return new Promise((resolve) => {
            const pkg = child_process.spawn('python', ['-m', 'pip', 'install', 'agentchatbus'], { shell: true });
            pkg.stdout.on('data', (data) => this.outputChannel.append(data.toString()));
            pkg.stderr.on('data', (data) => this.outputChannel.append(data.toString()));
            pkg.on('close', (code) => {
                if (code === 0) {
                    this.outputChannel.appendLine('[AgentChatBus] Installation successful.');
                    resolve(true);
                }
                else {
                    this.outputChannel.appendLine(`[AgentChatBus] Installation failed with code ${code}.`);
                    this.updateSetupSteps([{ label: 'Installation Failed', icon: 'error', description: 'See output for details' }]);
                    resolve(false);
                }
            });
            pkg.on('error', (err) => {
                this.outputChannel.appendLine(`[AgentChatBus] Failed to start pip: ${err.message}`);
                resolve(false);
            });
        });
    }
    findProjectRoot() {
        if (vscode.workspace.workspaceFolders) {
            for (const folder of vscode.workspace.workspaceFolders) {
                const mainPath = path.join(folder.uri.fsPath, 'src', 'main.py');
                if (fs.existsSync(mainPath)) {
                    return folder.uri.fsPath;
                }
            }
        }
        return null;
    }
    registerMcpProvider(context) {
        const projectRoot = this.findProjectRoot();
        if (!projectRoot)
            return; // MCP currently only for source-mode
        const lm = vscode.lm;
        if (!lm || !lm.registerMcpServerDefinitionProvider)
            return;
        const config = vscode.workspace.getConfiguration('agentchatbus');
        let pythonPath = config.get('pythonPath', 'python');
        const venvPath = path.join(projectRoot, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
        if (fs.existsSync(venvPath)) {
            pythonPath = venvPath;
        }
        lm.registerMcpServerDefinitionProvider('agentchatbus', {
            provideMcpServerDefinitions: () => [
                new vscode.McpStdioServerDefinition({
                    label: 'AgentChatBus Bus',
                    command: pythonPath,
                    args: [path.join(projectRoot, 'stdio_main.py')],
                    cwd: projectRoot,
                    env: { PYTHONPATH: projectRoot }
                })
            ],
            resolveMcpServerDefinition: async (server) => {
                return server;
            }
        });
    }
    dispose() {
        if (this.serverProcess) {
            this.serverProcess.kill();
        }
        this.outputChannel.dispose();
    }
}
exports.BusServerManager = BusServerManager;
//# sourceMappingURL=busServerManager.js.map