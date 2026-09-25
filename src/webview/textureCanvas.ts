import type { TextureData } from '../shared/model';
import { decodeBc7 } from './bc7';
import { h } from './ui';
import { editActions, EditTarget, pendingPreview } from './textureEditor';

const rgbaCache = new WeakMap<TextureData, Uint8Array | null>();

function rgbaOf(t: TextureData): Uint8Array | null {
  if (!t.pixels) return null;
  if (t.pixels.encoding === 'rgba') return t.pixels.data;
  if (!rgbaCache.has(t)) rgbaCache.set(t, decodeBc7(t.pixels.data, t.pixels.width, t.pixels.height));
  return rgbaCache.get(t)!;
}

export type ChannelMode = 'rgba' | 'rgb' | 'alpha';

/** Draws a texture into a canvas, optionally scaled down to fit `maxDim`. */
export function textureCanvas(t: TextureData, maxDim = Infinity, mode: ChannelMode = 'rgba'): HTMLCanvasElement {
  const canvas = h('canvas', { class: 'tex-canvas' });
  const px = t.pixels;
  const rgba = rgbaOf(t);
  if (!px || !rgba) {
    canvas.width = canvas.height = 1;
    canvas.classList.add('tex-missing');
    return canvas;
  }
  let data = rgba;
  if (mode !== 'rgba') {
    data = new Uint8Array(rgba.length);
    for (let i = 0; i < rgba.length; i += 4) {
      if (mode === 'alpha') {
        data[i] = data[i + 1] = data[i + 2] = rgba[i + 3];
      } else {
        data[i] = rgba[i];
        data[i + 1] = rgba[i + 1];
        data[i + 2] = rgba[i + 2];
      }
      data[i + 3] = 255;
    }
  }
  const full = document.createElement('canvas');
  full.width = px.width;
  full.height = px.height;
  full.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), px.width, px.height), 0, 0);
  const scale = Math.min(1, maxDim / Math.max(px.width, px.height));
  if (scale >= 1) return Object.assign(full, { className: 'tex-canvas' });
  canvas.width = Math.max(1, Math.round(px.width * scale));
  canvas.height = Math.max(1, Math.round(px.height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(full, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function textureDescription(t: TextureData): string {
  const shown = t.pixels && (t.pixels.width !== t.width || t.pixels.height !== t.height) ? ` (showing ${t.pixels.width}×${t.pixels.height})` : '';
  return `${t.width}×${t.height} · ${t.format} · ${t.levels} mip${t.levels === 1 ? '' : 's'}${shown}`;
}

/** Full-size texture viewer overlay with channel toggles and (optionally) edit/export actions. */
export function openLightbox(t: TextureData, source?: string, edit?: EditTarget): void {
  let mode: ChannelMode = 'rgba';
  let shown = (edit && pendingPreview(edit.original)) || t;
  const holder = h('div', { class: 'lightbox-image checker' });
  const info = h('div');
  const render = () => {
    const canvas = textureCanvas(shown, Infinity, mode);
    // Upscale small textures (pixelated) so they're inspectable; downscale big ones to fit.
    const scale = Math.min(innerWidth * 0.9 / canvas.width, (innerHeight * 0.95 - 110) / canvas.height, Math.max(1, 512 / Math.max(canvas.width, canvas.height)));
    canvas.style.width = `${Math.round(canvas.width * scale)}px`;
    canvas.style.height = `${Math.round(canvas.height * scale)}px`;
    holder.replaceChildren(canvas);
    const previewing = shown !== t;
    info.replaceChildren(
      h('strong', null, t.name),
      ...(previewing ? [h('span', { class: 'badge' }, 'preview')] : []),
      h('div', { class: 'muted' }, textureDescription(t), source ? ` · ${source}` : '')
    );
    buttons.forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  };
  const buttons = (['rgba', 'rgb', 'alpha'] as ChannelMode[]).map((m) =>
    h('button', { class: 'chip', 'data-mode': m, onclick: () => ((mode = m), render()) }, m.toUpperCase())
  );
  const close = () => {
    overlay.remove();
    window.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  const actions = edit ? editActions(edit, (next) => ((shown = next), render())) : null;
  const overlay = h(
    'div',
    { class: 'lightbox', onclick: (e: Event) => e.target === overlay && close() },
    h(
      'div',
      { class: 'lightbox-panel' },
      h('div', { class: 'lightbox-header' }, info, h('div', { class: 'row' }, ...buttons, h('button', { class: 'chip', onclick: close, title: 'Close (Esc)' }, '✕'))),
      actions,
      holder
    )
  );
  window.addEventListener('keydown', onKey);
  document.body.append(overlay);
  render();
}
