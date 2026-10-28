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
export enum ProgressLocation { SourceControl = 1, Window = 10, Notification = 15 }
export class Position { constructor(readonly line: number, readonly character: number) {} }
export class Range { constructor(readonly startLine: number, readonly startCharacter: number, readonly endLine: number, readonly endCharacter: number) {} }
export class WorkspaceEdit {
  readonly replacements: { uri: Uri; text: string }[] = [];
  replace(uri: Uri, _range: Range, text: string) { this.replacements.push({ uri, text }); }
}
/** Text documents opened by the harness (for custom text editors). */
export const textDocuments = new Map<string, { uri: Uri; text: string; getText(): string; readonly lineCount: number }>();
const docListeners: ((e: { document: unknown; contentChanges: unknown[] }) => void)[] = [];
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
    readDirectory: async (u: Uri) => {
      listing = undefined;
      const rel = u.path.slice(ROOT.length + 1).replace(/\/$/, '');
      const entries = new Map<string, FileType>();
      for (const p of await list()) {
        if (rel && !p.startsWith(rel + '/')) continue;
        const rest = rel ? p.slice(rel.length + 1) : p;
        const [head, ...tail] = rest.split('/');
        entries.set(head, tail.length ? FileType.Directory : FileType.File);
      }
      return [...entries];
    },
    delete: async (u: Uri) => {
      listing = undefined;
      await fetch(url(u), { method: 'DELETE' });
    },
  },
  getWorkspaceFolder: () => workspaceFolder,
  workspaceFolders: [workspaceFolder],
  onDidChangeTextDocument: (l: (e: { document: unknown; contentChanges: unknown[] }) => void) => (docListeners.push(l), noop),
  applyEdit: async (edit: WorkspaceEdit) => {
    for (const r of edit.replacements) {
      const doc = textDocuments.get(r.uri.toString());
      if (!doc) continue;
      doc.text = r.text;
      await fetch(url(r.uri), { method: 'PUT', body: r.text });
      docListeners.forEach((l) => l({ document: doc, contentChanges: [{}] }));
    }
    return true;
  },
  findFiles: async () => (await list()).map((p) => Uri.file(`${ROOT}/${p}`)),
  getConfiguration: () => ({ get: (_k: string, d: unknown) => d }),
  createFileSystemWatcher: () => ({ onDidChange: () => noop, onDidCreate: () => noop, dispose() {} }),
};
export const window = {
  showInformationMessage: async (m: string) => (console.info('[info]', m), undefined),
  withProgress: async <T>(_o: unknown, task: (p: { report(v: unknown): void }) => Promise<T>) => task({ report() {} }),
  registerCustomEditorProvider2: () => noop,
  showWarningMessage: async (m: string, opts?: { modal?: boolean; detail?: string }, ...items: string[]) => {
    if (opts?.modal && items.length) return globalThis.confirm(`${m}\n\n${opts.detail ?? ''}`) ? items[0] : undefined;
    console.warn(m);
    return undefined;
  },
  showOpenDialog: (o?: { canSelectMany?: boolean }) =>
    new Promise<Uri[] | undefined>((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = !!o?.canSelectMany;
      input.onchange = async () => {
        const files = [...(input.files ?? [])];
        if (!files.length) return resolve(undefined);
        const uris: Uri[] = [];
        for (const f of files) {
          const path = `/__mem__/${f.name}`;
          memory.set(path, new Uint8Array(await f.arrayBuffer()));
          uris.push(Uri.file(path));
        }
        resolve(uris);
      };
      input.click();
    }),
  showInputBox: async (o: { prompt?: string; value?: string; validateInput?: (v: string) => string | undefined }) => {
    for (;;) {
      const v = globalThis.prompt(o.prompt ?? '', o.value ?? '');
      if (v === null) return undefined;
      const problem = o.validateInput?.(v);
      if (!problem) return v;
      globalThis.alert(problem);
    }
  },
  showSaveDialog: async (o: { defaultUri?: Uri }) => Uri.file(`/__mem__/${o.defaultUri?.path.split('/').pop() ?? 'export'}`),
  registerCustomEditorProvider: () => noop,
};
/** Test hook: lets automated checks inject a picked file without a dialog. */
(globalThis as unknown as { __harnessPick?: (name: string, data: Uint8Array) => void }).__harnessPick = (name, data) => {
  const path = `/__mem__/${name}`;
  memory.set(path, data);
  window.showOpenDialog = async () => [Uri.file(path)];
};
/** Test hook: inject several picked files (multi-select dialogs). */
(globalThis as unknown as { __harnessPickMany?: (files: { name: string; data: Uint8Array }[]) => void }).__harnessPickMany = (files) => {
  const uris = files.map((f) => {
    const path = `/__mem__/${f.name}`;
    memory.set(path, f.data);
    return Uri.file(path);
  });
  window.showOpenDialog = async () => uris;
};
/** Test hook: the next open dialog returns these served files (paths relative to the samples root). */
(globalThis as unknown as { __harnessPickPaths?: (paths: string[]) => void }).__harnessPickPaths = (paths) => {
  window.showOpenDialog = async () => paths.map((p) => Uri.file(`${ROOT}/${p}`));
};
/** Test hook: answer the next input box without a prompt. */
(globalThis as unknown as { __harnessInput?: (value: string | undefined) => void }).__harnessInput = (value) => {
  window.showInputBox = async () => value;
};
/** Test hook: answer modal confirmations without a dialog. */
(globalThis as unknown as { __harnessConfirm?: (yes: boolean) => void }).__harnessConfirm = (yes) => {
  window.showWarningMessage = async (m: string, opts?: { modal?: boolean; detail?: string }, ...items: string[]) => {
    console.warn('CONFIRM', m, opts?.detail ?? '');
    return opts?.modal && items.length && yes ? items[0] : undefined;
  };
};
(globalThis as unknown as { __harnessMemory?: Map<string, Uint8Array> }).__harnessMemory = memory;
export const commands = {
  executeCommand: async (cmd: string, uri: Uri) => {
    if (cmd === 'vscode.openWith') location.search = `?file=${encodeURIComponent(uri.path.slice(ROOT.length + 1))}`;
    else console.info('[command]', cmd, uri?.path ?? '');
  },
  registerCommand: () => noop,
};
