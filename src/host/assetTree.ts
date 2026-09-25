import * as vscode from 'vscode';
import type { AssetKind, TextureInfo } from '../formats/scan';
import { HealthDiagnostics, Issue } from './healthCheck';
import { IndexedAsset, nameHash, ResourceInfo, WorkspaceIndex } from './workspaceIndex';

/**
 * The GTA V sidebar: an asset browser (resources → categories → files →
 * contents) and a Resource Health view, plus "Find Usages" / "Find Asset…".
 */

const MiB = 1024 * 1024;
const mib = (n: number) => (n >= MiB ? `${(n / MiB).toFixed(1)} MiB` : `${Math.max(1, Math.round(n / 1024))} KB`);

const CATEGORIES: { key: string; label: string; kinds: AssetKind[]; icon: string }[] = [
  { key: 'models', label: 'Models', kinds: ['ydr', 'ydd', 'yft'], icon: 'symbol-structure' },
  { key: 'textures', label: 'Texture dictionaries', kinds: ['ytd'], icon: 'file-media' },
  { key: 'archetypes', label: 'Archetypes', kinds: ['ytyp'], icon: 'symbol-class' },
  { key: 'maps', label: 'Maps', kinds: ['ymap'], icon: 'globe' },
  { key: 'collision', label: 'Collision', kinds: ['ybn'], icon: 'shield' },
  { key: 'peds', label: 'Ped variations', kinds: ['ymt'], icon: 'person' },
];

export type AssetNode =
  | { type: 'resource'; resource: ResourceInfo }
  | { type: 'category'; resource: ResourceInfo; category: (typeof CATEGORIES)[number] }
  | { type: 'file'; asset: IndexedAsset }
  | { type: 'drawable'; asset: IndexedAsset; index: number }
  | { type: 'texture'; asset: IndexedAsset; texture: TextureInfo }
  | { type: 'textureRef'; asset: IndexedAsset; name: string }
  | { type: 'archetype'; asset: IndexedAsset; name: string; detail: string; count?: number };

export class AssetTreeProvider implements vscode.TreeDataProvider<AssetNode> {
  private readonly changed = new vscode.EventEmitter<AssetNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private autoScanned = false;

  constructor(private readonly index: WorkspaceIndex) {
    index.onDidChange(() => this.changed.fire(undefined));
  }

