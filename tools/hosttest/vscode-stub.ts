/* Minimal stand-in for the `vscode` module so the extension host code can run under Node. */
import { promises as fs } from 'fs';
import { join } from 'path';

export class Uri {
  constructor(readonly scheme: string, readonly path: string) {}
  static file(p: string) { return new Uri('file', p); }
  static parse(s: string) { const m = /^([a-z]+):\/\/(.*)$/i.exec(s)!; return new Uri(m[1], m[2]); }
  static joinPath(u: Uri, ...parts: string[]) { return new Uri(u.scheme, [u.path.replace(/\/$/, ''), ...parts].join('/')); }
  with(c: { path?: string }) { return new Uri(this.scheme, c.path ?? this.path); }
  toString() { return `${this.scheme}://${this.path}`; }
  get fsPath() { return this.path; }
}
export enum FileType { File = 1, Directory = 2 }
export class RelativePattern { constructor(readonly base: unknown, readonly pattern: string) {} }
export class EventEmitter<T> {
  private ls: ((e: T) => void)[] = [];
  event = (l: (e: T) => void) => (this.ls.push(l), { dispose() {} });
  fire(e: T) { this.ls.forEach((l) => l(e)); }
  dispose() {}
}
export enum DiagnosticSeverity { Error = 0, Warning = 1, Information = 2, Hint = 3 }
export class Range { constructor(readonly sl: number, readonly sc: number, readonly el: number, readonly ec: number) {} }
export class Diagnostic { source?: string; code?: unknown; constructor(readonly range: Range, readonly message: string, readonly severity: DiagnosticSeverity) {} }
export enum TreeItemCollapsibleState { None = 0, Collapsed = 1, Expanded = 2 }
export class TreeItem { description?: string; tooltip?: unknown; iconPath?: unknown; command?: unknown; contextValue?: string; resourceUri?: Uri; constructor(readonly label: string, readonly collapsibleState?: number) {} }
export class ThemeIcon { constructor(readonly id: string, readonly color?: unknown) {} }
export class ThemeColor { constructor(readonly id: string) {} }
export class MarkdownString { constructor(readonly value: string) {} }
export enum QuickPickItemKind { Separator = -1, Default = 0 }
export enum ProgressLocation { SourceControl = 1, Window = 10, Notification = 15 }

/** Root folder for findFiles, set by the test. */
export const testRoot = { path: '' };
async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else out.push(p);
  }
  return out;
}
const noop = { dispose() {} };
export const workspace = {
  fs: {
    readFile: async (u: Uri) => new Uint8Array(await fs.readFile(u.path)),
    writeFile: async (u: Uri, d: Uint8Array) => fs.writeFile(u.path, d),
    stat: async (u: Uri) => ({ mtime: (await fs.stat(u.path)).mtimeMs }),
    readDirectory: async (u: Uri) => (await fs.readdir(u.path, { withFileTypes: true })).map((e) => [e.name, e.isDirectory() ? FileType.Directory : FileType.File] as [string, FileType]),
  },
  getWorkspaceFolder: () => ({ uri: Uri.file(testRoot.path), name: 'test', index: 0 }),
  findFiles: async (glob: string) => {
    const files = await walk(testRoot.path);
    const exts = /\{([^}]+)\}/.exec(glob)?.[1].split(',') ?? [];
    return files.filter((f) => exts.some((x) => (x.includes('.') ? f.endsWith('/' + x) : f.toLowerCase().endsWith('.' + x)))).map((f) => Uri.file(f));
  },
  getConfiguration: () => ({ get: (_k: string, d: unknown) => d }),
  createFileSystemWatcher: () => ({ onDidChange: () => noop, onDidCreate: () => noop, onDidDelete: () => noop, dispose() {} }),
};
export const languages = { createDiagnosticCollection: () => { const m = new Map<string, Diagnostic[]>(); return { set: (u: Uri, d: Diagnostic[]) => m.set(u.toString(), d), clear: () => m.clear(), dispose() {}, entries: m }; } };
export const window = {
  showWarningMessage: async () => undefined,
  showInformationMessage: async () => undefined,
  withProgress: async (_o: unknown, task: (p: { report(): void }) => Promise<unknown>) => task({ report() {} }),
  registerCustomEditorProvider: () => noop,
};
export const commands = { executeCommand: async () => undefined, registerCommand: () => noop };
