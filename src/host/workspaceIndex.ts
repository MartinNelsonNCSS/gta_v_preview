import * as vscode from 'vscode';
import { joaat } from '../formats/hash';
import {
  ASSET_KINDS,
  AssetKind,
  AssetSummary,
  headerSummary,
  ManifestInfo,
  parseManifest,
  summarizeMeta,
  summarizeResource,
  SYSTEM_ONLY_KINDS,
} from '../formats/scan';
import { basename, dirname } from './assetIndex';
import { readSystemSegment } from './fileAccess';

/** A FiveM resource: a folder with an fxmanifest.lua (or __resource.lua). */
export interface ResourceInfo {
  name: string;
  root: vscode.Uri;
  manifest?: vscode.Uri;
  manifestInfo?: ManifestInfo;
}

export interface IndexedAsset {
  uri: vscode.Uri;
  /** File name, e.g. `prop_x.ydr`. */
  file: string;
  /** Lower-case name without extension. */
  base: string;
  kind: AssetKind;
  /** joaat of `base`, for matching hashed names. */
  hash: number;
  resource: ResourceInfo;
  /** Path relative to the resource root, with forward slashes. */
  rel: string;
  mtime: number;
  summary: AssetSummary;
}

const GLOB = `**/*.{${ASSET_KINDS.join(',')}}`;
const EXCLUDE = '**/{node_modules,.git}/**';
const MAX_FILES = 50_000;
const CONCURRENCY = 8;

/**
 * Workspace-wide index of GTA V asset files and their summaries, shared by
 * the health check, the texture optimiser and the asset browser. Summaries
 * are cached per file (by mtime) and refreshed incrementally on change.
 */
export class WorkspaceIndex implements vscode.Disposable {
  private readonly assets = new Map<string, IndexedAsset>();
  private resources: ResourceInfo[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [];
  private scanning?: Promise<void>;
  private dirty = true;
  private timer?: ReturnType<typeof setTimeout>;
  scanned = false;

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher(`{${GLOB},**/fxmanifest.lua,**/__resource.lua}`);
    const onChange = () => {
      this.dirty = true;
      // Only rescan automatically once the user has scanned at least once.
      if (!this.scanned) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.refresh(), 1500);
    };
    watcher.onDidChange(onChange, undefined, this.disposables);
    watcher.onDidCreate(onChange, undefined, this.disposables);
    watcher.onDidDelete(onChange, undefined, this.disposables);
    this.disposables.push(watcher, this.changed);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
  }

  get all(): IndexedAsset[] {
    return [...this.assets.values()];
  }

  get resourceList(): ResourceInfo[] {
    return this.resources;
  }

  /** Makes sure the index is up to date (scanning with a progress notification if needed). */
  async ensure(): Promise<void> {
    if (this.dirty || !this.scanned) await this.refresh(true);
  }

  /** Rescans the workspace; unchanged files reuse their cached summaries. */
  refresh(showProgress = false): Promise<void> {
    this.scanning ??= (async () => {
      try {
        if (showProgress) {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Scanning GTA V assets', cancellable: false },
            (progress) => this.scan((done, total) => progress.report({ message: `${done} / ${total}`, increment: (100 / Math.max(total, 1)) * 1 }))
          );
        } else {
          await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Scanning GTA V assets' }, () => this.scan());
        }
        this.dirty = false;
        this.scanned = true;
        this.changed.fire();
      } finally {
        this.scanning = undefined;
      }
    })();
    return this.scanning;
  }

  private async scan(report?: (done: number, total: number) => void): Promise<void> {
    const [files, manifests] = await Promise.all([
      vscode.workspace.findFiles(GLOB, EXCLUDE, MAX_FILES),
      vscode.workspace.findFiles('**/{fxmanifest.lua,__resource.lua}', EXCLUDE, 5000),
    ]);

    // Resources, deepest first so nested resources win.
    const resources: ResourceInfo[] = [];
    for (const m of manifests) {
      let manifestInfo: ManifestInfo | undefined;
      try {
        manifestInfo = parseManifest(new TextDecoder().decode(await vscode.workspace.fs.readFile(m)));
      } catch {
        manifestInfo = undefined;
      }
      const root = dirname(m);
      resources.push({ name: basename(root), root, manifest: m, manifestInfo });
    }
    resources.sort((a, b) => b.root.path.length - a.root.path.length);
    const loose = new Map<string, ResourceInfo>();
    const resourceFor = (uri: vscode.Uri): ResourceInfo => {
      const path = uri.path.toLowerCase();
      const found = resources.find((r) => path.startsWith(r.root.path.toLowerCase() + '/'));
      if (found) return found;
      // Not in a resource: group by the workspace folder's top-level folder.
      const ws = vscode.workspace.getWorkspaceFolder(uri);
      const rel = ws ? uri.path.slice(ws.uri.path.length + 1) : uri.path;
      const top = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '';
      const root = ws ? (top ? vscode.Uri.joinPath(ws.uri, top) : ws.uri) : dirname(uri);
      const key = root.toString();
      if (!loose.has(key)) loose.set(key, { name: `${basename(root)} (no fxmanifest)`, root });
      return loose.get(key)!;
    };

    const names = files.map((f) => basename(f).replace(/\.[^.]+$/, ''));
    const seen = new Set<string>();
    let done = 0;
    const queue = [...files];
    const worker = async () => {
      for (let uri = queue.shift(); uri; uri = queue.shift()) {
        const key = uri.toString();
        seen.add(key);
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          const cached = this.assets.get(key);
          const resource = resourceFor(uri);
          if (cached && cached.mtime === stat.mtime) {
            cached.resource = resource;
            cached.rel = uri.path.slice(resource.root.path.length + 1);
          } else {
            const file = basename(uri);
            const kind = file.split('.').pop()!.toLowerCase() as AssetKind;
            const base = file.slice(0, file.lastIndexOf('.')).toLowerCase();
            this.assets.set(key, {
              uri,
              file,
              base,
              kind,
              hash: joaat(base),
              resource,
              rel: uri.path.slice(resource.root.path.length + 1),
              mtime: stat.mtime,
              summary: await summarize(uri, kind, names),
            });
          }
        } catch {
          // Unreadable file: leave it out.
        }
        report?.(++done, files.length);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    for (const key of [...this.assets.keys()]) if (!seen.has(key)) this.assets.delete(key);
    this.resources = [...resources, ...loose.values()];
  }

  // -- lookups ------------------------------------------------------------------

  /** Assets whose base name (or its hash) matches `name` (plain or `hash_XXXXXXXX`). */
  byName(name: string, kinds?: AssetKind[]): IndexedAsset[] {
    const hash = nameHash(name);
    return this.all.filter((a) => a.hash === hash && (!kinds || kinds.includes(a.kind)));
  }

  assetsOf(resource: ResourceInfo): IndexedAsset[] {
    return this.all.filter((a) => a.resource === resource);
  }
}

async function summarize(uri: vscode.Uri, kind: AssetKind, names: string[]): Promise<AssetSummary> {
  if (SYSTEM_ONLY_KINDS.includes(kind)) {
    const read = await readSystemSegment(uri);
    if (!read.res) return headerSummary(kind, read.head, read.error);
    return summarizeResource(kind, read.head, read.res);
  }
  return summarizeMeta(kind, await vscode.workspace.fs.readFile(uri), names);
}

/** Hash of a plain name or an unresolved `hash_XXXXXXXX` placeholder. */
export function nameHash(name: string): number {
  const m = /^hash_([0-9a-f]{8})$/i.exec(name);
  return m ? parseInt(m[1], 16) : joaat(name);
}
