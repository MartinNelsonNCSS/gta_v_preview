import type { HostToWebview } from '../shared/model';
import { errorView, h, onHostMessage, vscode } from './ui';
import { ModelPanel } from './views/modelPanel';
import { ytdView } from './views/ytdView';
import { ytypView } from './views/ytypView';
import { ybnView } from './views/ybnView';
import { ymapView } from './views/ymapView';

const app = document.getElementById('app')!;
let modelPanel: ModelPanel | undefined;

function show(el: HTMLElement): void {
  app.replaceChildren(el);
}

onHostMessage((m: HostToWebview) => {
  switch (m.type) {
    case 'drawables':
      if (!m.drawables.length) {
        show(errorView('This drawable dictionary is empty.'));
        return;
      }
      // Reuse the panel on live reload so the camera stays put.
      if (!modelPanel) {
        modelPanel = new ModelPanel();
        show(modelPanel.el);
      }
      modelPanel.setDrawables(m.drawables);
      break;
    case 'ytd':
      show(ytdView(m.file, m.textures));
      break;
    case 'ytyp':
      show(ytypView(m.file, m.ytyp));
      break;
    case 'ymap':
      show(ymapView(m.file, m.ymap));
      break;
    case 'ybn':
      show(ybnView(m.file, m.bounds));
      break;
    case 'error':
      if (!app.firstChild || app.querySelector('.loading')) show(errorView(m.message));
      else console.error(m.message);
      break;
    case 'status':
      break;
  }
});

show(h('div', { class: 'loading' }, 'Loading…'));
vscode.postMessage({ type: 'ready' });
