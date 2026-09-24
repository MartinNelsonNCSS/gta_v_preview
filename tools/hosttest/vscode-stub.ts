/* Minimal stand-in for the `vscode` module so the extension host code can run under Node. */
import { promises as fs } from 'fs';

export class Uri {
  constructor(readonly scheme: string, readonly path: string) {}
  static file(p: string) { return new Uri('file', p); }
  static joinPath(u: Uri, ...parts: string[]) { return new Uri(u.scheme, [u.path.replace(/\/$/, ''), ...parts].join('/')); }
  with(c: { path?: string }) { return new Uri(this.scheme, c.path ?? this.path); }
  toString() { return `${this.scheme}://${this.path}`; }
  get fsPath() { return this.path; }
}
export enum FileType { File = 1, Directory = 2 }
export class RelativePattern { constructor(readonly base: unknown, readonly pattern: string) {} }
const noop = { dispose() {} };
export const workspace = {
  fs: {
    readFile: async (u: Uri) => new Uint8Array(await fs.readFile(u.path)),
    stat: async (u: Uri) => ({ mtime: (await fs.stat(u.path)).mtimeMs }),
    readDirectory: async (u: Uri) =>
      (await fs.readdir(u.path, { withFileTypes: true })).map((e) => [e.name, e.isDirectory() ? FileType.Directory : FileType.File] as [string, FileType]),
  },
  getWorkspaceFolder: () => undefined,
  findFiles: async () => [],
  getConfiguration: () => ({ get: (_k: string, d: unknown) => d }),
  createFileSystemWatcher: () => ({ onDidChange: () => noop, onDidCreate: () => noop, dispose() {} }),
};
export const window = { showWarningMessage: (m: string) => console.log('WARN', m), registerCustomEditorProvider: () => noop };
export const commands = { executeCommand: async (...a: unknown[]) => console.log('EXEC', a[0], String(a[1])) };
