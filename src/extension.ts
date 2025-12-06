import * as vscode from 'vscode';
import * as path from 'path';

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
    async createDebugAdapterDescriptor(
        session: vscode.DebugSession,
        executable: vscode.DebugAdapterExecutable | undefined
    ): Promise<vscode.DebugAdapterDescriptor | undefined> {
        const config = session.configuration;
        const executablePath: string = config.program;

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

    dispose() { }
}