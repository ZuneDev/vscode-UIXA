import * as vscode from 'vscode';
import * as path from 'path';
import * as net from 'net';
import { spawn, ChildProcess } from 'child_process';

export function activate(context: vscode.ExtensionContext) {
    console.log('UIX XML debug extension activated');

    // Register the debug adapter descriptor factory
    const factory = new UIXDebugAdapterDescriptorFactory();
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory('uix-xml', factory)
    );

    // Dispose of the factory when extension deactivates
    context.subscriptions.push(factory);
}

export function deactivate() {
    console.log('UIX XML debug extension deactivated');
}

class UIXDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory, vscode.Disposable {
    private serverProcesses: Map<string, ChildProcess> = new Map();

    async createDebugAdapterDescriptor(
        session: vscode.DebugSession,
        executable: vscode.DebugAdapterExecutable | undefined
    ): Promise<vscode.DebugAdapterDescriptor | undefined> {
        
        const config = session.configuration;
        const executablePath: string = config.program;
        const pipeName: string = config.pipeName || 'uix-debug-pipe';

        if (!executablePath) {
            vscode.window.showErrorMessage('Program path not specified in launch configuration.');
            return undefined;
        }

        // Resolve workspace folder variables
        const resolvedExectuablePath = this.resolveVariables(executablePath, session.workspaceFolder);
        
        // Verify the debug server executable exists
        if (!require('fs').existsSync(resolvedExectuablePath)) {
            vscode.window.showErrorMessage(`Program executable not found: ${resolvedExectuablePath}`);
            return undefined;
        }

        const options: vscode.DebugAdapterExecutableOptions = {
            cwd: config.cwd ? this.resolveVariables(config.cwd, session.workspaceFolder) : undefined,
        }

        return new vscode.DebugAdapterExecutable(resolvedExectuablePath, [], options);

        try {
            // Generate platform-specific pipe name
            const fullPipeName = this.getPlatformPipeName(pipeName);
            
            // Launch the debug adapter server process
            const serverProcess = await this.launchDebugServer(resolvedExectuablePath, fullPipeName, config);
            
            // Store the process for cleanup
            this.serverProcesses.set(session.id, serverProcess);

            // Wait a moment for the server to start and create the named pipe
            await this.waitForPipe(fullPipeName, 5000);

            // Create a named pipe transport descriptor
            return new vscode.DebugAdapterNamedPipeServer(fullPipeName);

        } catch (error) {
            // const errorMessage = error instanceof Error ? error.message : String(error);
            // vscode.window.showErrorMessage(`Failed to start debug adapter: ${errorMessage}`);
            return undefined;
        }
    }

    private resolveVariables(value: string, workspaceFolder?: vscode.WorkspaceFolder): string {
        if (!value) {
            return value;
        }

        let resolved = value;

        // Replace common VS Code variables
        if (workspaceFolder) {
            resolved = resolved.replace(/\$\{workspaceFolder\}/g, workspaceFolder.uri.fsPath);
            resolved = resolved.replace(/\$\{workspaceFolderBasename\}/g, path.basename(workspaceFolder.uri.fsPath));
        }

        // Replace environment variables
        resolved = resolved.replace(/\$\{env:([^}]+)\}/g, (match, envVar) => {
            return process.env[envVar] || match;
        });

        return resolved;
    }

    private getPlatformPipeName(pipeName: string): string {
        // Named pipes have different formats on Windows vs Unix-like systems
        if (process.platform === 'win32') {
            // Windows: \\.\pipe\pipename
            return `\\\\.\\pipe\\${pipeName}`;
        } else {
            // Unix/Linux/macOS: /tmp/pipename or use sockets
            // Note: Named pipes on Unix may require different handling
            return `/tmp/${pipeName}`;
        }
    }

    private async launchDebugServer(
        serverPath: string,
        pipeName: string,
        config: vscode.DebugConfiguration
    ): Promise<ChildProcess> {
        
        return new Promise((resolve, reject) => {
            // Prepare arguments for the debug server
            // Adjust these based on your debug server's command-line interface
            const args: string[] = [
                `--pipe=${pipeName}`
            ];

            // Add any additional arguments from the configuration
            // if (config.program) {
            //     const resolvedProgram = this.resolveVariables(config.program, vscode.workspace.workspaceFolders?.[0]);
            //     args.push('--program', resolvedProgram);
            // }

            if (config.args && Array.isArray(config.args)) {
                args.push('--args', ...config.args);
            }

            if (config.cwd) {
                const resolvedCwd = this.resolveVariables(config.cwd, vscode.workspace.workspaceFolders?.[0]);
                args.push('--cwd', resolvedCwd);
            }

            console.log(`Launching debug server: ${serverPath} ${args.join(' ')}`);

            // Spawn the debug adapter server process
            const serverProcess = spawn(serverPath, args, {
                env: { ...process.env, ...config.env },
                stdio: ['ignore', 'pipe', 'pipe']
            });

            // Log server output
            serverProcess.stdout?.on('data', (data) => {
                console.log(`[Debug Server]: ${data.toString()}`);
            });

            serverProcess.stderr?.on('data', (data) => {
                console.error(`[Debug Server Error]: ${data.toString()}`);
            });

            serverProcess.on('error', (error) => {
                reject(new Error(`Failed to launch debug server: ${error.message}`));
            });

            serverProcess.on('exit', (code, signal) => {
                console.log(`Debug server exited with code ${code}, signal ${signal}`);
            });

            // Give the process a moment to start
            setTimeout(() => {
                if (serverProcess.killed) {
                    reject(new Error('Debug server process died immediately after starting'));
                } else {
                    resolve(serverProcess);
                }
            }, 5000);
        });
    }

    private async waitForPipe(pipeName: string, timeoutMs: number): Promise<void> {
        const startTime = Date.now();
        
        return new Promise((resolve, reject) => {
            const checkPipe = () => {
                if (Date.now() - startTime > timeoutMs) {
                    reject(new Error(`Timeout waiting for named pipe: ${pipeName}`));
                    return;
                }

                // Try to connect to the named pipe
                const client = net.connect(pipeName, () => {
                    client.end();
                    resolve();
                });

                client.on('error', () => {
                    // Pipe not ready yet, try again
                    setTimeout(checkPipe, 100);
                });
            };

            checkPipe();
        });
    }

    dispose() {
        // Clean up all running debug server processes
        for (const [sessionId, process] of this.serverProcesses.entries()) {
            console.log(`Terminating debug server for session ${sessionId}`);
            process.kill();
        }
        this.serverProcesses.clear();
    }
}