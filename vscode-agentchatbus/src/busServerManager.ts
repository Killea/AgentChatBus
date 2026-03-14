import * as vscode from 'vscode';
import * as path from 'path';
import * as child_process from 'child_process';
import * as fs from 'fs';
import { SetupProvider } from './providers/setupProvider';

export class BusServerManager {
    private outputChannel: vscode.OutputChannel;
    private serverProcess: child_process.ChildProcess | null = null;
    private setupProvider: SetupProvider | null = null;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('AgentChatBus Server');
    }

    setSetupProvider(provider: SetupProvider) {
        this.setupProvider = provider;
    }

    async ensureServerRunning(): Promise<boolean> {
        const config = vscode.workspace.getConfiguration('agentchatbus');
        const autoStart = config.get<boolean>('autoStartBusServer', true);
        const serverUrl = config.get<string>('serverUrl', 'http://127.0.0.1:39765');

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

    private setServerReady(ready: boolean) {
        vscode.commands.executeCommand('setContext', 'agentchatbus:serverReady', ready);
    }

    private updateSetupSteps(steps: { label: string, icon?: string, description?: string }[]) {
        if (this.setupProvider) {
            this.setupProvider.setSteps(steps);
        }
    }

    private async checkServer(url: string): Promise<boolean> {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 1000);
            const response = await fetch(`${url}/health`, { signal: controller.signal });
            clearTimeout(timeoutId);
            return response.ok;
        } catch {
            return false;
        }
    }

    private async startServer(): Promise<boolean> {
        const projectRoot = this.findProjectRoot();
        const config = vscode.workspace.getConfiguration('agentchatbus');
        let pythonPath = config.get<string>('pythonPath', 'python');

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
        
        const selection = await vscode.window.showErrorMessage(
            'AgentChatBus server not found. Would you like to attempt to install it via pip?',
            'Install', 'Cancel'
        );

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

    private async spawnServer(command: string, args: string[], cwd?: string): Promise<boolean> {
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
            const serverUrl = config.get<string>('serverUrl', 'http://127.0.0.1:39765');
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
        } catch (e: any) {
            this.outputChannel.appendLine(`[AgentChatBus] Spawn error: ${e.message}`);
            return false;
        }
    }

    private async findAgentChatBusExecutable(): Promise<string | null> {
        // 1. Check if it's in PATH
        try {
            const cmd = process.platform === 'win32' ? 'where' : 'which';
            const out = child_process.execSync(`${cmd} agentchatbus`, { encoding: 'utf8' }).trim().split('\r\n')[0].split('\n')[0];
            if (out && fs.existsSync(out)) return out;
        } catch {}

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
                        if (fs.existsSync(scriptsPath)) return scriptsPath;
                    }
                }
                // Also check Roaming/Python/PythonXX/Scripts
                const roamingPython = path.join(appData, 'Python');
                if (fs.existsSync(roamingPython)) {
                    const versions = fs.readdirSync(roamingPython);
                    for (const v of versions) {
                        const scriptsPath = path.join(roamingPython, v, 'Scripts', 'agentchatbus.exe');
                        if (fs.existsSync(scriptsPath)) return scriptsPath;
                    }
                }
            }
        }

        return null;
    }

    private async installAgentChatBus(): Promise<boolean> {
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
                } else {
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

    private findProjectRoot(): string | null {
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

    registerMcpProvider(context: vscode.ExtensionContext): void {
        const projectRoot = this.findProjectRoot();
        if (!projectRoot) return; // MCP currently only for source-mode

        const lm = (vscode as any).lm;
        if (!lm || !lm.registerMcpServerDefinitionProvider) return;

        const config = vscode.workspace.getConfiguration('agentchatbus');
        let pythonPath = config.get<string>('pythonPath', 'python');
        
        const venvPath = path.join(projectRoot, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
        if (fs.existsSync(venvPath)) {
            pythonPath = venvPath;
        }

        lm.registerMcpServerDefinitionProvider('agentchatbus', {
            provideMcpServerDefinitions: () => [
                new (vscode as any).McpStdioServerDefinition({
                    label: 'AgentChatBus Bus',
                    command: pythonPath,
                    args: [path.join(projectRoot, 'stdio_main.py')],
                    cwd: projectRoot,
                    env: { PYTHONPATH: projectRoot }
                })
            ],
            resolveMcpServerDefinition: async (server: any) => {
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
