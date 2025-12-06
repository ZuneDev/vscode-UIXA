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
    private adapters: Map<string, NamedPipeDebugAdapter> = new Map();

    async createDebugAdapterDescriptor(
        session: vscode.DebugSession,
        executable: vscode.DebugAdapterExecutable | undefined
    ): Promise<vscode.DebugAdapterDescriptor | undefined> {
        
        const config = session.configuration;
        const executablePath: string = config.program;
        const basePipeName: string = config.pipeName || 'uix-debug-pipe';

        if (!executablePath) {
            vscode.window.showErrorMessage('Debug server path not specified in launch configuration.');
            return undefined;
        }

        // Resolve workspace folder variables
        const resolvedServerPath = this.resolveVariables(executablePath, session.workspaceFolder);
        
        // Verify the debug server executable exists
        if (!require('fs').existsSync(resolvedServerPath)) {
            vscode.window.showErrorMessage(`Debug server not found: ${resolvedServerPath}`);
            return undefined;
        }

        try {
            // Create separate pipe names for reading and writing
            // Convention: client reads from "in" pipe, writes to "out" pipe
            const basePipePath = this.getPlatformPipeName(basePipeName);
            const readPipePath = `${basePipePath}_ToClient`;
            const writePipePath = `${basePipePath}_FromClient`;
            
            console.log(`Creating bidirectional pipe connection:`);
            console.log(`  Read from: ${readPipePath}`);
            console.log(`  Write to: ${writePipePath}`);

            // Launch the debug adapter server process
            const serverProcess = await this.launchDebugServer(
                resolvedServerPath, 
                basePipePath, 
                config
            );
            
            // Store the process for cleanup
            this.serverProcesses.set(session.id, serverProcess);

            // Wait for both pipes to be ready
            const [readPipe, writePipe] = await Promise.all([
                this.connectToPipe(readPipePath, 10000),
                this.connectToPipe(writePipePath, 10000)
            ]);

            // Create the debug adapter that bridges the pipes
            const adapter = new NamedPipeDebugAdapter(readPipe, writePipe, session.id);
            
            // Store adapter for cleanup
            this.adapters.set(session.id, adapter);

            // Handle adapter disposal
            adapter.onDisposed(() => {
                this.cleanupSession(session.id);
            });

            // Return an inline implementation using our adapter
            return new vscode.DebugAdapterInlineImplementation(adapter);

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to start debug adapter: ${errorMessage}`);
            
            // Cleanup on failure
            this.cleanupSession(session.id);
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
            // Unix/Linux/macOS: /tmp/pipename
            return `/tmp/${pipeName}`;
        }
    }

    private async launchDebugServer(
        serverPath: string,
        basePipePath: string,
        config: vscode.DebugConfiguration
    ): Promise<ChildProcess> {
        
        return new Promise((resolve, reject) => {
            // Prepare arguments for the debug server
            // The server writes to readPipeName (so client can read)
            // The server reads from writePipeName (so client can write)
            const args: string[] = [
                `--pipe=${basePipePath}`
            ];

            // Add any additional arguments from the configuration
            if (config.program) {
                const resolvedProgram = this.resolveVariables(config.program, vscode.workspace.workspaceFolders?.[0]);
                args.push('--program', resolvedProgram);
            }

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
            }, 500);
        });
    }

    private async connectToPipe(pipeName: string, timeoutMs: number): Promise<net.Socket> {
        const startTime = Date.now();
        
        return new Promise((resolve, reject) => {
            const checkPipe = () => {
                if (Date.now() - startTime > timeoutMs) {
                    reject(new Error(`Timeout waiting for named pipe: ${pipeName}`));
                    return;
                }

                // Try to connect to the named pipe
                const client = net.connect(pipeName, () => {
                    resolve(client);
                });

                client.on('error', () => {
                    // Pipe not ready yet, try again
                    setTimeout(checkPipe, 100);
                });
            };

            checkPipe();
        });
    }

    private cleanupSession(sessionId: string) {
        // Dispose adapter
        const adapter = this.adapters.get(sessionId);
        if (adapter) {
            adapter.dispose();
            this.adapters.delete(sessionId);
        }

        // Kill server process
        const process = this.serverProcesses.get(sessionId);
        if (process) {
            process.kill();
            this.serverProcesses.delete(sessionId);
        }
    }

    dispose() {
        // Clean up all running debug server processes and connections
        for (const sessionId of this.serverProcesses.keys()) {
            console.log(`Terminating debug server for session ${sessionId}`);
            this.cleanupSession(sessionId);
        }
    }
}

/**
 * Debug Adapter implementation that communicates via separate named pipes
 * for reading and writing Debug Adapter Protocol messages.
 */
class NamedPipeDebugAdapter implements vscode.DebugAdapter {
    private readonly _onDidSendMessage = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
    private readonly _onDisposed = new vscode.EventEmitter<void>();
    
    readonly onDidSendMessage = this._onDidSendMessage.event;
    readonly onDisposed = this._onDisposed.event;

    private messageBuffer: Buffer = Buffer.alloc(0);
    private contentLength: number = -1;
    private isDisposed: boolean = false;

    constructor(
        private readPipe: net.Socket,
        private writePipe: net.Socket,
        private sessionId: string
    ) {
        this.setupPipes();
    }

    private setupPipes() {
        // Handle incoming data from the read pipe (messages from debug server)
        this.readPipe.on('data', (data: Buffer) => {
            this.handleIncomingData(data);
        });

        this.readPipe.on('end', () => {
            console.log(`Read pipe ended for session ${this.sessionId}`);
            this.dispose();
        });

        this.readPipe.on('error', (error) => {
            console.error(`Read pipe error for session ${this.sessionId}:`, error);
            this.dispose();
        });

        this.writePipe.on('error', (error) => {
            console.error(`Write pipe error for session ${this.sessionId}:`, error);
            this.dispose();
        });

        this.writePipe.on('close', () => {
            console.log(`Write pipe closed for session ${this.sessionId}`);
        });
    }

    /**
     * Handle incoming data from the debug server.
     * DAP messages are in the format:
     * Content-Length: <length>\r\n\r\n<JSON message>
     */
    private handleIncomingData(data: Buffer) {
        if (this.isDisposed) {
            return;
        }

        // Append new data to buffer
        this.messageBuffer = Buffer.concat([this.messageBuffer, data]);

        while (true) {
            // If we don't know the content length yet, parse headers
            if (this.contentLength < 0) {
                const headerEnd = this.messageBuffer.indexOf('\r\n\r\n');
                if (headerEnd < 0) {
                    // Haven't received complete headers yet
                    break;
                }

                // Parse Content-Length header
                const headers = this.messageBuffer.slice(0, headerEnd).toString('utf-8');
                const match = /Content-Length: (\d+)/i.exec(headers);
                
                if (!match) {
                    console.error('Invalid DAP message: missing Content-Length header');
                    this.dispose();
                    return;
                }

                this.contentLength = parseInt(match[1], 10);
                
                // Remove headers from buffer
                this.messageBuffer = this.messageBuffer.slice(headerEnd + 4);
            }

            // Check if we have the complete message body
            if (this.messageBuffer.length >= this.contentLength) {
                // Extract the message
                const messageData = this.messageBuffer.slice(0, this.contentLength);
                this.messageBuffer = this.messageBuffer.slice(this.contentLength);
                this.contentLength = -1;

                // Parse and emit the message
                try {
                    const message = JSON.parse(messageData.toString('utf-8'));
                    this._onDidSendMessage.fire(message);
                } catch (error) {
                    console.error('Failed to parse DAP message:', error);
                }
            } else {
                // Need more data
                break;
            }
        }
    }

    /**
     * Send a message to the debug server.
     * Formats the message according to DAP protocol.
     */
    handleMessage(message: vscode.DebugProtocolMessage): void {
        if (this.isDisposed) {
            console.warn('Attempted to send message to disposed adapter');
            return;
        }

        try {
            // Serialize message to JSON
            const messageJson = JSON.stringify(message);
            const messageBuffer = Buffer.from(messageJson, 'utf-8');

            // Create DAP protocol message with Content-Length header
            const header = `Content-Length: ${messageBuffer.length}\r\n\r\n`;
            const headerBuffer = Buffer.from(header, 'utf-8');

            // Combine header and message
            const fullMessage = Buffer.concat([headerBuffer, messageBuffer]);

            // Write to the write pipe
            this.writePipe.write(fullMessage, (error) => {
                if (error) {
                    console.error('Error writing to pipe:', error);
                    this.dispose();
                }
            });
        } catch (error) {
            console.error('Error handling message:', error);
        }
    }

    dispose() {
        if (this.isDisposed) {
            return;
        }

        this.isDisposed = true;
        
        console.log(`Disposing debug adapter for session ${this.sessionId}`);

        // Close pipes
        this.readPipe.destroy();
        this.writePipe.destroy();

        // Clean up event emitters
        this._onDidSendMessage.dispose();
        
        // Notify that we're disposed
        this._onDisposed.fire();
        this._onDisposed.dispose();
    }
}