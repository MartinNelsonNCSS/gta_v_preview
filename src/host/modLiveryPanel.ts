import * as vscode from 'vscode';
import { forWebview } from './webviewMessage';
import { addLiveryMod, labelScript, liveryManifest, liveryNameProblem, parseKits, suggestLiveryName, vehicleKits } from '../formats/modLivery';
import { isEncrypted } from '../formats/scan';
import { readFullTexture, replaceTexture } from '../formats/textureEdit';
import { parseYft } from '../formats/yft';
import type { HostToWebview, ModLiveryTemplate, ModLiveryVehicle, WebviewToHost } from '../shared/model';
import { basename, dirname } from './assetIndex';
import { webviewHtml } from './previewProvider';
import { WorkspaceIndex } from './workspaceIndex';
import { designFile, handleDesignerMessage, resourceDir } from './designerFiles';

/**
 * "GTA V: New Mod-Kit Livery…": makes a livery as its own model (a
 * VMT_LIVERY_MOD part), the way packs with escrow-protected vehicles expect:
 * a small template .yft from the creator with its texture replaced by your
 * artwork, an entry in the vehicle's carcols.meta kit, and a resource of its
 * own to stream the model and name it in game. Nothing protected is read.
 */
export function registerModLivery(context: vscode.ExtensionContext, index: WorkspaceIndex): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('gtaPreview.newModLivery', async (target?: vscode.Uri) => {
      await index.ensure();
      new ModLiveryPanel(context, index, target instanceof vscode.Uri ? target : undefined);
    }),
  ];
}

const EXCLUDE = '{**/node_modules/**,**/.git/**}';
const rel = (u: vscode.Uri) => vscode.workspace.asRelativePath(u);
const fileBase = (u: vscode.Uri) => basename(u).replace(/\.[^.]+$/, '').toLowerCase();

