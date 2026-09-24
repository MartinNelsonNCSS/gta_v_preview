/*
 * Runs the real extension host (src/host) in the page, against files served
 * by tools/harness/serve.mjs, and connects it to the real webview bundle.
 */
import { GtaPreviewProvider } from '../../src/host/previewProvider';
import type { ViewKind, WebviewToHost } from '../../src/shared/model';
import { ROOT, Uri } from './vscode-stub';

const file = new URLSearchParams(location.search).get('file') ?? '';
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
const provider = new GtaPreviewProvider({ extensionUri: Uri.file('/ext') } as never, KINDS[ext]);
provider.resolveCustomEditor(provider.openCustomDocument(Uri.file(`${ROOT}/${file}`) as never), panel as never);

const state: Record<string, unknown> = JSON.parse(localStorage.getItem('harness-state') ?? '{}');
(window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
  postMessage: (m: WebviewToHost) => toHost(m),
  getState: () => state,
  setState: (s: Record<string, unknown>) => {
    Object.assign(state, s);
    localStorage.setItem('harness-state', JSON.stringify(state));
  },
});
