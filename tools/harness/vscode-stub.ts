/*
 * Browser stand-in for the `vscode` module. Lets the real extension host code
 * (src/host) run inside the harness page, reading files from serve.mjs.
 */
export const ROOT = '/files';

export class Uri {
  constructor(readonly scheme: string, readonly path: string) {}
  static file(p: string) { return new Uri('file', p); }
  static parse(s: string) {
    const m = /^([a-z][\w+.-]*):\/\/(.*)$/i.exec(s);
    if (!m) throw new Error(`Invalid URI: ${s}`);
    return new Uri(m[1], m[2]);
  }
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
/** Files picked or saved through the stubbed dialogs live in memory. */
const memory = new Map<string, Uint8Array>();
const isMemory = (u: Uri) => u.path.startsWith('/__mem__/');
const workspaceFolder = { uri: Uri.file(ROOT), name: 'harness', index: 0 };

export const workspace = {
  fs: {
    readFile: async (u: Uri) => {
      if (isMemory(u)) return memory.get(u.path)!;
      const res = await fetch(url(u));
      if (!res.ok) throw new Error(`${res.status} ${u.path}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    writeFile: async (u: Uri, data: Uint8Array) => {
      if (isMemory(u)) {
        memory.set(u.path, data);
        console.log(`[harness] saved ${u.path} (${data.length} bytes)`);
        return;
      }
      const res = await fetch(url(u), { method: 'PUT', body: data.slice() });
      if (!res.ok) throw new Error(`write failed: ${res.status}`);
    },
    stat: async (u: Uri) => {
      if (isMemory(u)) return { mtime: 0 };
      const res = await fetch(url(u), { method: 'HEAD' });
      if (!res.ok) throw new Error(`not found: ${u.path}`);
      return { mtime: 0 };
    },
    readDirectory: async () => [],
  },
  getWorkspaceFolder: () => workspaceFolder,
  findFiles: async () => (await list()).map((p) => Uri.file(`${ROOT}/${p}`)),
  getConfiguration: () => ({ get: (_k: string, d: unknown) => d }),
  createFileSystemWatcher: () => ({ onDidChange: () => noop, onDidCreate: () => noop, dispose() {} }),
};
export const window = {
  showWarningMessage: async (m: string, opts?: { modal?: boolean; detail?: string }, ...items: string[]) => {
    if (opts?.modal && items.length) return globalThis.confirm(`${m}\n\n${opts.detail ?? ''}`) ? items[0] : undefined;
    console.warn(m);
    return undefined;
  },
  showOpenDialog: () =>
    new Promise<Uri[] | undefined>((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.onchange = async () => {
        const f = input.files?.[0];
        if (!f) return resolve(undefined);
        const path = `/__mem__/${f.name}`;
        memory.set(path, new Uint8Array(await f.arrayBuffer()));
        resolve([Uri.file(path)]);
      };
      input.click();
    }),
  showSaveDialog: async (o: { defaultUri?: Uri }) => Uri.file(`/__mem__/${o.defaultUri?.path.split('/').pop() ?? 'export'}`),
  registerCustomEditorProvider: () => noop,
};
/** Test hook: lets automated checks inject a picked file without a dialog. */
(globalThis as unknown as { __harnessPick?: (name: string, data: Uint8Array) => void }).__harnessPick = (name, data) => {
  const path = `/__mem__/${name}`;
  memory.set(path, data);
  window.showOpenDialog = async () => [Uri.file(path)];
};
(globalThis as unknown as { __harnessMemory?: Map<string, Uint8Array> }).__harnessMemory = memory;
export const commands = {
  executeCommand: async (cmd: string, uri: Uri) => {
    if (cmd === 'vscode.openWith') location.search = `?file=${encodeURIComponent(uri.path.slice(ROOT.length + 1))}`;
  },
};
