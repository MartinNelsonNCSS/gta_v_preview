import * as vscode from 'vscode';
import { GtaPreviewProvider } from './host/previewProvider';
import { registerConverter } from './host/converterPanel';
import { WorkspaceIndex } from './host/workspaceIndex';
import { HealthDiagnostics } from './host/healthCheck';
import { registerAssetViews } from './host/assetTree';
import { registerOptimizer } from './host/optimizerPanel';

export function activate(context: vscode.ExtensionContext): void {
  const index = new WorkspaceIndex();
  const health = new HealthDiagnostics(index);
  context.subscriptions.push(
    index,
    health,
    ...GtaPreviewProvider.register(context),
    ...registerConverter(context),
    ...registerAssetViews(context, index, health),
    ...registerOptimizer(context, index)
  );
}

export function deactivate(): void {}
