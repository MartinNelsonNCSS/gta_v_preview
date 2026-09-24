import * as vscode from 'vscode';
import { parseYdd, parseYdr } from '../formats/drawable';
import { joaat } from '../formats/hash';
import { listYtdTextureNames, parseYtd, readYtdTextures } from '../formats/ytd';
import { parseYtyp } from '../formats/ytyp';
import type {
  ArchetypeRequest,
  DrawableData,
  HostToWebview,
  TextureData,
  ViewKind,
  WebviewToHost,
} from '../shared/model';
import { AssetFile, AssetIndex, basename, dirname, SearchScope } from './assetIndex';

export const VIEW_TYPES: Record<ViewKind, string> = {
  drawable: 'gtaPreview.ydr',
  dictionary: 'gtaPreview.ydd',
  ytyp: 'gtaPreview.ytyp',
  ytd: 'gtaPreview.ytd',
};

/** Texture names per .ytd, keyed by URI and invalidated by mtime. */
const ytdNameCache = new Map<string, { mtime: number; names: Set<string> }>();

/** Stops scanning after this many dictionaries per texture request. */
const MAX_YTD_SCAN = 400;
/** Archetype models are sent to the webview in batches of this size. */
const ARCHETYPE_BATCH = 8;

class PreviewDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri) {}
  dispose(): void {}
}

export class GtaPreviewProvider implements vscode.CustomReadonlyEditorProvider<PreviewDocument> {
  static register(context: vscode.ExtensionContext): vscode.Disposable[] {
    return (Object.keys(VIEW_TYPES) as ViewKind[]).map((kind) =>
      vscode.window.registerCustomEditorProvider(VIEW_TYPES[kind], new GtaPreviewProvider(context, kind), {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true,
      })
    );
  }

  constructor(private readonly context: vscode.ExtensionContext, private readonly kind: ViewKind) {}

  openCustomDocument(uri: vscode.Uri): PreviewDocument {
    return new PreviewDocument(uri);
  }

  resolveCustomEditor(document: PreviewDocument, panel: vscode.WebviewPanel): void {
    const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    panel.webview.html = this.html(panel.webview, dist);
    const session = new PreviewSession(document.uri, this.kind, panel);
    panel.onDidDispose(() => session.dispose());
  }

  private html(webview: vscode.Webview, dist: vscode.Uri): string {
    const nonce = makeNonce();
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css'));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
</head>
<body data-kind="${this.kind}">
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

/** Handles one open preview: loads the file and answers webview requests. */
class PreviewSession {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly index: AssetIndex;
  private readonly yddCache = new Map<string, Promise<DrawableData[]>>();
  private disposed = false;

  constructor(private readonly uri: vscode.Uri, private readonly kind: ViewKind, private readonly panel: vscode.WebviewPanel) {
    this.index = new AssetIndex(uri, config<SearchScope>('assetSearch', 'workspace'));
    this.disposables.push(panel.webview.onDidReceiveMessage((m: WebviewToHost) => this.onMessage(m)));

    // Live reload when the file is re-exported (e.g. from Sollumz or CodeWalker).
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(dirname(uri), basename(uri))
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reload = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void this.load(), 300);
    };
    watcher.onDidChange(reload, undefined, this.disposables);
    watcher.onDidCreate(reload, undefined, this.disposables);
    this.disposables.push(watcher);
  }

  dispose(): void {
    this.disposed = true;
    this.disposables.forEach((d) => d.dispose());
  }

  private post(message: HostToWebview): void {
    if (!this.disposed) void this.panel.webview.postMessage(message);
  }

