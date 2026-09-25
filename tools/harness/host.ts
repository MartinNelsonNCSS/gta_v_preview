/*
 * Runs the real extension host (src/host) in the page, against files served
 * by tools/harness/serve.mjs, and connects it to the real webview bundle.
 */
import { GtaPreviewProvider } from '../../src/host/previewProvider';
import type { ViewKind, WebviewToHost } from '../../src/shared/model';
import { ROOT, Uri } from './vscode-stub';

const params = new URLSearchParams(location.search);
const file = params.get('file') ?? '';
/** ?convert=a.png,b.jpg opens the DDS converter panel instead of a preview. */
const convert = params.get('convert');
const ext = file.split('.').pop()!.toLowerCase();
const KINDS: Record<string, ViewKind> = { ydr: 'drawable', ydd: 'dictionary', yft: 'fragment', ytyp: 'ytyp', ytd: 'ytd', ymap: 'ymap', ybn: 'ybn', ymt: 'ymt' };

let toHost: (m: WebviewToHost) => void = () => {};
const panel = {
  webview: {
    options: {},
    html: '',
    cspSource: '',
    asWebviewUri: (u: unknown) => u,
    postMessage: async (m: unknown) => (window.postMessage(m, '*'), true),
    onDidReceiveMessage: (cb: (m: WebviewToHost) => void) => ((toHost = cb), { dispose() {} }),
  },
  onDidDispose: () => ({ dispose() {} }),
};
if (convert) {
  // Minimal stand-in for host/converterPanel.ts (which needs vscode.window.createWebviewPanel).
  const files = convert.split(',');
  panel.webview.onDidReceiveMessage(async (m: WebviewToHost) => {
    if (m.type === 'ready') {
      const loaded = await Promise.all(files.map(async (f) => ({ name: f.split('/').pop()!, uri: f, data: new Uint8Array(await (await fetch(`${ROOT}/${f}`)).arrayBuffer()) })));
      void panel.webview.postMessage({ type: 'converterFiles', files: loaded });
    } else if (m.type === 'writeConverted') {
      const stem = m.sourceUri.replace(/\.[^.]+$/, '');
      const target = `${ROOT}/${/\.dds$/i.test(m.sourceUri) ? `${stem}_${m.format}` : stem}.dds`;
      const res = await fetch(target, { method: 'PUT', body: m.data.slice() });
      void panel.webview.postMessage({ type: 'converted', requestId: m.requestId, ok: res.ok, path: target });
    }
  });
} else {
  const provider = new GtaPreviewProvider({ extensionUri: Uri.file('/ext') } as never, KINDS[ext]);
  provider.resolveCustomEditor(provider.openCustomDocument(Uri.file(`${ROOT}/${file}`) as never), panel as never);
}

const state: Record<string, unknown> = JSON.parse(localStorage.getItem('harness-state') ?? '{}');
(window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
  postMessage: (m: WebviewToHost) => toHost(m),
  getState: () => state,
  setState: (s: Record<string, unknown>) => {
    Object.assign(state, s);
    localStorage.setItem('harness-state', JSON.stringify(state));
  },
});
