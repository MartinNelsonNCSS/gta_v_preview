import * as vscode from 'vscode';
import type { HostToWebview, WebviewToHost } from '../shared/model';
import { basename, dirname } from './assetIndex';
import { webviewHtml } from './previewProvider';

/** Image types the converter accepts (decoded in the webview). */
export const CONVERTIBLE = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'dds'];

/** Registers "GTA V: Convert to DDS…" (Explorer context menu and command palette). */
export function registerConverter(context: vscode.ExtensionContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('gtaPreview.convertToDds', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      let files = uris?.length ? uris : uri ? [uri] : undefined;
      files ??= await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'Convert',
        filters: { Images: CONVERTIBLE },
      });
      files = files?.filter((f) => CONVERTIBLE.includes(basename(f).split('.').pop()?.toLowerCase() ?? ''));
      if (!files?.length) return;
      new ConverterPanel(context, files);
    }),
  ];
}

/** A webview panel that converts images to .dds (DXT1/DXT5/... with mipmaps). */
class ConverterPanel {
  private readonly panel: vscode.WebviewPanel;

  constructor(context: vscode.ExtensionContext, private readonly files: vscode.Uri[]) {
    const dist = vscode.Uri.joinPath(context.extensionUri, 'dist');
    const title = files.length === 1 ? `Convert ${basename(files[0])} to DDS` : `Convert ${files.length} images to DDS`;
    this.panel = vscode.window.createWebviewPanel('gtaPreview.ddsConverter', title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [dist],
    });
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
    this.panel.webview.html = webviewHtml(this.panel.webview, dist, 'converter');
    this.panel.webview.onDidReceiveMessage((m: WebviewToHost) => void this.onMessage(m));
  }

  private post(m: HostToWebview): void {
    void this.panel.webview.postMessage(m);
  }

  private async onMessage(m: WebviewToHost): Promise<void> {
    if (m.type === 'ready') {
      const files = await Promise.all(
        this.files.map(async (uri) => ({ name: basename(uri), uri: uri.toString(), data: await vscode.workspace.fs.readFile(uri) }))
      );
      this.post({ type: 'converterFiles', files });
    } else if (m.type === 'writeConverted') {
      await this.write(m.requestId, m.sourceUri, m.data, m.overwrite, m.format);
    }
  }

  private async write(requestId: number, sourceUri: string, data: Uint8Array, overwrite: boolean, format: string): Promise<void> {
    try {
      const source = vscode.Uri.parse(sourceUri, true);
      if (!this.files.some((f) => f.toString() === source.toString())) throw new Error('Unknown source file.');
      const stem = basename(source).replace(/\.[^.]+$/, '');
      // A .dds source keeps its file; the result gets the format in its name.
      const name = /\.dds$/i.test(basename(source)) ? `${stem}_${format}.dds` : `${stem}.dds`;
      const targetUri = vscode.Uri.joinPath(dirname(source), name);
      let replaceAll = false;
      if (!overwrite && (await exists(targetUri))) {
        const choice = await vscode.window.showWarningMessage(
          `${name} already exists. Replace it?`,
          { modal: true },
          ...(this.files.length > 1 ? ['Replace', 'Replace All', 'Skip'] : ['Replace'])
        );
        if (choice === 'Replace All') replaceAll = true;
        else if (choice !== 'Replace') {
          this.post({ type: 'converted', requestId, ok: false, skipped: true });
          return;
        }
      }
      await vscode.workspace.fs.writeFile(targetUri, data);
      this.post({ type: 'converted', requestId, ok: true, path: targetUri.fsPath || targetUri.path, replaceAll });
    } catch (err) {
      this.post({ type: 'converted', requestId, ok: false, error: (err as Error).message });
    }
  }
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