  getTreeItem(n: AssetNode): vscode.TreeItem {
    const C = vscode.TreeItemCollapsibleState;
    switch (n.type) {
      case 'resource': {
        const assets = this.index.assetsOf(n.resource);
        const physical = assets.reduce((sum, a) => sum + a.summary.graphicsSize, 0);
        const item = new vscode.TreeItem(n.resource.name, C.Collapsed);
        item.description = `${assets.length} file${assets.length === 1 ? '' : 's'} · ${mib(physical)}`;
        item.tooltip = `${n.resource.root.fsPath || n.resource.root.path}\n${assets.length} asset files, ${mib(physical)} physical memory in total`;
        item.iconPath = new vscode.ThemeIcon('package');
        item.contextValue = 'resource';
        return item;
      }
      case 'category': {
        const count = this.filesIn(n.resource, n.category.kinds).length;
        const item = new vscode.TreeItem(n.category.label, C.Collapsed);
        item.description = String(count);
        item.iconPath = new vscode.ThemeIcon(n.category.icon);
        return item;
      }
      case 'file': {
        const s = n.asset.summary;
        const hasChildren = !s.encrypted && !s.error && ((s.textures?.length ?? 0) + (s.drawables?.length ?? 0) + (s.archetypes?.length ?? 0) + (s.entities?.length ?? 0) > 0);
        const item = new vscode.TreeItem(n.asset.file, hasChildren ? C.Collapsed : C.None);
        item.resourceUri = n.asset.uri;
        item.description = s.encrypted ? 'encrypted' : s.error ? 'unreadable' : s.graphicsSize || s.systemSize ? mib(s.graphicsSize + s.systemSize) : '';
        item.tooltip = `${n.asset.resource.name}/${n.asset.rel}${s.encrypted ? '\nEncrypted (FiveM escrow)' : ''}${s.error ? `\n${s.error}` : ''}\nPhysical ${mib(s.graphicsSize)} · virtual ${mib(s.systemSize)}`;
        if (s.encrypted) item.iconPath = new vscode.ThemeIcon('lock');
        item.command = { command: 'vscode.open', title: 'Open', arguments: [n.asset.uri] };
        item.contextValue = `file-${n.asset.kind}`;
        return item;
      }
      case 'drawable': {
        const d = n.asset.summary.drawables![n.index];
        const item = new vscode.TreeItem(d.name || `drawable ${n.index}`, d.refs.length ? C.Collapsed : C.None);
        item.description = `${d.refs.length} texture${d.refs.length === 1 ? '' : 's'}`;
        item.iconPath = new vscode.ThemeIcon('symbol-structure');
        item.contextValue = 'model';
        return item;
      }
      case 'texture': {
        const t = n.texture;
        const item = new vscode.TreeItem(t.name, C.None);
        item.description = `${t.width}×${t.height} ${t.format} · ${t.levels} mip${t.levels === 1 ? '' : 's'} · ${mib(t.size)}`;
        item.iconPath = new vscode.ThemeIcon('file-media');
        item.contextValue = 'texture';
        item.command = { command: 'vscode.open', title: 'Open', arguments: [n.asset.uri] };
        return item;
      }
      case 'textureRef': {
        const where = this.textureSource(n.asset, n.name);
        const item = new vscode.TreeItem(n.name, C.None);
        item.description = where.label;
        item.iconPath = new vscode.ThemeIcon(where.found ? 'file-media' : 'warning');
        item.tooltip = where.found ? `${n.name} — ${where.label}` : `${n.name} isn't in this model or any .ytd in the workspace (fine if it's a base-game texture).`;
        item.contextValue = 'texture';
        if (where.asset) item.command = { command: 'vscode.open', title: 'Open', arguments: [where.asset.uri] };
        return item;
      }
      case 'archetype': {
        const item = new vscode.TreeItem(n.name, C.None);
        item.description = n.count !== undefined ? `×${n.count}${n.detail ? ` · ${n.detail}` : ''}` : n.detail;
        item.iconPath = new vscode.ThemeIcon(n.detail === 'interior' ? 'home' : 'symbol-class');
        item.contextValue = 'archetype';
        const model = this.index.byName(n.name, ['ydr', 'yft', 'ydd'])[0];
        item.command = { command: 'vscode.open', title: 'Open', arguments: [(model ?? n.asset).uri] };
        return item;
      }
    }
  }

  getChildren(n?: AssetNode): AssetNode[] {
    if (!n) {
      if (!this.index.scanned) {
        // Opening the view is enough to start a scan.
        if (!this.autoScanned) {
          this.autoScanned = true;
          void this.index.refresh();
        }
        return [];
      }
      return [...this.index.resourceList]
        .filter((r) => this.index.assetsOf(r).length)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((resource) => ({ type: 'resource', resource }));
    }
    switch (n.type) {
      case 'resource':
        return CATEGORIES.filter((c) => this.filesIn(n.resource, c.kinds).length).map((category) => ({ type: 'category', resource: n.resource, category }));
      case 'category':
        return this.filesIn(n.resource, n.category.kinds).map((asset) => ({ type: 'file', asset }));
      case 'file': {
        const s = n.asset.summary;
        if (s.textures) return s.textures.map((texture) => ({ type: 'texture', asset: n.asset, texture }));
        if (s.drawables) {
          if (s.drawables.length === 1) return this.getChildren({ type: 'drawable', asset: n.asset, index: 0 });
          return s.drawables.map((_, index) => ({ type: 'drawable', asset: n.asset, index }));
        }
        if (s.archetypes) return s.archetypes.map((a) => ({ type: 'archetype', asset: n.asset, name: a.name, detail: a.type === 'CMloArchetypeDef' ? 'interior' : a.assetType.replace(/^ASSET_TYPE_/, '').toLowerCase() }));
        if (s.entities) return [...s.entities].sort((a, b) => b.count - a.count).map((e) => ({ type: 'archetype', asset: n.asset, name: e.archetype, detail: e.mloInstance ? 'interior' : '', count: e.count }));
        return [];
      }
      case 'drawable': {
        const d = n.asset.summary.drawables![n.index];
        return [
          ...d.textures.map((texture): AssetNode => ({ type: 'texture', asset: n.asset, texture })),
          ...d.refs.filter((r) => !d.textures.some((t) => t.name.toLowerCase() === r)).map((name): AssetNode => ({ type: 'textureRef', asset: n.asset, name })),
        ];
      }
      default:
        return [];
    }
  }

