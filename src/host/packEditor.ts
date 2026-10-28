import * as vscode from 'vscode';
import { parseYdd, parseYdr } from '../formats/drawable';
import { parseYft } from '../formats/yft';
import { parseYtd } from '../formats/ytd';
import { parseYmt } from '../formats/ymt';
import { optimizeEmbedded, optimizeYtdWith } from '../formats/optimize';
import { replaceEmbeddedFromDds } from '../formats/textureEdit';
import { readHeader } from '../formats/rsc7';
import { isEncrypted } from '../formats/scan';
import {
  ClothPack,
  drawablesFromYmt,
  Gender,
  guessFromPath,
  MAX_TEXTURES,
  newPack,
  PackDrawable,
  PED_NAMES,
  packNameProblem,
  planBuild,
  readPack,
  slotLabel,
  BuildFile,
  texturesForModel,
  writePack,
} from '../formats/clothPack';
import type { HostToWebview, PackCandidate, PackIssue, WebviewToHost } from '../shared/model';
import { basename, dirname } from './assetIndex';
import { webviewHtml } from './previewProvider';

export const PACK_VIEW_TYPE = 'gtaPreview.clothPack';
const PACK_SUFFIX = '.clothpack.json';

/** Thresholds for pack checks. */
const MAX_TRIANGLES = 20000;
const MAX_TEXTURE_SIZE = 2048;