  private async onMessage(message: WebviewToHost): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          await this.load();
          break;
        case 'findTextures':
          await this.findTextures(message.requestId, message.names, message.hints, message.maxSize);
          break;
        case 'loadArchetypes':
          await this.loadArchetypes(message.requestId, message.archetypes, message.maxTextureSize);
          break;
        case 'openAsset':
          await this.openAsset(message.name, message.ext);
          break;
      }
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  private async load(): Promise<void> {
    const file = basename(this.uri);
    let data: Uint8Array;
    try {
      data = await vscode.workspace.fs.readFile(this.uri);
    } catch (err) {
      this.post({ type: 'error', message: `Could not read ${file}: ${(err as Error).message}` });
      return;
    }
    const maxSize = config('maxTextureSize', 1024);
    try {
      switch (this.kind) {
        case 'drawable':
          this.post({ type: 'drawables', file, kind: 'drawable', drawables: [parseYdr(data, { maxSize })] });
          break;
        case 'dictionary':
          this.post({ type: 'drawables', file, kind: 'dictionary', drawables: parseYdd(data, { maxSize }) });
          break;
        case 'ytd':
          this.post({ type: 'ytd', file, textures: parseYtd(data, { maxSize }) });
          break;
        case 'ytyp': {
          // File names nearby let us turn most name hashes back into names.
          const names = (await this.index.all()).map((f) => f.base);
          this.post({ type: 'ytyp', file, ytyp: parseYtyp(data, { knownNames: names }) });
          break;
        }
      }
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  /**
   * Looks for textures that the model references but doesn't embed. Dictionaries
   * named in `hints` are searched first, then every .ytd in scope, nearest first.
   */
  private async findTextures(requestId: number, names: string[], hints: string[], maxSize?: number): Promise<void> {
    const wanted = new Set(names.map((n) => n.toLowerCase()));
    const opts = { maxSize: Math.min(maxSize ?? Infinity, config('maxTextureSize', 1024)) };
    const hintSet = new Set(hints.map((h) => h.toLowerCase()));
    const hintHashes = new Set(hints.map((h) => joaat(h)));
    const ytds = await this.index.byExt('ytd');
    const ordered = [
      ...ytds.filter((f) => hintSet.has(f.base) || hintHashes.has(f.hash)),
      ...ytds.filter((f) => !(hintSet.has(f.base) || hintHashes.has(f.hash))),
    ];

    let searched = 0;
    for (const ytd of ordered) {
      if (wanted.size === 0 || searched >= MAX_YTD_SCAN || this.disposed) break;
      searched++;
      const found = await this.texturesFrom(ytd, wanted, opts);
      if (found.length) {
        for (const t of found) wanted.delete(t.name.toLowerCase());
        this.post({ type: 'textures', requestId, textures: found, source: basename(ytd.uri), searched, done: false });
      }
    }
    this.post({ type: 'textures', requestId, textures: [], source: '', searched, done: true });
  }

  private async texturesFrom(ytd: AssetFile, wanted: Set<string>, opts: { maxSize: number }): Promise<TextureData[]> {
    try {
      const key = ytd.uri.toString();
      const stat = await vscode.workspace.fs.stat(ytd.uri);
      let entry = ytdNameCache.get(key);
      let data: Uint8Array | undefined;
      if (!entry || entry.mtime !== stat.mtime) {
        data = await vscode.workspace.fs.readFile(ytd.uri);
        entry = { mtime: stat.mtime, names: new Set(listYtdTextureNames(data).map((n) => n.toLowerCase())) };
        ytdNameCache.set(key, entry);
      }
      const matches = new Set([...wanted].filter((n) => entry!.names.has(n)));
      if (!matches.size) return [];
      data ??= await vscode.workspace.fs.readFile(ytd.uri);
      return readYtdTextures(data, matches, opts);
    } catch {
      return []; // Encrypted or malformed dictionaries are skipped.
    }
  }

  /** Loads the models behind .ytyp archetypes (from .ydr, or .ydd when a dictionary is set). */
  private async loadArchetypes(requestId: number, requests: ArchetypeRequest[], maxTextureSize?: number): Promise<void> {
    const opts = { maxSize: Math.min(maxTextureSize ?? Infinity, config('maxTextureSize', 1024)) };
    const files = await this.index.all();
    const find = (name: string, ext: string) => {
      const hash = nameToHash(name);
      return files.find((f) => f.ext === ext && f.hash === hash);
    };

    let batch: Record<string, DrawableData | null> = {};
    let count = 0;
    for (const req of requests) {
      if (this.disposed) return;
      batch[req.name] = await this.loadArchetype(req, find, opts).catch(() => null);
      if (++count % ARCHETYPE_BATCH === 0) {
        this.post({ type: 'archetypeModels', requestId, models: batch, done: false });
        batch = {};
      }
    }
    this.post({ type: 'archetypeModels', requestId, models: batch, done: true });
  }

  private async loadArchetype(
    req: ArchetypeRequest,
    find: (name: string, ext: string) => AssetFile | undefined,
    opts: { maxSize: number }
  ): Promise<DrawableData | null> {
    if (req.dictionary) {
      const ydd = find(req.dictionary, 'ydd');
      if (ydd) {
        const key = ydd.uri.toString();
        if (!this.yddCache.has(key)) {
          this.yddCache.set(key, Promise.resolve(vscode.workspace.fs.readFile(ydd.uri)).then((d) => parseYdd(d, opts)));
        }
        const hash = nameToHash(req.name);
        const drawables = await this.yddCache.get(key)!;
        const match = drawables.find((d) => d.nameHash === hash || joaat(d.name) === hash);
        if (match) return match;
      }
    }
    const ydr = find(req.name, 'ydr');
    if (!ydr) return null;
    return parseYdr(await vscode.workspace.fs.readFile(ydr.uri), opts);
  }

  private async openAsset(name: string, ext: 'ydr' | 'ydd' | 'ytd'): Promise<void> {
    const hash = nameToHash(name);
    const file = (await this.index.byExt(ext)).find((f) => f.hash === hash);
    if (!file) {
      void vscode.window.showWarningMessage(`Could not find ${name}.${ext} near ${basename(this.uri)}.`);
      return;
    }
    const kind = ext === 'ydr' ? 'drawable' : ext === 'ydd' ? 'dictionary' : 'ytd';
    await vscode.commands.executeCommand('vscode.openWith', file.uri, VIEW_TYPES[kind]);
  }
}

/** Accepts a plain name or an unresolved `hash_XXXXXXXX` placeholder. */
function nameToHash(name: string): number {
  const m = /^hash_([0-9a-f]{8})$/i.exec(name);
  return m ? parseInt(m[1], 16) : joaat(name);
}

function config<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('gtaPreview').get<T>(key, fallback);
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