  private filesIn(resource: ResourceInfo, kinds: AssetKind[]): IndexedAsset[] {
    return this.index
      .assetsOf(resource)
      .filter((a) => kinds.includes(a.kind))
      .sort((a, b) => a.file.localeCompare(b.file));
  }

  /** Where a model's texture comes from: embedded, a .ytd (nearest first), or nowhere. */
  private textureSource(asset: IndexedAsset, name: string): { found: boolean; label: string; asset?: IndexedAsset } {
    const key = name.toLowerCase();
    const ytds = this.index.all.filter((a) => a.kind === 'ytd' && a.summary.textures?.some((t) => t.name.toLowerCase() === key));
    if (!ytds.length) return { found: false, label: 'not found' };
    const same = ytds.find((y) => y.resource === asset.resource) ?? ytds[0];
    return { found: true, label: `from ${same.file}${ytds.length > 1 ? ` (+${ytds.length - 1} more)` : ''}`, asset: same };
  }
}

// ---------------------------------------------------------------------------
// Resource Health view
// ---------------------------------------------------------------------------

type HealthNode = { type: 'resource'; resource: ResourceInfo; issues: Issue[] } | { type: 'issue'; issue: Issue };

const SEVERITY_ICON: Record<number, [string, string]> = {
  [vscode.DiagnosticSeverity.Error]: ['error', 'errorForeground'],
  [vscode.DiagnosticSeverity.Warning]: ['warning', 'editorWarning.foreground'],
  [vscode.DiagnosticSeverity.Information]: ['info', 'editorInfo.foreground'],
  [vscode.DiagnosticSeverity.Hint]: ['lightbulb', 'editorLightBulb.foreground'],
};

export class HealthTreeProvider implements vscode.TreeDataProvider<HealthNode> {
  private readonly changed = new vscode.EventEmitter<HealthNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly health: HealthDiagnostics) {
    health.onDidChange(() => this.changed.fire(undefined));
  }

  getTreeItem(n: HealthNode): vscode.TreeItem {
    if (n.type === 'resource') {
      const item = new vscode.TreeItem(n.resource.name, vscode.TreeItemCollapsibleState.Expanded);
      const counts = [vscode.DiagnosticSeverity.Error, vscode.DiagnosticSeverity.Warning, vscode.DiagnosticSeverity.Information]
        .map((sev) => [sev, n.issues.filter((i) => i.severity === sev).length] as const)
        .filter(([, c]) => c)
        .map(([sev, c]) => `${c} ${['error', 'warning', 'info'][sev]}${c === 1 || sev === 2 ? '' : 's'}`);
      item.description = counts.join(' · ') || `${n.issues.length} hint${n.issues.length === 1 ? '' : 's'}`;
      item.iconPath = new vscode.ThemeIcon('package');
      return item;
    }
    const i = n.issue;
    const file = i.uri.path.slice(i.uri.path.lastIndexOf('/') + 1);
    const item = new vscode.TreeItem(file, vscode.TreeItemCollapsibleState.None);
    item.description = i.message;
    item.tooltip = new vscode.MarkdownString(`**${file}** — ${i.code}\n\n${i.message}`);
    const [icon, color] = SEVERITY_ICON[i.severity];
    item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
    item.command =
      i.line !== undefined
        ? { command: 'vscode.open', title: 'Open', arguments: [i.uri, { selection: new vscode.Range(i.line, 0, i.line, 0) }] }
        : { command: 'vscode.open', title: 'Open', arguments: [i.uri] };
    return item;
  }

  getChildren(n?: HealthNode): HealthNode[] {
    if (!this.health.ran) return [];
    if (!n) {
      const byResource = new Map<ResourceInfo, Issue[]>();
      for (const i of this.health.issues) byResource.set(i.resource, [...(byResource.get(i.resource) ?? []), i]);
      const worst = (issues: Issue[]) => Math.min(...issues.map((i) => i.severity));
      return [...byResource]
        .sort((a, b) => worst(a[1]) - worst(b[1]) || a[0].name.localeCompare(b[0].name))
        .map(([resource, issues]) => ({ type: 'resource', resource, issues }));
    }
    if (n.type === 'resource') return [...n.issues].sort((a, b) => a.severity - b.severity).map((issue) => ({ type: 'issue', issue }));
    return [];
  }
}