/** Clothing pack projects (`*.clothpack.json`): the editor and the New/Import commands. */
export function registerPackEditor(context: vscode.ExtensionContext): vscode.Disposable[] {
  return [
    vscode.window.registerCustomEditorProvider(PACK_VIEW_TYPE, new PackEditorProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('gtaPreview.newClothPack', async (folder?: vscode.Uri) => {
      const dir = await targetFolder(folder);
      if (!dir) return;
      const name = await vscode.window.showInputBox({
        title: 'New clothing pack',
        prompt: 'Collection name (used in file names, e.g. "my_clothes" → mp_m_freemode_01_my_clothes)',
        value: 'my_clothes',
        validateInput: (v) => packNameProblem(v.trim()),
      });
      if (!name) return;
      await createPackFile(dir, newPack(name.trim()));
    }),
    vscode.commands.registerCommand('gtaPreview.importClothPack', async (folder?: vscode.Uri) => {
      const picked =
        folder ??
        (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Import resource', title: 'Addon clothing resource folder' }))?.[0];
      if (!picked) return;
      await importResource(picked);
    }),
  ];
}

async function targetFolder(folder?: vscode.Uri): Promise<vscode.Uri | undefined> {
  if (folder) return folder;
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (ws) return ws;
  return (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Create pack here' }))?.[0];
}

async function createPackFile(dir: vscode.Uri, pack: ClothPack): Promise<void> {
  let uri = vscode.Uri.joinPath(dir, `${pack.name}${PACK_SUFFIX}`);
  for (let i = 2; await exists(uri); i++) uri = vscode.Uri.joinPath(dir, `${pack.name}_${i}${PACK_SUFFIX}`);
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(writePack(pack)));
  await vscode.commands.executeCommand('vscode.openWith', uri, PACK_VIEW_TYPE);
}

/** Turns an addon clothing resource (its .ymt files and stream files) into a pack project next to it. */
async function importResource(root: vscode.Uri): Promise<void> {
  const files = await listFiles(root);
  const ymts = files.filter((f) => /mp_[mf]_freemode_01_(?!p_)(.+)\.ymt$/i.test(basename(f)));
  if (!ymts.length) {
    void vscode.window.showWarningMessage(`No mp_m_freemode_01_*.ymt / mp_f_freemode_01_*.ymt files found in ${basename(root)}.`);
    return;
  }
  const name = /mp_[mf]_freemode_01_(.+)\.ymt$/i.exec(basename(ymts[0]))![1].toLowerCase();
  const pack = newPack(name);
  const dir = dirname(root);
  const missing: string[] = [];
  for (const ymt of ymts) {
    const file = basename(ymt);
    const gender: Gender = /^mp_f_/i.test(file) ? 'female' : 'male';
    const ped = PED_NAMES[gender];
    const collection = /mp_[mf]_freemode_01_(.+)\.ymt$/i.exec(file)![1];
    try {
      const parsed = parseYmt(await vscode.workspace.fs.readFile(ymt));
      if (!parsed.pedVariation) continue;
      const byName = new Map(files.map((f) => [basename(f).toLowerCase(), f]));
      const result = drawablesFromYmt(
        parsed.pedVariation,
        gender,
        (n, kind) => {
          const f = byName.get(`${kind === 'prop' ? `${ped}_p_${collection}` : `${ped}_${collection}`}^${n}`.toLowerCase());
          return f ? relativePath(dir, f) : undefined;
        },
        parsed.raw
      );
      pack.drawables.push(...result.drawables);
      missing.push(...result.missing);
    } catch (err) {
      missing.push(`${file}: ${(err as Error).message}`);
    }
  }
  // Masks that hide hair are only recorded in pedalternativevariations: they are the addon masks used as switch sources.
  for (const meta of files.filter((f) => /^pedalternativevariations.*\.meta$/i.test(basename(f)))) {
    try {
      const xml = new TextDecoder().decode(await vscode.workspace.fs.readFile(meta));
      for (const ped of xml.split(/<Item>\s*<name>/).slice(1)) {
        const gender: Gender = /^mp_f_/.test(ped) ? 'female' : 'male';
        const hiding = new Set<number>();
        for (const m of ped.matchAll(/<dlcNameHash>([^<]*)<\/dlcNameHash>\s*<component value="1"\s*\/>\s*<index value="(\d+)"/g)) {
          if (m[1].toLowerCase() === name) hiding.add(Number(m[2]));
        }
        const masks = pack.drawables.filter((d) => d.gender === gender && d.kind === 'component' && d.slot === 'berd');
        hiding.forEach((i) => masks[i] && (masks[i].hidesHair = true));
      }
    } catch {
      // Without it, masks simply don't hide hair.
    }
  }
  pack.output = `build/${name}`;
  await createPackFile(dir, pack);
  void vscode.window.showInformationMessage(
    `Imported ${pack.drawables.length} drawables from ${basename(root)}.${missing.length ? ` ${missing.length} referenced file(s) were missing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}` : ''}`
  );
}

async function listFiles(root: vscode.Uri, depth = 6): Promise<vscode.Uri[]> {
  const out: vscode.Uri[] = [];
  const walk = async (dir: vscode.Uri, d: number) => {
    for (const [name, type] of await vscode.workspace.fs.readDirectory(dir)) {
      const child = vscode.Uri.joinPath(dir, name);
      if (type & vscode.FileType.Directory) {
        if (d < depth && name !== 'node_modules' && !name.startsWith('.')) await walk(child, d + 1);
      } else out.push(child);
    }
  };
  await walk(root, 0);
  return out;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** `to` relative to the folder `from` ('/'-separated, may start with ../). */
export function relativePath(from: vscode.Uri, to: vscode.Uri): string {
  const a = from.path.split('/').filter(Boolean);
  const b = to.path.split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/') || '.';
}

export class PackEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    panel.webview.html = webviewHtml(panel.webview, dist, 'pack');
    const session = new PackSession(document, panel, vscode.Uri.joinPath(this.context.extensionUri, 'media', 'reserved'));
    panel.onDidDispose(() => session.dispose());
  }
}

class PackSession {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly dir: vscode.Uri;
  private pack?: ClothPack;

