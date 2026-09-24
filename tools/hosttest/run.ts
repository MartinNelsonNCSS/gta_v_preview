/* Drives PreviewSession (the real host code) against files on disk. Usage: node out/hosttest.js <file> */
import { GtaPreviewProvider } from '../../src/host/previewProvider';
import { Uri } from './vscode-stub';

const file = process.argv[2];
const kind = ({ ydr: 'drawable', ydd: 'dictionary', yft: 'fragment', ytyp: 'ytyp', ytd: 'ytd', ymap: 'ymap', ybn: 'ybn', ymt: 'ymt' } as const)[file.split('.').pop()!.toLowerCase() as 'ydr'];
let onMessage: (m: unknown) => void = () => {};
const received: any[] = [];
const panel = {
  webview: {
    options: {}, html: '', cspSource: 'x',
    asWebviewUri: (u: unknown) => u,
    postMessage: async (m: any) => { received.push(m); return true; },
    onDidReceiveMessage: (cb: (m: unknown) => void) => ((onMessage = cb), { dispose() {} }),
  },
  onDidDispose: () => ({ dispose() {} }),
};
const provider = new GtaPreviewProvider({ extensionUri: Uri.file('/ext') } as any, kind);
provider.resolveCustomEditor(provider.openCustomDocument(Uri.file(file) as any), panel as any);
const settle = () => new Promise((r) => setTimeout(r, 50));
(async () => {
  onMessage({ type: 'ready' });
  while (!received.length) await settle();
  const first = received[0];
  console.log('initial:', first.type, first.message ?? '');
  if (first.type === 'drawables') {
    const names = first.drawables.flatMap((d: any) => d.shaders.flatMap((s: any) => s.textures.map((t: any) => t.texture)));
    onMessage({ type: 'findTextures', requestId: 1, names, hints: [] });
    while (!received.some((m) => m.type === 'textures' && m.done)) await settle();
    const tex = received.filter((m) => m.type === 'textures');
    const found = tex.flatMap((m) => m.textures.map((t: any) => t.name));
    console.log(`textures: requested ${new Set(names.map((n: string) => n.toLowerCase())).size}, found ${found.length} from [${[...new Set(tex.map((m) => m.source).filter(Boolean))]}], searched ${tex.at(-1).searched}`);
  }
  if (first.type === 'ytyp') {
    const y = first.ytyp;
    console.log('archetypes:', y.archetypes.map((a: any) => a.name).slice(0, 6).join(', '));
    const mlo = y.archetypes.find((a: any) => a.mlo);
    const names = mlo ? [...new Set(mlo.mlo.entities.map((e: any) => e.archetype))] : y.archetypes.map((a: any) => a.name);
    onMessage({ type: 'loadArchetypes', requestId: 2, archetypes: (names as string[]).map((name) => ({ name })) });
    while (!received.some((m) => m.type === 'archetypeModels' && m.done)) await settle();
    const models = Object.assign({}, ...received.filter((m) => m.type === 'archetypeModels').map((m) => m.models));
    console.log(`models: ${Object.values(models).filter(Boolean).length}/${names.length} loaded:`, Object.entries(models).filter(([, d]) => d).map(([n]) => n).join(', '));
    onMessage({ type: 'openAsset', name: y.archetypes[0].name, ext: 'ydr' });
    await settle();
  }
  if (first.type === 'ymap') {
    const y = first.ymap;
    console.log(`ymap: ${y.entities.length} entities, ${y.carGenerators.length} car gens`);
    const names = [...new Set(y.entities.map((e: any) => e.archetype))] as string[];
    onMessage({ type: 'loadArchetypes', requestId: 3, archetypes: names.map((name) => ({ name })) });
    while (!received.some((m) => m.type === 'archetypeModels' && m.done)) await settle();
    const batches = received.filter((m) => m.type === 'archetypeModels');
    const defs = Object.assign({}, ...batches.map((m) => m.archetypes));
    const models = Object.assign({}, ...batches.map((m) => m.models));
    console.log(`models ${Object.values(models).filter(Boolean).length}/${names.length}, defs ${Object.values(defs).filter(Boolean).length}, interiors: ${Object.values(defs).filter((d: any) => d?.mlo).map((d: any) => `${d.name}(${d.mlo.entities.length})`).join(', ') || 'none'}`);
  }
  if (first.type === 'ymt') {
    const ped = first.ymt.pedVariation;
    console.log(`ymt root=${first.ymt.rootType} files=${first.files.length}` + (ped ? ` components=${ped.components.map((c: any) => `${c.key}:${c.drawables.length}`).join(',')} props=${ped.props.length}` : ''));
    if (ped) {
      const d = ped.components[0].drawables[0];
      const prefix = file.split('/').pop()!.replace(/\.ymt$/i, '').toLowerCase();
      onMessage({ type: 'loadTextureFile', requestId: 4, name: `${prefix}^${d.textures[0].file}` });
      onMessage({ type: 'loadDrawableFile', requestId: 5, name: `${prefix}^${d.file}` });
      while (!received.some((m) => m.type === 'textureFile') || !received.some((m) => m.type === 'drawableFile')) await settle();
      const t = received.find((m) => m.type === 'textureFile');
      const m = received.find((m) => m.type === 'drawableFile');
      console.log(`variation texture: ${t.textures.map((x: any) => `${x.name} ${x.width}x${x.height}`).join(', ') || t.error}; model: ${m.drawables.length ? m.drawables.map((x: any) => x.name).join(', ') : m.error}`);
    }
  }
  if (first.type === 'text') console.log(`text view: ${first.note}`);
  if (first.type === 'ybn') console.log(`ybn: ${first.bounds.triangles} tris, ${first.bounds.primitives.length} primitives`);
  const errors = received.filter((m) => m.type === 'error');
  if (errors.length) console.log('errors:', errors.map((e) => e.message));
})();
