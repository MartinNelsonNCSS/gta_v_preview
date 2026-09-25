import * as vscode from 'vscode';
import { GtaPreviewProvider } from './host/previewProvider';
import { registerConverter } from './host/converterPanel';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(...GtaPreviewProvider.register(context), ...registerConverter(context));
}

export function deactivate(): void {}
