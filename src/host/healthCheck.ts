import * as vscode from 'vscode';
import { globToRegExp } from '../formats/scan';
import type { TextureInfo } from '../formats/scan';
import { IndexedAsset, nameHash, ResourceInfo, WorkspaceIndex } from './workspaceIndex';

/**
 * Workspace checks for FiveM resources, reported in the Problems panel and
 * the Resource Health view. Thresholds for memory mirror FiveM's own
 * "oversized asset" warnings (16/32/48 MiB of virtual or physical memory).
 */

const MiB = 1024 * 1024;
const S = vscode.DiagnosticSeverity;

export interface Issue {
  uri: vscode.Uri;
  line?: number;
  severity: vscode.DiagnosticSeverity;
  code: string;
  message: string;
  resource: ResourceInfo;
}

const mib = (n: number) => `${(n / MiB).toFixed(1)} MiB`;
const list = (names: string[], max = 5) => names.slice(0, max).join(', ') + (names.length > max ? `, … (${names.length - max} more)` : '');

export function runChecks(index: WorkspaceIndex): Issue[] {
  const issues: Issue[] = [];
  const assets = index.all;
  const add = (a: IndexedAsset | { uri: vscode.Uri; resource: ResourceInfo }, severity: vscode.DiagnosticSeverity, code: string, message: string, line?: number) =>
    issues.push({ uri: a.uri, resource: a.resource, severity, code, message, line });

  // Lookups shared by several checks.
  const ytdTextures = new Set<string>();
  for (const a of assets) for (const t of a.summary.textures ?? []) ytdTextures.add(t.name.toLowerCase());
  const archetypeDefs = new Set<number>();
  for (const a of assets) for (const ar of a.summary.archetypes ?? []) archetypeDefs.add(nameHash(ar.name));
  const modelHashes = new Set<number>();
  for (const a of assets) {
    if (a.kind === 'ydr' || a.kind === 'yft') modelHashes.add(a.hash);
    if (a.kind === 'ydd') for (const d of a.summary.drawables ?? []) if (d.name) modelHashes.add(nameHash(d.name));
  }
  const hasFile = (name: string, kind: string) => assets.some((a) => a.kind === kind && a.hash === nameHash(name));
  const resourcesWithEncryptedYtd = new Set(assets.filter((a) => a.kind === 'ytd' && a.summary.encrypted).map((a) => a.resource));

  for (const a of assets) {
    const s = a.summary;
    if (s.encrypted) {
      add(a, S.Information, 'encrypted', 'Encrypted by FiveM asset escrow (FXAP); its contents can’t be checked or previewed.');
      continue;
    }
    if (s.error) {
      add(a, S.Warning, 'unreadable', `Couldn’t read this file: ${s.error}`);
      continue;
    }

    // Oversized assets (same thresholds as FiveM's warning).
    for (const [kind, size] of [['physical (graphics)', s.graphicsSize], ['virtual (system)', s.systemSize]] as const) {
      if (size <= 16 * MiB) continue;
      const severity = size > 48 * MiB ? S.Error : size > 32 * MiB ? S.Warning : S.Information;
      const textures = [...(s.textures ?? []), ...(s.drawables ?? []).flatMap((d) => d.textures)].sort((x, y) => y.size - x.size);
      const biggest = kind.startsWith('physical') && textures.length ? ` Largest textures: ${list(textures.map((t) => `${t.name} (${t.width}×${t.height} ${t.format}, ${mib(t.size)})`), 3)}.` : '';
      const tip = kind.startsWith('physical') && textures.length ? ' Run "GTA V: Optimize Textures…" to shrink them.' : '';
      add(a, severity, 'oversized', `Uses ${mib(size)} of ${kind} memory; FiveM warns above 16 MiB and oversized assets can fail to stream.${biggest}${tip}`);
    }

    // Missing textures (skipped where encrypted dictionaries could be hiding them).
    if (s.drawables && !resourcesWithEncryptedYtd.has(a.resource)) {
      const embedded = new Set(s.drawables.flatMap((d) => d.textures.map((t) => t.name.toLowerCase())));
      const missing = [...new Set(s.drawables.flatMap((d) => d.refs))].filter((n) => !embedded.has(n) && !ytdTextures.has(n) && n !== 'none' && n !== 'givemechecker');
      if (missing.length) {
        add(
          a,
          S.Information,
          'missing-texture',
          `${missing.length} texture${missing.length === 1 ? '' : 's'} not found in any .ytd in the workspace: ${list(missing)}. Fine if they’re base-game textures; otherwise the model will render untextured.`
        );
      }
    }

    // Archetypes without a model file.
    if (s.archetypes) {
      const noModel = s.archetypes.filter((ar) => {
        if (ar.type === 'CMloArchetypeDef' || /ASSETLESS/.test(ar.assetType)) return false;
        if (ar.drawableDictionary) return !hasFile(ar.drawableDictionary, 'ydd');
        if (/FRAGMENT/.test(ar.assetType)) return !hasFile(ar.name, 'yft');
        return !modelHashes.has(nameHash(ar.name));
      });
      if (noModel.length) {
        add(a, S.Warning, 'missing-model', `${noModel.length} archetype${noModel.length === 1 ? ' has' : 's have'} no model file in the workspace: ${list(noModel.map((x) => x.name))}.`);
      }
    }

    // Map entities whose archetype isn't defined here.
    if (s.entities) {
      const unknown = s.entities.filter((e) => !archetypeDefs.has(nameHash(e.archetype)) && !modelHashes.has(nameHash(e.archetype)));
      const interiors = unknown.filter((e) => e.mloInstance);
      if (interiors.length) {
        add(a, S.Warning, 'missing-interior', `Places interior${interiors.length === 1 ? '' : 's'} not defined by any .ytyp in the workspace: ${list(interiors.map((e) => e.archetype))}.`);
      }
      const props = unknown.filter((e) => !e.mloInstance);
      if (props.length) {
        add(a, S.Information, 'unknown-archetype', `${props.length} placed archetype${props.length === 1 ? ' isn’t' : 's aren’t'} defined in the workspace (expected for base-game props): ${list(props.map((e) => e.archetype))}.`);
      }
    }

    // Texture hints the optimiser can fix.
    const hints = textureHints([...(s.textures ?? []), ...(s.drawables ?? []).flatMap((d) => d.textures)]);
    if (hints.length) {
      add(a, S.Hint, 'texture-hint', `${hints.length} texture${hints.length === 1 ? '' : 's'} could be optimised: ${list(hints)}.`);
    }
  }

  // Name clashes: FiveM streams by file name, so duplicates override each other.
  const byFile = new Map<string, IndexedAsset[]>();
  for (const a of assets) {
    const key = a.file.toLowerCase();
    byFile.set(key, [...(byFile.get(key) ?? []), a]);
  }
  for (const group of byFile.values()) {
    if (group.length < 2) continue;
    for (const a of group) {
      const others = group.filter((o) => o !== a).map((o) => `${o.resource.name}/${o.rel}`);
      add(a, S.Warning, 'duplicate', `${a.file} is also streamed by ${list(others, 3)}; only one of them will load.`);
    }
  }

  // Manifest checks.
  for (const r of index.resourceList) {
    if (!r.manifest || !r.manifestInfo) continue;
    const mine = index.assetsOf(r);
    const ityp = r.manifestInfo.dataFiles.filter((d) => d.type === 'DLC_ITYP_REQUEST').map((d) => globToRegExp(d.pattern));
    const unlisted = mine.filter((a) => a.kind === 'ytyp' && !ityp.some((re) => re.test(a.rel)));
    for (const a of unlisted) {
      add(a, S.Warning, 'manifest-ytyp', `Not listed in ${r.name}'s fxmanifest as data_file 'DLC_ITYP_REQUEST', so its archetypes won’t be registered. Add: data_file 'DLC_ITYP_REQUEST' '${a.rel}'`);
    }
    if (unlisted.length) {
      add({ uri: r.manifest, resource: r }, S.Warning, 'manifest-ytyp', `${unlisted.length} streamed .ytyp file${unlisted.length === 1 ? ' isn’t' : 's aren’t'} listed as data_file 'DLC_ITYP_REQUEST': ${list(unlisted.map((a) => a.rel))}.`, 0);
    }
    if (mine.some((a) => a.kind === 'ymap') && !r.manifestInfo.thisIsAMap) {
      add({ uri: r.manifest, resource: r }, S.Information, 'manifest-map', `This resource streams .ymap files; map resources usually declare this_is_a_map 'yes'.`, 0);
    }
  }
  return issues;
}

