import * as vscode from 'vscode';
import { joaat } from '../formats/hash';

export type SearchScope = 'workspace' | 'folder' | 'off';

const ASSET_EXTENSIONS = ['ytd', 'ydr', 'ydd', 'yft', 'ybn', 'ytyp', 'ymap'];
const MAX_WALK_ENTRIES = 5000;
const CACHE_TTL_MS = 30_000;

export interface AssetFile {
  uri: vscode.Uri;
  /** Lower-case file name without extension. */
  base: string;
  ext: string;
  hash: number;
}

export function basename(uri: vscode.Uri): string {
  const p = uri.path;
  return p.slice(p.lastIndexOf('/') + 1);
}

export function dirname(uri: vscode.Uri): vscode.Uri {
  const p = uri.path;
  return uri.with({ path: p.slice(0, Math.max(1, p.lastIndexOf('/'))) });
}

function toAsset(uri: vscode.Uri): AssetFile | undefined {
  const name = basename(uri).toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = name.slice(dot + 1);
  if (!ASSET_EXTENSIONS.includes(ext)) return undefined;
  const base = name.slice(0, dot);
  return { uri, base, ext, hash: joaat(base) };
}

/**
 * Finds GTA asset files near a given file: the whole workspace folder when the
 * file is inside one, otherwise the surrounding folders (FiveM resources often
 * split assets into sibling `stream/[ydr]`, `stream/[ytd]` folders).
 */
export class AssetIndex {
  private static cache = new Map<string, { time: number; files: Promise<AssetFile[]> }>();

  constructor(private readonly file: vscode.Uri, private readonly scope: SearchScope) {}

  /** All asset files in scope, nearest to the previewed file first. */
  async all(): Promise<AssetFile[]> {
    if (this.scope === 'off') return [];
    const root = this.root();
    const key = `${this.scope}|${root.toString()}`;
    const cached = AssetIndex.cache.get(key);
    if (cached && Date.now() - cached.time < CACHE_TTL_MS) return this.sortByDistance(await cached.files);
    const files = this.list(root);
    AssetIndex.cache.set(key, { time: Date.now(), files });
    return this.sortByDistance(await files);
  }

  async byExt(ext: string): Promise<AssetFile[]> {
    return (await this.all()).filter((f) => f.ext === ext);
  }

  private root(): vscode.Uri {
    const dir = dirname(this.file);
    if (this.scope === 'workspace') {
      const ws = vscode.workspace.getWorkspaceFolder(this.file);
      if (ws) return ws.uri;
    }
    // Outside a workspace (or scope "folder"): search from the parent folder.
    return dirname(dir);
  }

  private async list(root: vscode.Uri): Promise<AssetFile[]> {
    const ws = vscode.workspace.getWorkspaceFolder(this.file);
    if (this.scope === 'workspace' && ws && ws.uri.toString() === root.toString()) {
      const pattern = new vscode.RelativePattern(ws, `**/*.{${ASSET_EXTENSIONS.join(',')}}`);
      const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 50_000);
      return uris.map(toAsset).filter((a): a is AssetFile => !!a);
    }
    return this.walk(root, 4);
  }

  /** Bounded recursive directory walk (for files outside any workspace). */
  private async walk(root: vscode.Uri, maxDepth: number): Promise<AssetFile[]> {
    const out: AssetFile[] = [];
    let visited = 0;
    const queue: { uri: vscode.Uri; depth: number }[] = [{ uri: root, depth: 0 }];
    while (queue.length && visited < MAX_WALK_ENTRIES) {
      const { uri, depth } = queue.shift()!;
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(uri);
      } catch {
        continue;
      }
      for (const [name, type] of entries) {
        if (++visited > MAX_WALK_ENTRIES) break;
        const child = vscode.Uri.joinPath(uri, name);
        if (type & vscode.FileType.Directory) {
          if (depth < maxDepth && !name.startsWith('.') && name !== 'node_modules') {
            queue.push({ uri: child, depth: depth + 1 });
          }
        } else {
          const a = toAsset(child);
          if (a) out.push(a);
        }
      }
    }
    return out;
  }

  /** Orders files by how many leading path segments they share with the previewed file. */
  private sortByDistance(files: AssetFile[]): AssetFile[] {
    const mine = dirname(this.file).path.split('/');
    const score = (f: AssetFile) => {
      const theirs = dirname(f.uri).path.split('/');
      let i = 0;
      while (i < mine.length && i < theirs.length && mine[i] === theirs[i]) i++;
      // Prefer shared prefix, then shallower paths.
      return i * 1000 - theirs.length;
    };
    return [...files].sort((a, b) => score(b) - score(a));
  }
}
