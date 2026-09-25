import * as vscode from 'vscode';
import { parseYdd, parseYdr } from '../formats/drawable';
import { joaat } from '../formats/hash';
import { listYtdTextureNames, parseYtd, readYtdTextures } from '../formats/ytd';
import { parseYtyp } from '../formats/ytyp';
import { parseYmap } from '../formats/ymap';
import { parseYbn } from '../formats/bounds';
import { parseYft } from '../formats/yft';
import { parseYmt } from '../formats/ymt';
import { exportDds, readFullTexture, replaceTexture, TextureFileKind } from '../formats/textureEdit';
import type {
  ArchetypeData,
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
  fragment: 'gtaPreview.yft',
  ytyp: 'gtaPreview.ytyp',
  ytd: 'gtaPreview.ytd',
  ymap: 'gtaPreview.ymap',
  ybn: 'gtaPreview.ybn',
  ymt: 'gtaPreview.ymt',
};

/** Meta formats that also exist as XML (CodeWalker/Sollumz exports, hand-edited files). */
const META_KINDS: ViewKind[] = ['ytyp', 'ymap', 'ymt'];

/** Texture names per .ytd, keyed by URI and invalidated by mtime. */
const ytdNameCache = new Map<string, { mtime: number; names: Set<string> }>();
/** Archetype definitions per .ytyp, keyed by URI and invalidated by mtime. */
const ytypCache = new Map<string, { mtime: number; archetypes: ArchetypeData[] }>();

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
  private archetypeIndexPromise?: Promise<Map<number, ArchetypeData>>;
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
        case 'loadDrawableFile':
          await this.loadDrawableFile(message.requestId, message.name, message.maxTextureSize);
          break;
        case 'loadTextureFile':
          await this.loadTextureFile(message.requestId, message.name, message.maxSize);
          break;
        case 'pickImage':
          await this.pickImage(message.requestId);
          break;
        case 'getFullTexture':
          await this.getFullTexture(message.requestId, message.origin, message.name);
          break;
        case 'replaceTexture':
          await this.replaceTexture(message);
          break;
        case 'exportDds':
          await this.exportDds(message.requestId, message.origin, message.name);
          break;
        case 'saveFile':
          await this.saveFile(message.requestId, message.suggestedName, message.data, message.filterName, message.extensions);
          break;
        case 'openAsText':
          await vscode.commands.executeCommand('vscode.openWith', this.uri, 'default');
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
    if (META_KINDS.includes(this.kind) && looksLikeXml(data)) {
      this.post({
        type: 'text',
        file,
        text: new TextDecoder().decode(data.subarray(0, 512 * 1024)),
        note: 'This file is XML rather than a binary resource.',
      });
      return;
    }
    try {
      switch (this.kind) {
        case 'drawable':
          this.post({ type: 'drawables', file, kind: 'drawable', drawables: withOrigin([parseYdr(data, { maxSize })], this.uri) });
          break;
        case 'dictionary':
          this.post({ type: 'drawables', file, kind: 'dictionary', drawables: withOrigin(parseYdd(data, { maxSize }), this.uri) });
          break;
        case 'fragment':
          this.post({ type: 'drawables', file, kind: 'fragment', drawables: withOrigin(parseYft(data, { maxSize }), this.uri) });
          break;
        case 'ytd':
          this.post({ type: 'ytd', file, textures: tagOrigin(parseYtd(data, { maxSize }), this.uri) });
          break;
        case 'ytyp':
          // File names nearby let us turn most name hashes back into names.
          this.post({ type: 'ytyp', file, ytyp: parseYtyp(data, { knownNames: await this.knownNames() }) });
          break;
        case 'ymap':
          this.post({ type: 'ymap', file, ymap: parseYmap(data, { knownNames: await this.knownNames() }) });
          break;
        case 'ybn':
          this.post({ type: 'ybn', file, bounds: parseYbn(data) });
          break;
        case 'ymt': {
          // Ped variation files describe models/textures that sit next to them.
          const dir = dirname(this.uri).path.toLowerCase() + '/';
          const files = (await this.index.all())
            .filter((f) => ['ydd', 'ydr', 'yft', 'ytd'].includes(f.ext) && f.uri.path.toLowerCase().startsWith(dir))
            .map((f) => `${f.base}.${f.ext}`);
          this.post({ type: 'ymt', file, ymt: parseYmt(data, { knownNames: await this.knownNames() }), files });
          break;
        }
      }
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  /** Names of nearby files, used to resolve name hashes. */
  private async knownNames(): Promise<string[]> {
    return (await this.index.all()).map((f) => f.base);
  }

  /**
   * Archetype definitions from every .ytyp in scope, keyed by name hash. Lets
   * .ymap entities find their drawable dictionary and MLO interior layouts.
   */
  private async archetypeIndex(): Promise<Map<number, ArchetypeData>> {
    this.archetypeIndexPromise ??= (async () => {
      const index = new Map<number, ArchetypeData>();
      const names = await this.knownNames();
      for (const ytyp of await this.index.byExt('ytyp')) {
        try {
          const key = ytyp.uri.toString();
          const stat = await vscode.workspace.fs.stat(ytyp.uri);
          let entry = ytypCache.get(key);
          if (!entry || entry.mtime !== stat.mtime) {
            const parsed = parseYtyp(await vscode.workspace.fs.readFile(ytyp.uri), { knownNames: names });
            entry = { mtime: stat.mtime, archetypes: parsed.archetypes };
            ytypCache.set(key, entry);
          }
          for (const a of entry.archetypes) {
            const hash = nameToHash(a.name);
            if (!index.has(hash)) index.set(hash, a);
          }
        } catch {
          // Skip unreadable .ytyp files.
        }
      }
      return index;
    })();
    return this.archetypeIndexPromise;
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
      return tagOrigin(readYtdTextures(data, matches, opts), ytd.uri);
    } catch {
      return []; // Encrypted or malformed dictionaries are skipped.
    }
  }

  /**
   * Loads the models behind archetypes (from .ydr, or .ydd when a dictionary is
   * set), along with their definitions from nearby .ytyp files.
   */
  private async loadArchetypes(requestId: number, requests: ArchetypeRequest[], maxTextureSize?: number): Promise<void> {
    const opts = { maxSize: Math.min(maxTextureSize ?? Infinity, config('maxTextureSize', 1024)) };
    const files = await this.index.all();
    const defs = await this.archetypeIndex();
    const find = (name: string, ext: string) => {
      const hash = nameToHash(name);
      return files.find((f) => f.ext === ext && f.hash === hash);
    };

    let models: Record<string, DrawableData | null> = {};
    let archetypes: Record<string, ArchetypeData | null> = {};
    let count = 0;
    for (const req of requests) {
      if (this.disposed) return;
      const def = defs.get(nameToHash(req.name)) ?? null;
      archetypes[req.name] = def;
      const dictionary = req.dictionary || def?.drawableDictionary || undefined;
      models[req.name] = def?.mlo ? null : await this.loadArchetype({ ...req, dictionary }, find, opts).catch(() => null);
      if (++count % ARCHETYPE_BATCH === 0) {
        this.post({ type: 'archetypeModels', requestId, models, archetypes, done: false });
        models = {};
        archetypes = {};
      }
    }
    this.post({ type: 'archetypeModels', requestId, models, archetypes, done: true });
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
        if (match) return withOrigin([match], ydd.uri)[0];
      }
    }
    const ydr = find(req.name, 'ydr');
    if (ydr) return withOrigin([parseYdr(await vscode.workspace.fs.readFile(ydr.uri), opts)], ydr.uri)[0];
    // Fragments (vehicles, breakables): use the main drawable.
    const yft = find(req.name, 'yft');
    if (yft) return withOrigin(parseYft(await vscode.workspace.fs.readFile(yft.uri), opts), yft.uri)[0] ?? null;
    return null;
  }

  /** Loads all drawables from a model file located by base name (e.g. a ped component .ydd). */
  private async loadDrawableFile(requestId: number, name: string, maxTextureSize?: number): Promise<void> {
    const opts = { maxSize: Math.min(maxTextureSize ?? Infinity, config('maxTextureSize', 1024)) };
    const base = name.toLowerCase();
    const candidates = (await this.index.all()).filter((f) => f.base === base && ['ydd', 'ydr', 'yft'].includes(f.ext));
    const file = candidates.sort((a, b) => ['ydd', 'ydr', 'yft'].indexOf(a.ext) - ['ydd', 'ydr', 'yft'].indexOf(b.ext))[0];
    if (!file) {
      this.post({ type: 'drawableFile', requestId, drawables: [], error: `${name} was not found.` });
      return;
    }
    try {
      const data = await vscode.workspace.fs.readFile(file.uri);
      const drawables = file.ext === 'ydd' ? parseYdd(data, opts) : file.ext === 'yft' ? parseYft(data, opts) : [parseYdr(data, opts)];
      this.post({ type: 'drawableFile', requestId, drawables: withOrigin(drawables, file.uri) });
    } catch (err) {
      this.post({ type: 'drawableFile', requestId, drawables: [], error: (err as Error).message });
    }
  }

  private async loadTextureFile(requestId: number, name: string, maxSize?: number): Promise<void> {
    const opts = { maxSize: Math.min(maxSize ?? Infinity, config('maxTextureSize', 1024)) };
    const base = name.toLowerCase();
    const file = (await this.index.byExt('ytd')).find((f) => f.base === base);
    if (!file) {
      this.post({ type: 'textureFile', requestId, textures: [], error: `${name}.ytd was not found.` });
      return;
    }
    try {
      this.post({ type: 'textureFile', requestId, textures: tagOrigin(parseYtd(await vscode.workspace.fs.readFile(file.uri), opts), file.uri) });
    } catch (err) {
      this.post({ type: 'textureFile', requestId, textures: [], error: (err as Error).message });
    }
  }

  // -- texture editing ------------------------------------------------------------

  private async pickImage(requestId: number): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Use image',
      defaultUri: dirname(this.uri),
      filters: { Images: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'dds'] },
    });
    if (!picked?.[0]) {
      this.post({ type: 'pickedImage', requestId });
      return;
    }
    this.post({ type: 'pickedImage', requestId, name: basename(picked[0]), data: await vscode.workspace.fs.readFile(picked[0]) });
  }

  /** Resolves a texture origin sent by the webview, allowing only existing resource files. */
  private async textureFile(origin: string): Promise<{ uri: vscode.Uri; kind: TextureFileKind }> {
    const uri = vscode.Uri.parse(origin, true);
    const ext = basename(uri).split('.').pop()?.toLowerCase() as TextureFileKind;
    if (!['ytd', 'ydr', 'ydd', 'yft'].includes(ext)) throw new Error(`Not a texture container: ${basename(uri)}`);
    await vscode.workspace.fs.stat(uri); // throws if it doesn't exist
    return { uri, kind: ext };
  }

  private async getFullTexture(requestId: number, origin: string, name: string): Promise<void> {
    try {
      const { uri, kind } = await this.textureFile(origin);
      const texture = readFullTexture(await vscode.workspace.fs.readFile(uri), kind, name);
      this.post({ type: 'fullTexture', requestId, texture: { ...texture, origin } });
    } catch (err) {
      this.post({ type: 'fullTexture', requestId, error: (err as Error).message });
    }
  }

  private async replaceTexture(m: Extract<WebviewToHost, { type: 'replaceTexture' }>): Promise<void> {
    try {
      const { uri, kind } = await this.textureFile(m.origin);
      const file = basename(uri);
      const choice = await vscode.window.showWarningMessage(
        `Replace texture "${m.name}" in ${file}?`,
        {
          modal: true,
          detail: `The texture is saved at ${m.width}×${m.height}, re-encoded in its current format with a full set of mipmaps. The original file is kept as ${file}.bak.`,
        },
        'Replace'
      );
      if (choice !== 'Replace') {
        this.post({ type: 'textureReplaced', requestId: m.requestId, ok: false, cancelled: true });
        return;
      }
      const original = await vscode.workspace.fs.readFile(uri);
      const updated = replaceTexture(original, kind, m.name, m.rgba, m.width, m.height);
      // Keep the first original as a backup; later saves don't overwrite it.
      const backup = uri.with({ path: `${uri.path}.bak` });
      try {
        await vscode.workspace.fs.stat(backup);
      } catch {
        await vscode.workspace.fs.writeFile(backup, original);
      }
      await vscode.workspace.fs.writeFile(uri, updated);
      this.post({ type: 'textureReplaced', requestId: m.requestId, ok: true, file });
    } catch (err) {
      this.post({ type: 'textureReplaced', requestId: m.requestId, ok: false, error: (err as Error).message });
    }
  }

  private async exportDds(requestId: number, origin: string, name: string): Promise<void> {
    try {
      const { uri, kind } = await this.textureFile(origin);
      const dds = exportDds(await vscode.workspace.fs.readFile(uri), kind, name);
      await this.saveFile(requestId, `${name}.dds`, dds, 'DDS texture', ['dds']);
    } catch (err) {
      this.post({ type: 'saved', requestId, error: (err as Error).message });
    }
  }

  private async saveFile(requestId: number, suggestedName: string, data: Uint8Array, filterName: string, extensions: string[]): Promise<void> {
    try {
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(dirname(this.uri), suggestedName.replace(/[\\/:*?"<>|]/g, '_')),
        filters: { [filterName]: extensions },
      });
      if (!target) {
        this.post({ type: 'saved', requestId, cancelled: true });
        return;
      }
      await vscode.workspace.fs.writeFile(target, data);
      this.post({ type: 'saved', requestId, path: target.fsPath || target.path });
    } catch (err) {
      this.post({ type: 'saved', requestId, error: (err as Error).message });
    }
  }

  private async openAsset(name: string, ext: 'ydr' | 'ydd' | 'yft' | 'ytd'): Promise<void> {
    const hash = nameToHash(name);
    const file = (await this.index.byExt(ext)).find((f) => f.hash === hash);
    if (!file) {
      void vscode.window.showWarningMessage(`Could not find ${name}.${ext} near ${basename(this.uri)}.`);
      return;
    }
    const kind = ({ ydr: 'drawable', ydd: 'dictionary', yft: 'fragment', ytd: 'ytd' } as const)[ext];
    await vscode.commands.executeCommand('vscode.openWith', file.uri, VIEW_TYPES[kind]);
  }
}

function tagOrigin(textures: TextureData[], uri: vscode.Uri): TextureData[] {
  const origin = uri.toString();
  for (const t of textures) t.origin = origin;
  return textures;
}

function withOrigin(drawables: DrawableData[], uri: vscode.Uri): DrawableData[] {
  for (const d of drawables) tagOrigin(d.textures, uri);
  return drawables;
}

function looksLikeXml(data: Uint8Array): boolean {
  let i = data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? 3 : 0; // UTF-8 BOM
  while (i < data.length && (data[i] === 0x20 || data[i] === 0x09 || data[i] === 0x0a || data[i] === 0x0d)) i++;
  return data[i] === 0x3c; // '<'
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