// ---------------------------------------------------------------------------
// Find Usages / Find Asset
// ---------------------------------------------------------------------------

interface UsageItem extends vscode.QuickPickItem {
  uri?: vscode.Uri;
  next?: () => Promise<void>;
}

const section = (label: string): UsageItem => ({ label, kind: vscode.QuickPickItemKind.Separator });
const where = (a: IndexedAsset) => `${a.resource.name}/${a.rel}`;

function textureUsages(index: WorkspaceIndex, name: string): UsageItem[] {
  const key = name.toLowerCase();
  const defined: UsageItem[] = [];
  const used: UsageItem[] = [];
  for (const a of index.all) {
    const t = a.summary.textures?.find((x) => x.name.toLowerCase() === key);
    if (t) defined.push({ label: `$(file-media) ${a.file}`, description: `${t.width}×${t.height} ${t.format}`, detail: where(a), uri: a.uri });
    for (const d of a.summary.drawables ?? []) {
      const embedded = d.textures.find((x) => x.name.toLowerCase() === key);
      if (embedded) defined.push({ label: `$(symbol-structure) ${a.file}`, description: `embedded · ${embedded.width}×${embedded.height} ${embedded.format}`, detail: where(a), uri: a.uri });
      if (d.refs.includes(key)) used.push({ label: `$(symbol-structure) ${a.file}`, description: d.name && d.name !== a.base ? d.name : '', detail: where(a), uri: a.uri });
    }
  }
  return [section(`Defined in (${defined.length})`), ...defined, section(`Used by (${used.length})`), ...used];
}

function archetypeUsages(index: WorkspaceIndex, name: string): UsageItem[] {
  const hash = nameHash(name);
  const defined: UsageItem[] = [];
  const models: UsageItem[] = [];
  const placed: UsageItem[] = [];
  for (const a of index.all) {
    const def = a.summary.archetypes?.find((x) => nameHash(x.name) === hash);
    if (def) defined.push({ label: `$(symbol-class) ${a.file}`, description: `${def.type.replace(/^C|Def$/g, '')}${def.textureDictionary ? ` · textures ${def.textureDictionary}` : ''}`, detail: where(a), uri: a.uri });
    if ((a.kind === 'ydr' || a.kind === 'yft') && a.hash === hash) models.push({ label: `$(symbol-structure) ${a.file}`, detail: where(a), uri: a.uri });
    if (a.kind === 'ydd' && a.summary.drawables?.some((d) => nameHash(d.name) === hash)) models.push({ label: `$(symbol-structure) ${a.file}`, description: 'in dictionary', detail: where(a), uri: a.uri });
    const e = a.summary.entities?.find((x) => nameHash(x.archetype) === hash);
    if (e) placed.push({ label: `$(globe) ${a.file}`, description: `×${e.count}`, detail: where(a), uri: a.uri });
    const inInterior = a.summary.archetypes?.filter((x) => x.mloEntities?.some((m) => nameHash(m) === hash)) ?? [];
    for (const mlo of inInterior) placed.push({ label: `$(home) ${a.file}`, description: `inside interior ${mlo.name}`, detail: where(a), uri: a.uri });
  }
  return [
    section(`Defined in (${defined.length})`),
    ...defined,
    section(`Model (${models.length})`),
    ...models,
    section(`Placed by (${placed.length})`),
    ...placed,
  ];
}

function fileUsages(index: WorkspaceIndex, asset: IndexedAsset): UsageItem[] {
  if (['ydr', 'yft', 'ydd'].includes(asset.kind)) {
    const names = asset.kind === 'ydd' ? (asset.summary.drawables ?? []).map((d) => d.name) : [asset.base];
    return names.flatMap((n) => archetypeUsages(index, n));
  }
  if (asset.kind === 'ytd') {
    const names = new Set((asset.summary.textures ?? []).map((t) => t.name.toLowerCase()));
    const models = index.all.filter((a) => a.summary.drawables?.some((d) => d.refs.some((r) => names.has(r))));
    const archetypes = index.all.filter((a) => a.summary.archetypes?.some((x) => nameHash(x.textureDictionary) === asset.hash));
    return [
      section(`Models using its textures (${models.length})`),
      ...models.map((a): UsageItem => ({ label: `$(symbol-structure) ${a.file}`, detail: where(a), uri: a.uri })),
      section(`Archetypes naming it as texture dictionary (${archetypes.length})`),
      ...archetypes.map((a): UsageItem => ({ label: `$(symbol-class) ${a.file}`, detail: where(a), uri: a.uri })),
    ];
  }
  return [];
}

