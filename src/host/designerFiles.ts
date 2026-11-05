import * as vscode from 'vscode';
import type { HostToWebview, WebviewToHost } from '../shared/model';
import { basename, dirname } from './assetIndex';
import { systemFonts } from './systemFonts';

/*
 * File handling for the livery designer, shared by the model preview (texture
 * liveries) and the mod-kit livery panel: fonts, saving and opening designs,
 * PNG export, and designs kept next to the liveries they belong to.
 */

const rel = (u: vscode.Uri) => vscode.workspace.asRelativePath(u);

/** The resource folder a streamed file belongs to (the folder above its stream/ folder). */
export function resourceDir(file: vscode.Uri): vscode.Uri {
  let dir = dirname(file);
  for (let i = 0; i < 4; i++) {
    if (basename(dir).toLowerCase() === 'stream') return dirname(dir);
    dir = dirname(dir);
  }
  return dirname(file);
}

/** Where a livery's editable design is kept: designs/<name>.livery.json in its resource (outside stream/). */
export function designFile(resource: vscode.Uri, name: string): vscode.Uri {
  return vscode.Uri.joinPath(resource, 'designs', `${name.toLowerCase()}.livery.json`);
}

type DesignerMessage = Extract<WebviewToHost, { type: 'listFonts' | 'modLiveryPickFont' | 'modLiverySaveFile' | 'modLiveryOpenDesign' | 'designLoad' | 'designStore' }>;

export function isDesignerMessage(m: WebviewToHost): m is DesignerMessage {
  return ['listFonts', 'modLiveryPickFont', 'modLiverySaveFile', 'modLiveryOpenDesign', 'designLoad', 'designStore'].includes(m.type);
}

/** Handles a designer request, replying through `post`. */
export async function handleDesignerMessage(m: DesignerMessage, post: (m: HostToWebview) => void): Promise<void> {
  switch (m.type) {
    case 'listFonts':
      post({ type: 'fontList', requestId: m.requestId, families: await systemFonts() });
      break;
    case 'modLiveryPickFont': {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Add font', title: 'A font file for livery text (it is stored in the design)', filters: { Fonts: ['ttf', 'otf', 'woff', 'woff2'] } });
      if (!picked?.[0]) return post({ type: 'modLiveryFont', requestId: m.requestId });
      post({ type: 'modLiveryFont', requestId: m.requestId, name: basename(picked[0]), data: await vscode.workspace.fs.readFile(picked[0]) });
      break;
    }
    case 'modLiverySaveFile': {
      const png = m.kind === 'png';
      const target = await vscode.window.showSaveDialog({
        title: png ? 'Save the livery as a PNG' : 'Save the livery design (editable layers)',
        defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file('/'), m.suggestedName),
        filters: png ? { PNG: ['png'] } : { 'Livery design': ['json'] },
      });
      if (!target) return post({ type: 'modLiverySaved', requestId: m.requestId });
      await vscode.workspace.fs.writeFile(target, m.data);
      post({ type: 'modLiverySaved', requestId: m.requestId, path: rel(target) });
      break;
    }
    case 'modLiveryOpenDesign': {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Open design', title: 'A livery design (.livery.json)', filters: { 'Livery design': ['json'] } });
      if (!picked?.[0]) return post({ type: 'modLiveryDesign', requestId: m.requestId });
      try {
        post({ type: 'modLiveryDesign', requestId: m.requestId, name: basename(picked[0]), text: new TextDecoder().decode(await vscode.workspace.fs.readFile(picked[0])) });
      } catch (err) {
        post({ type: 'modLiveryDesign', requestId: m.requestId, error: (err as Error).message });
      }
      break;
    }
    case 'designLoad': {
      const uri = designFile(resourceDir(vscode.Uri.parse(m.origin)), m.texture);
      const text = await vscode.workspace.fs.readFile(uri).then((d) => new TextDecoder().decode(d), () => undefined);
      post({ type: 'designText', requestId: m.requestId, ...(text ? { text, path: rel(uri) } : {}) });
      break;
    }
    case 'designStore': {
      const dir = resourceDir(vscode.Uri.parse(m.origin));
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(dir, 'designs'));
      await vscode.workspace.fs.writeFile(designFile(dir, m.texture), new TextEncoder().encode(m.text));
      break;
    }
  }
}