/** Short descriptions of textures worth optimising. */
export function textureHints(textures: TextureInfo[]): string[] {
  const out: string[] = [];
  for (const t of textures) {
    const why: string[] = [];
    if (Math.max(t.width, t.height) > 4096) why.push(`${t.width}×${t.height}`);
    if (t.levels === 1 && Math.max(t.width, t.height) > 64) why.push('no mipmaps');
    if (/^(A8R8G8B8|X8R8G8B8|A8B8G8R8)$/.test(t.format) && t.size > 256 * 1024) why.push(`uncompressed ${mib(t.size)}`);
    if (why.length) out.push(`${t.name} (${why.join(', ')})`);
  }
  return out;
}

/** Publishes issues to the Problems panel. */
export class HealthDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('gtaPreview');
  issues: Issue[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  ran = false;

  constructor(private readonly index: WorkspaceIndex) {
    // Keep results current as files change, once a check has been run.
    index.onDidChange(() => {
      if (this.ran) this.update();
    });
  }

  async run(): Promise<void> {
    await this.index.ensure();
    this.ran = true;
    this.update();
  }

  private update(): void {
    this.issues = runChecks(this.index);
    const byUri = new Map<string, { uri: vscode.Uri; diags: vscode.Diagnostic[] }>();
    for (const i of this.issues) {
      const range = new vscode.Range(i.line ?? 0, 0, i.line ?? 0, i.line === undefined ? 0 : 200);
      const d = new vscode.Diagnostic(range, i.message, i.severity);
      d.source = 'GTA V';
      d.code = i.code;
      const key = i.uri.toString();
      if (!byUri.has(key)) byUri.set(key, { uri: i.uri, diags: [] });
      byUri.get(key)!.diags.push(d);
    }
    this.collection.clear();
    for (const { uri, diags } of byUri.values()) this.collection.set(uri, diags);
    this.changed.fire();
  }

  dispose(): void {
    this.collection.dispose();
    this.changed.dispose();
  }
}