/** Which texture of a livery model holds the livery: an embedded one on a vehicle_paint shader's DiffuseSampler2. */
export function inspectLiveryModel(data: Uint8Array): { texture?: string; size?: string; error?: string } {
  if (isEncrypted(data)) return { error: 'escrow-protected' };
  try {
    const drawables = parseYft(data, { maxSize: 16 });
    for (const d of drawables) {
      const embedded = new Map(d.textures.map((t) => [t.name.toLowerCase(), t]));
      for (const s of d.shaders) {
        if (!/^vehicle_paint/i.test(s.name)) continue;
        const ref = s.textures.find((t) => t.param.toLowerCase() === 'diffusesampler2' && embedded.has(t.texture.toLowerCase()));
        if (ref) {
          const t = embedded.get(ref.texture.toLowerCase())!;
          return { texture: t.name, size: `${t.width}×${t.height} ${t.format}` };
        }
      }
    }
    return { error: 'no embedded livery texture (a vehicle_paint shader whose DiffuseSampler2 is inside the model)' };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

class ModLiveryPanel {
  private readonly panel: vscode.WebviewPanel;
  private readonly links = new Map<number, vscode.Disposable>();
  private nextLinkId = 1;

  private readonly draftUri: vscode.Uri;
  private draftSent = false;

  constructor(private readonly context: vscode.ExtensionContext, private readonly index: WorkspaceIndex, private readonly target?: vscode.Uri) {
    this.draftUri = vscode.Uri.joinPath(context.globalStorageUri, 'modlivery-draft.json');
    const dist = vscode.Uri.joinPath(context.extensionUri, 'dist');
    this.panel = vscode.window.createWebviewPanel('gtaPreview.modLivery', 'New mod-kit livery', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [dist],
    });
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
    this.panel.webview.html = webviewHtml(this.panel.webview, dist, 'modLivery');
    this.panel.webview.onDidReceiveMessage((m: WebviewToHost) => void this.onMessage(m).catch((err) => this.post({ type: 'error', message: (err as Error).message })));
    this.panel.onDidDispose(() => this.links.forEach((l) => l.dispose()));
  }

  private post(m: HostToWebview): void {
    void this.panel.webview.postMessage(forWebview(m));
  }

  private async onMessage(m: WebviewToHost): Promise<void> {
    switch (m.type) {
      case 'ready':
        await this.sendInit();
        break;
      case 'modLiveryPickTemplate': {
        const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Use as template', title: 'Livery model to start from (e.g. the creator\'s blank livery .yft)', filters: { 'Livery model': ['yft'] } });
        if (!picked?.[0]) return this.post({ type: 'modLiveryTemplatePicked', requestId: m.requestId });
        const info = inspectLiveryModel(await vscode.workspace.fs.readFile(picked[0]));
        this.post({ type: 'modLiveryTemplatePicked', requestId: m.requestId, template: { uri: picked[0].toString(), path: rel(picked[0]), ...info } });
        break;
      }
      case 'modLiveryImage':
        await this.image(m.requestId, m.purpose, m.follow, m.uri);
        break;
      case 'modLiveryEditExternally':
        await this.editExternally(m.requestId, m.suggestedName, m.data);
        break;
      case 'modLiveryUnfollow':
        this.links.get(m.linkId)?.dispose();
        this.links.delete(m.linkId);
        break;
      case 'modLiveryLoadExisting': {
        try {
          const data = await vscode.workspace.fs.readFile(vscode.Uri.parse(m.uri));
          const info = inspectLiveryModel(data);
          if (!info.texture) throw new Error(info.error === 'escrow-protected' ? 'It is escrow-protected.' : info.error);
          const uri = vscode.Uri.parse(m.uri);
          const design = await vscode.workspace.fs.readFile(designFile(resourceDir(uri), fileBase(uri))).then((d) => new TextDecoder().decode(d), () => undefined);
          this.post({ type: 'modLiveryTexture', requestId: m.requestId, texture: readFullTexture(data, 'yft', info.texture), ...(design ? { design } : {}) });
        } catch (err) {
          this.post({ type: 'modLiveryTexture', requestId: m.requestId, error: (err as Error).message });
        }
        break;
      }
      case 'modLiveryPickFolder': {
        const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Put liveries here', title: 'Resource folder for the livery (created if needed)' });
        this.post({ type: 'modLiveryFolder', requestId: m.requestId, ...(picked?.[0] ? { uri: picked[0].toString(), path: rel(picked[0]) } : {}) });
        break;
      }
      case 'listFonts':
      case 'modLiveryPickFont':
      case 'modLiverySaveFile':
      case 'modLiveryOpenDesign':
      case 'designLoad':
      case 'designStore':
        await handleDesignerMessage(m, (r) => this.post(r));
        break;
      case 'modLiveryDraft':
        try {
          await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
          await vscode.workspace.fs.writeFile(this.draftUri, new TextEncoder().encode(m.text));
        } catch {
          // Drafts are a convenience; ignore storage problems.
        }
        break;
      case 'modLiveryCreate':
        await this.create(m);
        break;
    }
  }

  // -- discovery ---------------------------------------------------------------------

  /** Meta files of a kind: those the manifests declare (loaded), and others lying around. */
  private async metaFiles(kind: 'CARCOLS_FILE' | 'VEHICLE_VARIATION_FILE', name: string): Promise<{ uri: vscode.Uri; loaded: boolean }[]> {
    const declared = new Map<string, vscode.Uri>();
    for (const res of this.index.resourceList) {
      for (const df of res.manifestInfo?.dataFiles ?? []) {
        if (df.type !== kind) continue;
        const pattern = df.pattern.replace(/^\.?\//, '');
        if (/[*?{[]/.test(pattern)) (await vscode.workspace.findFiles(new vscode.RelativePattern(res.root, pattern), EXCLUDE, 200)).forEach((u) => declared.set(u.toString(), u));
        else {
          const uri = vscode.Uri.joinPath(res.root, pattern);
          try {
            await vscode.workspace.fs.stat(uri);
            declared.set(uri.toString(), uri);
          } catch {
            // Declared but missing.
          }
        }
      }
    }
    const others = (await vscode.workspace.findFiles(`**/*${name}*.meta`, EXCLUDE, 500)).filter((u) => !declared.has(u.toString()));
    return [...[...declared.values()].map((uri) => ({ uri, loaded: true })), ...others.map((uri) => ({ uri, loaded: false }))];
  }

  private async read(uri: vscode.Uri): Promise<string> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    return open ? open.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  }

  private async sendInit(preselect?: string): Promise<void> {
    const [carcols, variations, images] = await Promise.all([
      this.metaFiles('CARCOLS_FILE', 'carcols'),
      this.metaFiles('VEHICLE_VARIATION_FILE', 'carvariations'),
      vscode.workspace.findFiles('**/*.png', EXCLUDE, 2000),
    ]);
    // Kit name → vehicles using it.
    const users = new Map<string, Set<string>>();
    for (const v of variations) {
      try {
        for (const [model, kits] of vehicleKits(await this.read(v.uri))) {
          for (const k of kits) {
            const key = k.toLowerCase();
            if (!users.has(key)) users.set(key, new Set());
            users.get(key)!.add(model.toLowerCase());
          }
        }
      } catch {
        // Unreadable file: skip.
      }
    }
    const yfts = this.index.all.filter((a) => a.kind === 'yft');
    // Names set with AddTextEntry in a livery resource's scripts (liveries.lua next to stream/).
    const texts = new Map<string, Map<string, string>>();
    const namesNear = async (model: vscode.Uri) => {
      const dir = basename(dirname(model)).toLowerCase() === 'stream' ? dirname(dirname(model)) : dirname(model);
      let found = texts.get(dir.toString());
      if (!found) {
        found = new Map();
        try {
          const lua = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, 'liveries.lua')));
          for (const m of lua.matchAll(/AddTextEntry\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*'((?:[^'\\]|\\.)*)'\s*\)/g)) found.set(m[1].toLowerCase(), m[2].replace(/\\(.)/g, '$1'));
        } catch {
          // No names file.
        }
        texts.set(dir.toString(), found);
      }
      return found;
    };
    const vehicles: ModLiveryVehicle[] = [];
    const seen = new Set<string>();
    // Declared files first, so a kit defined in both a loaded file and a stray copy uses the loaded one.
    for (const c of carcols) {
      let kits;
      try {
        kits = parseKits(await this.read(c.uri));
      } catch {
        continue;
      }
      for (const kit of kits) {
        const models = [...(users.get(kit.kitName.toLowerCase()) ?? [])];
        if (!models.length && !kit.liveries.length) continue;
        for (const model of models.length ? models : [kit.kitName.replace(/^\d+_/, '').replace(/_modkit$/i, '')]) {
          const key = `${model}|${kit.kitName.toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const own = yfts.find((a) => a.base === model || a.base === `${model}_hi`);
          const resource = this.index.resourceList.find((r) => c.uri.path.toLowerCase().startsWith(r.root.path.toLowerCase() + '/'));
          const folder = defaultLiveryFolder(resource?.root ?? dirname(dirname(c.uri)), resource?.name ?? model);
          const taken = new Set(yfts.map((a) => a.base));
          vehicles.push({
            model,
            kit: kit.kitName,
            ...(kit.id !== undefined ? { kitId: kit.id } : {}),
            carcols: c.uri.toString(),
            carcolsPath: rel(c.uri),
            carcolsLoaded: c.loaded,
            liveries: await Promise.all(
              kit.liveries.map(async (l) => {
                const f = yfts.find((a) => a.base === l.modelName.toLowerCase());
                const text = f && !f.summary.encrypted ? (await namesNear(f.uri)).get(l.label.toLowerCase()) : undefined;
                return { modelName: l.modelName, label: l.label, index: l.index, ...(f ? { file: { uri: f.uri.toString(), path: rel(f.uri), encrypted: !!f.summary.encrypted } } : {}), ...(text ? { text } : {}) };
              })
            ),
            escrowed: !!own?.summary.encrypted,
            ...(resource ? { resource: resource.name } : {}),
            defaultFolder: folder.toString(),
            defaultFolderPath: rel(folder),
            suggestedName: suggestLiveryName(kit, model, taken),
            uvTemplates: images.filter((u) => fileBase(u).includes(model)).map((u) => ({ uri: u.toString(), path: rel(u) })),
          });
        }
      }
    }
    vehicles.sort((a, b) => Number(b.liveries.length > 0) - Number(a.liveries.length > 0) || a.model.localeCompare(b.model));

    // Templates: small readable models named like a blank livery.
    const templates: ModLiveryTemplate[] = [];
    for (const a of yfts.filter((x) => /blank|template/i.test(x.base)).slice(0, 30)) {
      try {
        const info = inspectLiveryModel(await vscode.workspace.fs.readFile(a.uri));
        if (info.texture) templates.push({ uri: a.uri.toString(), path: rel(a.uri), ...info });
      } catch {
        // Skip unreadable files.
      }
    }
    const target = this.target && fileBase(this.target).replace(/_hi$/, '');
    // An unsaved design from last time (only when the panel first opens).
    let draft: string | undefined;
    if (!this.draftSent) {
      this.draftSent = true;
      draft = await vscode.workspace.fs.readFile(this.draftUri).then((d) => new TextDecoder().decode(d), () => undefined);
      if (draft && !/"layers":\s*\[\s*\{/.test(draft)) draft = undefined;
    }
    this.post({
      type: 'modLiveryInit',
      vehicles,
      templates,
      ...(draft ? { draft } : {}),
      ...(preselect ? { preselect } : target && vehicles.some((v) => v.model === target || v.liveries.some((l) => l.modelName.toLowerCase() === target)) ? { preselect: target } : {}),
    });
  }

  // -- images ------------------------------------------------------------------------

  private follow(uri: vscode.Uri, purpose: 'artwork' | 'uv'): number {
    const linkId = this.nextLinkId++;
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dirname(uri), basename(uri)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const send = () => {
      clearTimeout(timer);
      // Image apps often write in several steps; wait for them to finish.
      timer = setTimeout(async () => {
        try {
          const data = await vscode.workspace.fs.readFile(uri);
          if (data.length) this.post({ type: 'modLiveryFollowed', linkId, purpose, name: basename(uri), data });
        } catch {
          // Mid-save; the next event brings the finished file.
        }
      }, 400);
    };
    const subs = [watcher.onDidChange(send), watcher.onDidCreate(send)];
    this.links.set(linkId, { dispose: () => (clearTimeout(timer), subs.forEach((s) => s.dispose()), watcher.dispose()) });
    return linkId;
  }

  private async image(requestId: number, purpose: 'artwork' | 'uv', follow?: boolean, uriText?: string): Promise<void> {
    try {
      let uri = uriText ? vscode.Uri.parse(uriText) : undefined;
      if (!uri) {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: follow ? 'Follow image' : 'Use image',
          title: purpose === 'uv' ? "The vehicle's UV template (shown under your artwork)" : follow ? 'Your livery artwork (updates here whenever you save it)' : 'Your livery artwork',
          filters: { Images: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'dds'] },
        });
        uri = picked?.[0];
      }
      if (!uri) return this.post({ type: 'modLiveryImage', requestId, purpose });
      const data = await vscode.workspace.fs.readFile(uri);
      this.post({ type: 'modLiveryImage', requestId, purpose, name: basename(uri), data, ...(follow ? { linkId: this.follow(uri, purpose) } : {}) });
    } catch (err) {
      this.post({ type: 'modLiveryImage', requestId, purpose, error: (err as Error).message });
    }
  }

  private async editExternally(requestId: number, suggestedName: string, data: Uint8Array): Promise<void> {
    const target = await vscode.window.showSaveDialog({
      title: 'Save the livery image to edit in your image app',
      defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file('/'), suggestedName),
      filters: { PNG: ['png'] },
    });
    if (!target) return this.post({ type: 'modLiveryImage', requestId, purpose: 'artwork' });
    await vscode.workspace.fs.writeFile(target, data);
    const linkId = this.follow(target, 'artwork');
    void vscode.env.openExternal(target);
    this.post({ type: 'modLiveryImage', requestId, purpose: 'artwork', name: basename(target), data, linkId });
  }

  // -- writing -----------------------------------------------------------------------

  private async create(m: Extract<WebviewToHost, { type: 'modLiveryCreate' }>): Promise<void> {
    const reply = (r: { ok: boolean; message?: string; error?: string }) => this.post({ type: 'modLiveryCreated', requestId: m.requestId, ...r });
    try {
      const problem = liveryNameProblem(m.modelName) ?? liveryNameProblem(m.labelKey);
      if (problem) return reply({ ok: false, error: problem });
      const carcolsUri = vscode.Uri.parse(m.carcols);
      const modelUri = m.update ? vscode.Uri.parse(m.update) : vscode.Uri.joinPath(vscode.Uri.parse(m.folder), 'stream', `${m.modelName}.yft`);
      // An existing livery keeps its names and design in its own resource.
      const folder = m.update ? resourceDir(modelUri) : vscode.Uri.parse(m.folder);
      const base = await vscode.workspace.fs.readFile(m.update ? modelUri : vscode.Uri.parse(m.template));
      const info = inspectLiveryModel(base);
      if (!info.texture) return reply({ ok: false, error: `That model can't be used: ${info.error}.` });
      const model = replaceTexture(base, 'yft', info.texture, { width: m.width, height: m.height, format: 'DXT5', rgba: m.rgba });

      // carcols.meta: add the livery to the kit (unless updating one already there).
      const carcolsText = await this.read(carcolsUri);
      const kit = parseKits(carcolsText).find((k) => k.kitName.toLowerCase() === m.kit.toLowerCase());
      const existing = kit?.liveries.find((l) => l.modelName.toLowerCase() === m.modelName.toLowerCase());
      let carcolsNew: string | undefined;
      let modIndex = existing?.index;
      if (!existing) {
        const added = addLiveryMod(carcolsText, m.kit, m.modelName, m.labelKey);
        if ('error' in added) return reply({ ok: false, error: added.error });
        carcolsNew = added.text;
        modIndex = added.index;
      }

      // The livery's resource: manifest and names.
      const manifestUri = vscode.Uri.joinPath(folder, 'fxmanifest.lua');
      const labelsUri = vscode.Uri.joinPath(folder, 'liveries.lua');
      const exists = async (u: vscode.Uri) => vscode.workspace.fs.stat(u).then(() => true, () => false);
      const manifestText = (await exists(manifestUri)) ? new TextDecoder().decode(await vscode.workspace.fs.readFile(manifestUri)) : undefined;
      const labelsOld = (await exists(labelsUri)) ? new TextDecoder().decode(await vscode.workspace.fs.readFile(labelsUri)) : undefined;
      const labelsNew = labelScript(labelsOld, [{ key: m.labelKey, text: m.labelText || m.modelName }]);
      const manifestLoadsLabels = manifestText !== undefined && /client_scripts?\s*[({]?[^)\n]*liveries\.lua/.test(manifestText);
      const modelExists = await exists(modelUri);

      const lines = [
        `${modelExists ? 'Replace' : 'Create'} ${rel(modelUri)} (${m.width}×${m.height} DXT5 with mipmaps${modelExists ? '; the original is kept as .bak' : ''})`,
        carcolsNew ? `Add ${m.modelName} to ${m.kit} in ${rel(carcolsUri)} (livery mod ${modIndex})` : '',
        manifestText === undefined ? `Create ${rel(manifestUri)}` : manifestLoadsLabels ? '' : `Add liveries.lua to ${rel(manifestUri)}`,
        labelsOld === labelsNew ? '' : `${labelsOld === undefined ? 'Create' : 'Update'} ${rel(labelsUri)} (in-game name "${m.labelText || m.modelName}")`,
        m.design ? `Save the editable design to ${rel(designFile(folder, m.modelName))}` : '',
      ].filter(Boolean);
      const choice = await vscode.window.showWarningMessage(
        m.update ? `Update livery ${m.modelName}?` : `Create livery ${m.modelName}?`,
        { modal: true, detail: lines.map((l) => `• ${l}`).join('\n') },
        m.update ? 'Update' : 'Create'
      );
      if (!choice) return reply({ ok: false });

      if (modelExists) {
        const bak = vscode.Uri.parse(`${modelUri.toString()}.bak`);
        if (!(await exists(bak))) await vscode.workspace.fs.copy(modelUri, bak);
      }
      await vscode.workspace.fs.writeFile(modelUri, model);
      if (m.design) {
        // The editable design, to reopen later with "Edit".
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder, 'designs'));
        await vscode.workspace.fs.writeFile(designFile(folder, m.modelName), new TextEncoder().encode(m.design));
        // The work is saved now, so there's no draft to restore.
        await vscode.workspace.fs.writeFile(this.draftUri, new TextEncoder().encode('{}')).then(undefined, () => undefined);
      }
      if (manifestText === undefined) await vscode.workspace.fs.writeFile(manifestUri, new TextEncoder().encode(liveryManifest('Custom vehicle liveries')));
      else if (!manifestLoadsLabels) await vscode.workspace.fs.writeFile(manifestUri, new TextEncoder().encode(`${manifestText.replace(/\s*$/, '')}\n\nclient_script 'liveries.lua'\n`));
      if (labelsOld !== labelsNew) await vscode.workspace.fs.writeFile(labelsUri, new TextEncoder().encode(labelsNew));
      if (carcolsNew) {
        // Through the editor, so it can be undone and an open copy stays in step.
        const doc = await vscode.workspace.openTextDocument(carcolsUri);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(carcolsUri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), carcolsNew);
        if (await vscode.workspace.applyEdit(edit)) await doc.save();
      }
      await this.index.refresh();
      const resourceName = basename(folder);
      reply({
        ok: true,
        message:
          `${m.update ? 'Updated' : 'Created'} ${m.modelName}, livery mod ${modIndex} of ${m.kit}. ` +
          `Make sure the server starts ${resourceName} (ensure it in server.cfg, or keep it in a folder that's already ensured), then restart the server and reconnect. ` +
          `In game it's in the mod shop's livery list, or SetVehicleModKit(vehicle, 0) then SetVehicleMod(vehicle, 48, ${modIndex}, false).`,
      });
      await this.sendInit(m.model);
    } catch (err) {
      reply({ ok: false, error: (err as Error).message });
    }
  }
}

/** A folder for new livery models: next to the vehicle's resource, following the pack's naming where known. */
function defaultLiveryFolder(resourceRoot: vscode.Uri, resourceName: string): vscode.Uri {
  const parent = dirname(resourceRoot);
  // ONX's instructions name it onx-evp-b-livery-custom (it loads after the a-* packs, before c-*).
  const name = /^onx-evp-/i.test(resourceName) ? 'onx-evp-b-livery-custom' : `${resourceName}-liveries`;
  return vscode.Uri.joinPath(parent, name);
}

