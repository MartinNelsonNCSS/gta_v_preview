/*
 * Browser stand-in for the VS Code extension host, for developing the webview
 * without launching VS Code. Serves files via tools/harness/serve.mjs.
 */
import { parseYdd, parseYdr } from '../../src/formats/drawable';
import { joaat } from '../../src/formats/hash';
import { listYtdTextureNames, parseYtd, readYtdTextures } from '../../src/formats/ytd';
import { parseYtyp } from '../../src/formats/ytyp';
import type { DrawableData, HostToWebview, WebviewToHost } from '../../src/shared/model';

const params = new URLSearchParams(location.search);
const file = params.get('file') ?? '';
const ext = file.split('.').pop()!.toLowerCase();
const maxSize = Number(params.get('maxSize') ?? 1024);

interface Asset { path: string; base: string; ext: string; hash: number }
let assetsPromise: Promise<Asset[]> | undefined;
const assets = () =>
  (assetsPromise ??= fetch('/api/list')
    .then((r) => r.json())
    .then((paths: string[]) =>
      paths.map((p) => {
        const name = p.slice(p.lastIndexOf('/') + 1).toLowerCase();
        const base = name.slice(0, name.lastIndexOf('.'));
        return { path: p, base, ext: name.slice(name.lastIndexOf('.') + 1), hash: joaat(base) };
      })
    ));
const read = async (p: string) => new Uint8Array(await (await fetch(`/files/${p.split('/').map(encodeURIComponent).join('/')}`)).arrayBuffer());
const post = (m: HostToWebview) => window.postMessage(m, '*');
const nameToHash = (n: string) => (/^hash_([0-9a-f]{8})$/i.test(n) ? parseInt(n.slice(5), 16) : joaat(n));

async function handle(m: WebviewToHost) {
  try {
    if (m.type === 'ready') {
      const data = await read(file);
      const name = file.slice(file.lastIndexOf('/') + 1);
      if (ext === 'ydr') post({ type: 'drawables', file: name, kind: 'drawable', drawables: [parseYdr(data, { maxSize })] });
      else if (ext === 'ydd') post({ type: 'drawables', file: name, kind: 'dictionary', drawables: parseYdd(data, { maxSize }) });
      else if (ext === 'ytd') post({ type: 'ytd', file: name, textures: parseYtd(data, { maxSize }) });
      else if (ext === 'ytyp') post({ type: 'ytyp', file: name, ytyp: parseYtyp(data, { knownNames: (await assets()).map((a) => a.base) }) });
    } else if (m.type === 'findTextures') {
      const wanted = new Set(m.names);
      const hints = new Set(m.hints.map((h) => h.toLowerCase()));
      const ytds = (await assets()).filter((a) => a.ext === 'ytd').sort((a, b) => Number(hints.has(b.base)) - Number(hints.has(a.base)));
      let searched = 0;
      for (const y of ytds) {
        if (!wanted.size) break;
        searched++;
        try {
          const data = await read(y.path);
          const names = new Set(listYtdTextureNames(data).map((n) => n.toLowerCase()));
          const matches = new Set([...wanted].filter((n) => names.has(n)));
          if (!matches.size) continue;
          const found = readYtdTextures(data, matches, { maxSize: Math.min(maxSize, m.maxSize ?? Infinity) });
          found.forEach((t) => wanted.delete(t.name.toLowerCase()));
          post({ type: 'textures', requestId: m.requestId, textures: found, source: y.base + '.ytd', searched, done: false });
        } catch {}
      }
      post({ type: 'textures', requestId: m.requestId, textures: [], source: '', searched, done: true });
    } else if (m.type === 'loadArchetypes') {
      const all = await assets();
      const models: Record<string, DrawableData | null> = {};
      for (const req of m.archetypes) {
        const hash = nameToHash(req.name);
        const ydr = all.find((a) => a.ext === 'ydr' && a.hash === hash);
        try {
          models[req.name] = ydr ? parseYdr(await read(ydr.path), { maxSize: Math.min(maxSize, m.maxTextureSize ?? Infinity) }) : null;
        } catch {
          models[req.name] = null;
        }
      }
      post({ type: 'archetypeModels', requestId: m.requestId, models, done: true });
    } else if (m.type === 'openAsset') {
      const hash = nameToHash(m.name);
      const a = (await assets()).find((x) => x.ext === m.ext && x.hash === hash);
      if (a) location.search = `?file=${encodeURIComponent(a.path)}`;
    }
  } catch (err) {
    post({ type: 'error', message: (err as Error).message });
  }
}

const state: Record<string, unknown> = JSON.parse(localStorage.getItem('harness-state') ?? '{}');
(window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
  postMessage: (m: WebviewToHost) => void handle(m),
  getState: () => state,
  setState: (s: Record<string, unknown>) => {
    Object.assign(state, s);
    localStorage.setItem('harness-state', JSON.stringify(state));
  },
});
document.body.dataset.kind = ext;