  constructor(private readonly document: vscode.TextDocument, private readonly panel: vscode.WebviewPanel, private readonly reservedDir: vscode.Uri) {
    this.dir = dirname(document.uri);
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: WebviewToHost) => void this.onMessage(m)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === document.uri.toString() && e.contentChanges.length) void this.sendPack();
      })
    );
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  private post(m: HostToWebview): void {
    void this.panel.webview.postMessage(m);
  }

  /** A project-relative path (or a bundled `@reserved/…` placeholder) as a URI. */
  private uri(rel: string): vscode.Uri {
    if (rel.startsWith('@reserved/')) return vscode.Uri.joinPath(this.reservedDir, rel.slice('@reserved/'.length));
    return vscode.Uri.joinPath(this.dir, rel);
  }

  private async sendPack(): Promise<void> {
    try {
      this.pack = readPack(this.document.getText() || '{}');
    } catch (err) {
      this.post({ type: 'error', message: `This clothing pack file isn't valid JSON: ${(err as Error).message}` });
      return;
    }
    const paths = new Set(
      this.pack.drawables.flatMap((d) => (d.reserved ? [] : [d.model, ...d.textures, ...(d.cloth ? [d.cloth] : []), ...(d.firstPerson ? [d.firstPerson] : [])])).filter(Boolean)
    );
    const found: Record<string, boolean> = {};
    await Promise.all([...paths].map(async (p) => (found[p] = await exists(this.uri(p)))));
    this.post({ type: 'pack', file: basename(this.document.uri), pack: this.pack, exists: found });
  }

  /** Replaces the document with `pack` (one undoable edit). */
  private async save(pack: ClothPack): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    const all = new vscode.Range(0, 0, this.document.lineCount, 0);
    edit.replace(this.document.uri, all, writePack(pack));
    await vscode.workspace.applyEdit(edit);
  }

  private async onMessage(m: WebviewToHost): Promise<void> {
    try {
      switch (m.type) {
        case 'ready':
          await this.sendPack();
          break;
        case 'packEdit':
          await this.save(m.pack);
          break;
        case 'packAddDrawables':
          await this.addDrawables(m.requestId, m.gender);
          break;
        case 'packPickFiles':
          await this.pickFiles(m.requestId, m.purpose);
          break;
        case 'packLoadModel':
          await this.loadModel(m.requestId, m.path, m.maxTextureSize);
          break;
        case 'packLoadTexture':
          await this.loadTexture(m.requestId, m.path, m.maxSize);
          break;
        case 'packCheck':
          this.post({ type: 'packChecks', requestId: m.requestId, issues: await this.check() });
          break;
        case 'packBuild':
          await this.build(m.requestId);
          break;
        case 'packFindDuplicates':
          this.post({ type: 'packDuplicates', requestId: m.requestId, groups: await this.duplicates() });
          break;
        case 'packSaveAsset': {
          const pack = this.pack;
          const dir = `${pack?.name ?? 'pack'}_assets`;
          const rel = `${dir}/${m.name.replace(/[\\/:*?"<>|]/g, '_')}`;
          await vscode.workspace.fs.writeFile(this.uri(rel), m.data);
          this.post({ type: 'packPicked', requestId: m.requestId, paths: [rel] });
          break;
        }
        case 'packOptimize': {
          const ytds = [...new Set((this.pack?.drawables ?? []).filter((d) => !d.reserved).flatMap((d) => d.textures))].map((t) => this.uri(t));
          await vscode.commands.executeCommand('gtaPreview.optimizeTextures', ytds[0], ytds);
          break;
        }
        case 'packReveal':
          if (this.pack?.output) await vscode.commands.executeCommand('revealInExplorer', this.uri(this.pack.output));
          break;
      }
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  private async pickFiles(requestId: number, purpose: 'textures' | 'cloth' | 'model'): Promise<void> {
    const filters: Record<string, Record<string, string[]>> = { textures: { 'Texture dictionaries': ['ytd'] }, cloth: { 'Cloth physics': ['yld'] }, model: { 'Drawable dictionaries': ['ydd'] } };
    const picked = await vscode.window.showOpenDialog({ canSelectMany: purpose === 'textures', defaultUri: this.dir, filters: filters[purpose] });
    this.post({ type: 'packPicked', requestId, paths: (picked ?? []).map((u) => relativePath(this.dir, u)) });
  }

  /**
   * Picks models and describes them for adding: slot, gender, skin, textures and
   * cloth found from names, and whether the pack already has the same model.
   */
  private async addDrawables(requestId: number, gender: Gender): Promise<void> {
    const pack = this.pack;
    const picked = pack && (await vscode.window.showOpenDialog({ canSelectMany: true, defaultUri: this.dir, openLabel: 'Add to pack', filters: { 'Drawable dictionaries': ['ydd'] } }));
    if (!pack || !picked?.length) return this.post({ type: 'packCandidates', requestId, candidates: [] });
    const folders = new Map<string, vscode.Uri[]>();
    const siblings = async (dir: vscode.Uri) => {
      const key = dir.toString();
      if (!folders.has(key)) folders.set(key, (await vscode.workspace.fs.readDirectory(dir)).map(([n]) => vscode.Uri.joinPath(dir, n)));
      return folders.get(key)!;
    };
    // Existing models by path and by content, to flag duplicates.
    const byPath = new Map(pack.drawables.filter((d) => !d.reserved).map((d) => [d.model.toLowerCase(), d.id]));
    const byHash = new Map<string, string>();
    for (const d of pack.drawables) {
      if (d.reserved) continue;
      const h = await this.hash(d.model);
      if (h) byHash.set(h, d.id);
    }
    const candidates: PackCandidate[] = [];
    for (const model of picked) {
      const guess = guessFromPath(model.path);
      const near = await siblings(dirname(model));
      const textures = texturesForModel(model.path, near.filter((u) => /\.ytd$/i.test(u.path)).map((u) => u.path));
      const cloth = near.find((u) => u.path.toLowerCase() === model.path.toLowerCase().replace(/\.ydd$/, '.yld'));
      const rel = relativePath(this.dir, model);
      const hash = await this.hash(rel);
      candidates.push({
        model: rel,
        gender: guess.gender ?? (guess.slot ? gender : undefined),
        kind: guess.kind,
        slot: guess.slot,
        hasSkin: guess.hasSkin && guess.kind === 'component' ? true : undefined,
        textures: textures.map((t) => relativePath(this.dir, model.with({ path: t }))),
        cloth: cloth ? relativePath(this.dir, cloth) : undefined,
        duplicateOf: byPath.get(rel.toLowerCase()) ?? (hash ? byHash.get(hash) : undefined),
      });
    }
    this.post({ type: 'packCandidates', requestId, candidates });
  }

  private readonly hashes = new Map<string, Promise<string | undefined>>();

  /** SHA-1 of a project file's contents (cached), or undefined if it can't be read. */
  private hash(rel: string): Promise<string | undefined> {
    let p = this.hashes.get(rel);
    if (!p) {
      p = (async () => {
        try {
          const data = await vscode.workspace.fs.readFile(this.uri(rel));
          const digest = await globalThis.crypto.subtle.digest('SHA-1', data.slice());
          return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
        } catch {
          return undefined;
        }
      })();
      this.hashes.set(rel, p);
    }
    return p;
  }

  /** Drawables sharing identical model files (same gender and slot) or identical texture files. */
  private async duplicates(): Promise<{ kind: 'model' | 'texture'; ids: string[]; file: string }[]> {
    const pack = this.pack;
    if (!pack) return [];
    this.hashes.clear();
    const models = new Map<string, { ids: string[]; file: string }>();
    const textures = new Map<string, { ids: Set<string>; file: string }>();
    for (const d of pack.drawables) {
      if (d.reserved) continue;
      const h = await this.hash(d.model);
      if (h) {
        const key = `${d.gender}/${d.kind}/${d.slot}/${h}`;
        const g = models.get(key) ?? { ids: [], file: d.model };
        g.ids.push(d.id);
        models.set(key, g);
      }
      for (const t of d.textures) {
        const th = await this.hash(t);
        if (!th) continue;
        const g = textures.get(th) ?? { ids: new Set<string>(), file: t };
        g.ids.add(d.id);
        textures.set(th, g);
      }
    }
    return [
      ...[...models.values()].filter((g) => g.ids.length > 1).map((g) => ({ kind: 'model' as const, ids: g.ids, file: g.file })),
      ...[...textures.values()].filter((g) => g.ids.size > 1).map((g) => ({ kind: 'texture' as const, ids: [...g.ids], file: g.file })),
    ];
  }

  private async loadModel(requestId: number, path: string, maxTextureSize = 1024): Promise<void> {
    try {
      const data = await vscode.workspace.fs.readFile(this.uri(path));
      const opts = { maxSize: maxTextureSize };
      const drawables = /\.yft$/i.test(path) ? parseYft(data, opts) : /\.ydr$/i.test(path) ? [parseYdr(data, opts)] : parseYdd(data, opts);
      this.post({ type: 'drawableFile', requestId, drawables: drawables.map((d) => ({ ...d, textures: d.textures.map((t) => ({ ...t, origin: this.uri(path).toString() })) })) });
    } catch (err) {
      this.post({ type: 'drawableFile', requestId, drawables: [], error: (err as Error).message });
    }
  }

  private async loadTexture(requestId: number, path: string, maxSize = 512): Promise<void> {
    try {
      const uri = this.uri(path);
      const textures = parseYtd(await vscode.workspace.fs.readFile(uri), { maxSize }).map((t) => ({ ...t, origin: uri.toString() }));
      this.post({ type: 'textureFile', requestId, textures });
    } catch (err) {
      this.post({ type: 'textureFile', requestId, textures: [], error: (err as Error).message });
    }
  }

  // -- checks --------------------------------------------------------------------

  private async check(): Promise<PackIssue[]> {
    const pack = this.pack;
    if (!pack) return [];
    const issues: PackIssue[] = [];
    const add = (d: PackDrawable | undefined, severity: PackIssue['severity'], message: string) => issues.push({ id: d?.id, severity, message });
    const fingerprints = new Map<string, PackDrawable>();
    const nameProblem = packNameProblem(pack.name);
    if (nameProblem) add(undefined, 'error', `Pack name: ${nameProblem}`);

    for (const d of pack.drawables) {
      if (d.reserved) continue;
      if (d.highHeels && !(d.kind === 'component' && d.slot === 'feet')) add(d, 'warning', 'High heels only work on shoes (feet).');
      if (d.hairScale && !(d.kind === 'prop' && d.slot === 'p_head')) add(d, 'warning', 'Hair scale only works on hats (p_head).');
      if (d.firstPerson && !(await exists(this.uri(d.firstPerson)))) add(d, 'error', `First-person model not found: ${d.firstPerson}`);
      if (d.textures.length === 0) add(d, 'warning', 'No texture variations.');
      if (d.textures.length > MAX_TEXTURES) add(d, 'error', `${d.textures.length} textures; at most ${MAX_TEXTURES} (a–z) can be used.`);
      // Model.
      try {
        const data = await vscode.workspace.fs.readFile(this.uri(d.model));
        if (isEncrypted(data)) add(d, 'error', 'The model is escrow-encrypted (FXAP) and can only be used by its owner.');
        else {
          const drawables = parseYdd(data, { maxSize: 1 });
          const tris = drawables[0]?.lods.high.reduce((n, m) => n + m.meshes.reduce((k, g) => k + g.indices.length / 3, 0), 0) ?? 0;
          if (!drawables.length) add(d, 'error', 'The model file has no drawable.');
          else if (tris > MAX_TRIANGLES) add(d, 'warning', `High poly count: ${tris.toLocaleString()} triangles (over ${MAX_TRIANGLES.toLocaleString()}).`);
          const physical = readHeader(data).graphicsSize;
          if (physical > 16 * 1024 * 1024) add(d, 'warning', `The model uses ${(physical / 1048576).toFixed(1)} MiB of graphics memory (FiveM warns over 16 MiB).`);
          const key = `${d.gender}/${d.slot}/${fingerprint(data)}`;
          const dup = fingerprints.get(key);
          if (dup) add(d, 'warning', `Same model as ${describe(pack, dup)}.`);
          else fingerprints.set(key, d);
        }
      } catch (err) {
        add(d, 'error', (await exists(this.uri(d.model))) ? `The model can't be read: ${(err as Error).message}` : `Model not found: ${d.model}`);
      }
      // Textures.
      for (const [i, t] of d.textures.entries()) {
        const letter = String.fromCharCode(97 + i);
        try {
          const data = await vscode.workspace.fs.readFile(this.uri(t));
          if (isEncrypted(data)) {
            add(d, 'error', `Texture ${letter} is escrow-encrypted.`);
            continue;
          }
          for (const tex of parseYtd(data, { maxSize: 1 })) {
            if (Math.max(tex.width, tex.height) > MAX_TEXTURE_SIZE) add(d, 'warning', `Texture ${letter}: ${tex.name} is ${tex.width}×${tex.height} (over ${MAX_TEXTURE_SIZE}).`);
            if (!/^(DXT|BC|ATI)/.test(tex.format)) add(d, 'info', `Texture ${letter}: ${tex.name} is uncompressed (${tex.format}).`);
            if (tex.levels <= 1 && Math.max(tex.width, tex.height) > 64) add(d, 'info', `Texture ${letter}: ${tex.name} has no mipmaps.`);
          }
          const physical = readHeader(data).graphicsSize;
          if (physical > 16 * 1024 * 1024) add(d, 'warning', `Texture ${letter} uses ${(physical / 1048576).toFixed(1)} MiB (FiveM warns over 16 MiB).`);
        } catch (err) {
          add(d, 'error', (await exists(this.uri(t))) ? `Texture ${letter} can't be read: ${(err as Error).message}` : `Texture ${letter} not found: ${t}`);
        }
      }
      if (d.cloth && !(await exists(this.uri(d.cloth)))) add(d, 'error', `Cloth file not found: ${d.cloth}`);
    }
    const plan = planBuild(pack);
    for (const w of plan.warnings) add(undefined, 'info', w);
    if (!pack.drawables.length) add(undefined, 'info', 'The pack is empty. Add drawables to get started.');
    return issues;
  }

  // -- build ---------------------------------------------------------------------

  /** Applies build-time changes to a copied file: embedded texture replacements, then optimisation. */
  private async process(path: string, data: Uint8Array, process: NonNullable<BuildFile['process']>, notes: string[]): Promise<Uint8Array> {
    const name = path.split('/').pop();
    try {
      if (/\.ytd$/i.test(path)) {
        if (process.optimize) data = optimizeYtdWith(data, process.optimize).file;
        return data;
      }
      for (const [texture, source] of Object.entries(process.embedded ?? {})) {
        try {
          data = replaceEmbeddedFromDds(data, 'ydd', texture, await vscode.workspace.fs.readFile(this.uri(source)));
        } catch (err) {
          notes.push(`${name}: couldn't replace ${texture}: ${(err as Error).message}`);
        }
      }
      if (process.optimize?.embedded) {
        const result = optimizeEmbedded(data, 'ydd', process.optimize);
        data = result.file;
      }
    } catch (err) {
      notes.push(`${name}: left unoptimised (${(err as Error).message})`);
    }
    return data;
  }

  private async build(requestId: number): Promise<void> {
    const pack = this.pack;
    if (!pack) return;
    const reply = (r: Omit<Extract<HostToWebview, { type: 'packBuilt' }>, 'type' | 'requestId'>) => this.post({ type: 'packBuilt', requestId, ...r });
    const problem = packNameProblem(pack.name);
    if (problem) return reply({ ok: false, error: `Pack name: ${problem}` });
    if (!pack.drawables.length) return reply({ ok: false, error: 'The pack has no drawables.' });
    const output = this.uri(pack.output || `build/${pack.name}`);
    if (await exists(output)) {
      const choice = await vscode.window.showWarningMessage(
        `Replace the contents of ${relativePath(this.dir, output)}?`,
        { modal: true, detail: 'The build output folder is deleted and written again.' },
        'Build'
      );
      if (choice !== 'Build') return reply({ ok: false, cancelled: true });
    }
    const notes: string[] = [];
    try {
      const plan = planBuild(pack);
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Building ${pack.name}`, cancellable: false }, async (progress) => {
        if (await exists(output)) await vscode.workspace.fs.delete(output, { recursive: true, useTrash: false });
        for (const [i, f] of plan.files.entries()) {
          progress.report({ message: f.path.split('/').pop(), increment: 100 / plan.files.length });
          const target = vscode.Uri.joinPath(output, f.path);
          let data = f.data ?? (await vscode.workspace.fs.readFile(this.uri(f.from!)));
          if (f.process) data = await this.process(f.path, data, f.process, notes);
          await vscode.workspace.fs.writeFile(target, data);
          if (i % 25 === 0) await new Promise((r) => setTimeout(r, 0));
        }
      });
      reply({ ok: true, output: relativePath(this.dir, output), files: plan.files.length, warnings: [...plan.warnings, ...notes] });
    } catch (err) {
      reply({ ok: false, error: (err as Error).message });
    }
  }
}



function describe(pack: ClothPack, d: PackDrawable): string {
  const n = pack.drawables.filter((x) => x.gender === d.gender && x.kind === d.kind && x.slot === d.slot).indexOf(d);
  return `${d.gender} ${slotLabel(d.kind, d.slot)} ${String(n).padStart(3, '0')}`;
}

/** A cheap content fingerprint (size + FNV-1a over sampled bytes) for duplicate detection. */
function fingerprint(data: Uint8Array): string {
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(data.length / 65536));
  for (let i = 0; i < data.length; i += step) h = Math.imul(h ^ data[i], 0x01000193) >>> 0;
  return `${data.length}:${h.toString(16)}`;
}
