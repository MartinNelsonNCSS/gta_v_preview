import * as vscode from 'vscode';
import { optimizeYtd } from '../formats/optimize';
import type { HostToWebview, WebviewToHost } from '../shared/model';
import { basename } from './assetIndex';
import { webviewHtml } from './previewProvider';
import { IndexedAsset, WorkspaceIndex } from './workspaceIndex';

/** Registers "GTA V: Optimize Textures…" (command palette, Explorer folders/.ytd files, sidebar). */
export function registerOptimizer(context: vscode.ExtensionContext, index: WorkspaceIndex): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('gtaPreview.optimizeTextures', async (target?: vscode.Uri | { resource?: { root: vscode.Uri }; asset?: { uri: vscode.Uri } }, targets?: vscode.Uri[]) => {
      await index.ensure();
      // Scope: selected Explorer items, a sidebar resource, or the whole workspace.
      let scopes: vscode.Uri[] = [];
      if (targets?.length) scopes = targets;
      else if (target instanceof vscode.Uri) scopes = [target];
      else if (target?.asset?.uri) scopes = [target.asset.uri];
      else if (target?.resource?.root) scopes = [target.resource.root];
      const inScope = (a: IndexedAsset) =>
        !scopes.length || scopes.some((s) => a.uri.toString() === s.toString() || a.uri.path.toLowerCase().startsWith(s.path.toLowerCase() + '/'));
      const files = index.all.filter((a) => a.kind === 'ytd' && inScope(a) && !a.summary.encrypted && !a.summary.error && a.summary.textures?.length);
      if (!files.length) {
        void vscode.window.showInformationMessage('No readable .ytd files found to optimise.');
        return;
      }
      const scope = scopes.length === 1 ? basename(scopes[0]) : scopes.length ? `${scopes.length} selected items` : 'the workspace';
      new OptimizerPanel(context, index, files, scope);
    }),
  ];
}

class OptimizerPanel {
  private readonly panel: vscode.WebviewPanel;

  constructor(context: vscode.ExtensionContext, private readonly index: WorkspaceIndex, private readonly files: IndexedAsset[], private readonly scope: string) {
    const dist = vscode.Uri.joinPath(context.extensionUri, 'dist');
    this.panel = vscode.window.createWebviewPanel('gtaPreview.optimizer', `Optimize textures — ${scope}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [dist],
    });
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
    this.panel.webview.html = webviewHtml(this.panel.webview, dist, 'optimizer');
    this.panel.webview.onDidReceiveMessage((m: WebviewToHost) => void this.onMessage(m));
  }

  private post(m: HostToWebview): void {
    void this.panel.webview.postMessage(m);
  }

  private async onMessage(m: WebviewToHost): Promise<void> {
    if (m.type === 'ready') {
      this.post({
        type: 'optimizerFiles',
        scope: this.scope,
        files: this.files.map((a) => ({
          uri: a.uri.toString(),
          file: a.file,
          resource: a.resource.name,
          rel: a.rel,
          graphicsSize: a.summary.graphicsSize,
          systemSize: a.summary.systemSize,
          textures: a.summary.textures ?? [],
        })),
      });
    } else if (m.type === 'applyOptimization') {
      await this.apply(m.files);
    }
  }

  private async apply(jobs: Extract<WebviewToHost, { type: 'applyOptimization' }>['files']): Promise<void> {
    const textures = jobs.reduce((n, j) => n + j.plans.length, 0);
    const choice = await vscode.window.showWarningMessage(
      `Optimise ${textures} texture${textures === 1 ? '' : 's'} in ${jobs.length} texture dictionar${jobs.length === 1 ? 'y' : 'ies'}?`,
      { modal: true, detail: 'Each .ytd is rebuilt with the changes. The first time a file is changed, the original is kept next to it as <file>.bak.' },
      'Optimize'
    );
    if (choice !== 'Optimize') {
      this.post({ type: 'optimizeDone', cancelled: true });
      return;
    }
    for (const job of jobs) {
      const asset = this.files.find((a) => a.uri.toString() === job.uri);
      if (!asset) continue;
      try {
        const original = await vscode.workspace.fs.readFile(asset.uri);
        const result = optimizeYtd(original, job.plans);
        const backup = asset.uri.with({ path: `${asset.uri.path}.bak` });
        try {
          await vscode.workspace.fs.stat(backup);
        } catch {
          await vscode.workspace.fs.writeFile(backup, original);
        }
        await vscode.workspace.fs.writeFile(asset.uri, result.file);
        this.post({ type: 'optimizeProgress', uri: job.uri, ok: true, before: result.before.graphics, after: result.after.graphics, changed: result.changed.length, skipped: result.skipped });
      } catch (err) {
        this.post({ type: 'optimizeProgress', uri: job.uri, ok: false, error: (err as Error).message });
      }
    }
    this.post({ type: 'optimizeDone' });
    void this.index.refresh();
  }
}