async function showUsages(title: string, items: UsageItem[]): Promise<void> {
  const hasResults = items.some((i) => i.kind !== vscode.QuickPickItemKind.Separator);
  if (!hasResults) {
    void vscode.window.showInformationMessage(`No usages of ${title} found in the workspace.`);
    return;
  }
  const picked = await vscode.window.showQuickPick(items, { title: `Usages of ${title}`, matchOnDescription: true, matchOnDetail: true });
  if (picked?.next) await picked.next();
  else if (picked?.uri) await vscode.commands.executeCommand('vscode.open', picked.uri);
}

export function registerAssetViews(context: vscode.ExtensionContext, index: WorkspaceIndex, health: HealthDiagnostics): vscode.Disposable[] {
  const assets = new AssetTreeProvider(index);
  const healthTree = new HealthTreeProvider(health);
  return [
    vscode.window.createTreeView('gtaPreview.assets', { treeDataProvider: assets, showCollapseAll: true }),
    vscode.window.createTreeView('gtaPreview.health', { treeDataProvider: healthTree, showCollapseAll: true }),
    vscode.commands.registerCommand('gtaPreview.refreshAssets', () => index.refresh(true)),
    vscode.commands.registerCommand('gtaPreview.checkResources', async () => {
      await health.run();
      const counts = [vscode.DiagnosticSeverity.Error, vscode.DiagnosticSeverity.Warning].map((s) => health.issues.filter((i) => i.severity === s).length);
      void vscode.window.showInformationMessage(
        `Resource check: ${counts[0]} error${counts[0] === 1 ? '' : 's'}, ${counts[1]} warning${counts[1] === 1 ? '' : 's'}, ${health.issues.length - counts[0] - counts[1]} info/hints across ${index.all.length} files.`
      );
      await vscode.commands.executeCommand('gtaPreview.health.focus');
    }),
    vscode.commands.registerCommand('gtaPreview.findUsages', async (node?: AssetNode | vscode.Uri) => {
      await index.ensure();
      if (node instanceof vscode.Uri) {
        const asset = index.all.find((a) => a.uri.toString() === node.toString());
        if (asset) await showUsages(asset.file, fileUsages(index, asset));
        return;
      }
      if (!node) return vscode.commands.executeCommand('gtaPreview.findAsset');
      if (node.type === 'texture') await showUsages(node.texture.name, textureUsages(index, node.texture.name));
      else if (node.type === 'textureRef') await showUsages(node.name, textureUsages(index, node.name));
      else if (node.type === 'archetype') await showUsages(node.name, archetypeUsages(index, node.name));
      else if (node.type === 'file') await showUsages(node.asset.file, fileUsages(index, node.asset));
      else if (node.type === 'drawable') {
        const d = node.asset.summary.drawables![node.index];
        await showUsages(d.name, archetypeUsages(index, d.name));
      }
    }),
    vscode.commands.registerCommand('gtaPreview.findAsset', async () => {
      await index.ensure();
      const items: UsageItem[] = [];
      for (const a of index.all) {
        items.push({ label: `$(file) ${a.file}`, description: a.resource.name, detail: a.rel, next: () => showUsagesOrOpen(a) });
        for (const t of a.summary.textures ?? []) items.push({ label: `$(file-media) ${t.name}`, description: `texture · ${a.file}`, next: () => showUsages(t.name, textureUsages(index, t.name)) });
        for (const x of a.summary.archetypes ?? []) items.push({ label: `$(symbol-class) ${x.name}`, description: `archetype · ${a.file}`, next: () => showUsages(x.name, archetypeUsages(index, x.name)) });
      }
      const picked = await vscode.window.showQuickPick(items, { title: 'Find GTA V asset (files, textures, archetypes)', matchOnDescription: true, placeHolder: 'Type a model, texture or archetype name' });
      await picked?.next?.();
    }),
  ];

  async function showUsagesOrOpen(a: IndexedAsset): Promise<void> {
    await vscode.commands.executeCommand('vscode.open', a.uri);
  }
}
