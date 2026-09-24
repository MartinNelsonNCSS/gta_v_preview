/*
 * Browser stand-in for the `vscode` module. Lets the real extension host code
 * (src/host) run inside the harness page, reading files from serve.mjs.
 */
export const ROOT = '/files';

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

let listing: Promise<string[]> | undefined;
const list = () => (listing ??= fetch('/api/list').then((r) => r.json() as Promise<string[]>));
const url = (u: Uri) => u.path.split('/').map(encodeURIComponent).join('/');
const noop = { dispose() {} };
const workspaceFolder = { uri: Uri.file(ROOT), name: 'harness', index: 0 };

export const workspace = {
  fs: {
    readFile: async (u: Uri) => {
      const res = await fetch(url(u));
      if (!res.ok) throw new Error(`${res.status} ${u.path}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    stat: async () => ({ mtime: 0 }),
    readDirectory: async () => [],
  },
  getWorkspaceFolder: () => workspaceFolder,
  findFiles: async () => (await list()).map((p) => Uri.file(`${ROOT}/${p}`)),
  getConfiguration: () => ({ get: (_k: string, d: unknown) => d }),
  createFileSystemWatcher: () => ({ onDidChange: () => noop, onDidCreate: () => noop, dispose() {} }),
};
export const window = { showWarningMessage: (m: string) => console.warn(m), registerCustomEditorProvider: () => noop };
export const commands = {
  executeCommand: async (cmd: string, uri: Uri) => {
    if (cmd === 'vscode.openWith') location.search = `?file=${encodeURIComponent(uri.path.slice(ROOT.length + 1))}`;
  },
};
