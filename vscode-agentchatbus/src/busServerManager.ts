import * as vscode from 'vscode';
import * as path from 'path';
import * as child_process from 'child_process';
import * as fs from 'fs';
import { SetupProvider } from './providers/setupProvider';
import { McpLogProvider } from './providers/mcpLogProvider';

export class BusServerManager {
    private outputChannel: vscode.OutputChannel;
    private serverProcess: child_process.ChildProcess | null = null;
    private setupProvider: SetupProvider | null = null;
    private mcpLogProvider: McpLogProvider | null = null;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('AgentChatBus Server');
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
            this.mcpLogProvider.addLog(message);
        }
    }

    async ensureServerRunning(): Promise<boolean> {
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
            const isRunning = await this.checkServer(serverUrl);
            if (isRunning) {
                this.log('Server detected and responding.', 'check');
                this.setServerReady(true);
                return true;
            }
        } catch (e: any) {
            this.log(`Probe failed: ${e.message}`, 'warning');
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

    private setServerReady(ready: boolean) {
        vscode.commands.executeCommand('setContext', 'agentchatbus:serverReady', ready);
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
        this.log('Scanning environment for AgentChatBus...', 'search');
        const projectRoot = await this.findProjectRootAsync();
        const config = vscode.workspace.getConfiguration('agentchatbus');
        let pythonPath = config.get<string>('pythonPath', 'python');

        // Case 1: In a project workspace
        if (projectRoot) {
            this.log(`Found project root: ${projectRoot}`, 'folder');
            
            // Auto-detect .venv if pythonPath is default
            if (pythonPath === 'python') {
                this.log('Searching for virtual environment (.venv)...', 'search');
                const venvBase = path.join(projectRoot, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
                const venvPython = path.join(venvBase, process.platform === 'win32' ? 'python.exe' : 'python');
                
                if (fs.existsSync(venvPython)) {
                    pythonPath = venvPython;
                    this.log(`Using virtual env: ${pythonPath}`, 'terminal');
                } else {
                    this.log('No .venv found, falling back to system python.', 'info');
                }
            }

            return await this.spawnServer(pythonPath, ['-m', 'src.main'], projectRoot);
        }

        // Case 2: Use global 'agentchatbus' command
        this.log('Searching for "agentchatbus" command in PATH...', 'search');
        const globalCmd = await this.findAgentChatBusExecutable();
        if (globalCmd) {
            this.log(`Located global command: ${globalCmd}`, 'terminal');
            return await this.spawnServer(globalCmd, []);
        }

        // Case 3: Not found anywhere, offer to install
        this.log('AgentChatBus not detected. Check system PATH or open an AgentChatBus project.', 'error');
        
        const selection = await vscode.window.showErrorMessage(
            'AgentChatBus server not found. Would you like to attempt to install it via pip?',
            'Install', 'Cancel'
        );

        if (selection === 'Install') {
            const installed = await this.installAgentChatBus();
            if (installed) {
                this.log('Relocating executable after installation...', 'sync~spin');
                const newCmd = await this.findAgentChatBusExecutable();
                if (newCmd) {
                    return await this.spawnServer(newCmd, []);
                } else {
                    this.log('Installation succeeded but executable still not found in PATH.', 'error');
                }
            }
        }

        return false;
    }

    private async spawnServer(command: string, args: string[], cwd?: string): Promise<boolean> {
        this.log(`Starting server process...`, 'play');
        const fullCmd = `${command} ${args.join(' ')}`;
        this.log(`Exec: ${fullCmd}`, 'terminal');
        
        const env = { ...process.env };
        if (cwd) {
            env.PYTHONPATH = cwd;
        }
        
        try {
            this.serverProcess = child_process.spawn(command, args, {
                cwd: cwd || process.cwd(),
                env,
                shell: true 
            });

            // Set context that MCP server is active (started by extension)
            vscode.commands.executeCommand('setContext', 'agentchatbus:mcpServerActive', true);

            this.serverProcess.stdout?.on('data', (data) => {
                const text = data.toString();
                this.outputChannel.append(text);
                if (this.mcpLogProvider) {
                    this.mcpLogProvider.addLog(text);
                }
            });

            this.serverProcess.stderr?.on('data', (data) => {
                const text = data.toString();
                this.outputChannel.append(text);
                if (this.mcpLogProvider) {
                    this.mcpLogProvider.addLog(text);
                }
            });

            this.serverProcess.on('error', (err) => {
                this.log(`Spawn error: ${err.message}`, 'error');
            });

            this.serverProcess.on('close', (code) => {
                this.log(`Server exited (code ${code})`, 'warning');
                this.serverProcess = null;
                this.setServerReady(false);
                vscode.commands.executeCommand('setContext', 'agentchatbus:mcpServerActive', false);
            });

            this.log('Waiting for health check response...', 'sync~spin');
            const config = vscode.workspace.getConfiguration('agentchatbus');
            const serverUrl = config.get<string>('serverUrl', 'http://127.0.0.1:39765');
            let retries = 20;
            while (retries > 0) {
                await new Promise(r => setTimeout(r, 1000));
                if (await this.checkServer(serverUrl)) {
                    this.log('Server is online and ready.', 'check');
                    return true;
                }
                retries--;
            }

            this.log('Server failed to respond to health checks.', 'error');
            return false;
        } catch (e: any) {
            this.log(`Fatal spawn error: ${e.message}`, 'error');
            return false;
        }
    }

    private async findAgentChatBusExecutable(): Promise<string | null> {
        try {
            const cmd = process.platform === 'win32' ? 'where' : 'which';
            const checkCmd = `${cmd} agentchatbus`;
            this.log(`Checking PATH via: ${checkCmd}`, 'terminal');
            
            const out = await new Promise<string>((resolve, reject) => {
                child_process.exec(checkCmd, { timeout: 3000 }, (err, stdout) => {
                    if (err) reject(err);
                    else resolve(stdout.trim());
                });
            });
            const firstPath = out.split('\r\n')[0].split('\n')[0];
            if (firstPath && fs.existsSync(firstPath)) return firstPath;
        } catch (e: any) {
            this.log(`Not found in PATH: ${e.message}`, 'info');
        }

        if (process.platform === 'win32') {
            this.log('Checking common Windows installation scripts...', 'search');
            const appData = process.env.APPDATA;
            if (appData) {
                const localAppData = process.env.LOCALAPPDATA || path.join(path.dirname(appData), 'Local');
                const pythonBase = path.join(localAppData, 'Programs', 'Python');
                if (fs.existsSync(pythonBase)) {
                    const versions = fs.readdirSync(pythonBase);
                    for (const v of versions) {
                        const scriptsPath = path.join(pythonBase, v, 'Scripts', 'agentchatbus.exe');
                        if (fs.existsSync(scriptsPath)) return scriptsPath;
                    }
                }
            }
        }
        return null;
    }

    private async installAgentChatBus(): Promise<boolean> {
        const cmd = 'python -m pip install agentchatbus';
        this.log(`Installation started: ${cmd}`, 'cloud-download');
        this.outputChannel.show();

        return new Promise((resolve) => {
            const pkg = child_process.spawn('python', ['-m', 'pip', 'install', 'agentchatbus'], { shell: true });
            pkg.stdout.on('data', (data) => this.outputChannel.append(data.toString()));
            pkg.stderr.on('data', (data) => this.outputChannel.append(data.toString()));
            
            pkg.on('close', (code) => {
                if (code === 0) {
                    this.log('Installation successful.', 'check');
                    resolve(true);
                } else {
                    this.log(`Installation failed (exit code ${code}).`, 'error');
                    resolve(false);
                }
            });
            pkg.on('error', (err) => {
                this.log(`Execution error: ${err.message}`, 'error');
                resolve(false);
            });
        });
    }

    private async findProjectRootAsync(): Promise<string | null> {
        if (vscode.workspace.workspaceFolders) {
            for (const folder of vscode.workspace.workspaceFolders) {
                const mainPath = path.join(folder.uri.fsPath, 'src', 'main.py');
                try {
                    await fs.promises.access(mainPath);
                    return folder.uri.fsPath;
                } catch {
                    // Not found in this folder
                }
            }
        }
        return null;
    }

    async registerMcpProvider(context: vscode.ExtensionContext): Promise<void> {
        const lm = (vscode as any).lm;
        if (!lm || !lm.registerMcpServerDefinitionProvider) return;

        const projectRoot = await this.findProjectRootAsync();
        if (!projectRoot) return;

        const config = vscode.workspace.getConfiguration('agentchatbus');
        let pythonPath = config.get<string>('pythonPath', 'python');
        
        const venvPython = path.join(projectRoot, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
        if (fs.existsSync(venvPython)) {
            pythonPath = venvPython;
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
