import * as vscode from 'vscode';
import { GtaPreviewProvider } from './host/previewProvider';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(...GtaPreviewProvider.register(context));
}

export function deactivate(): void {}
