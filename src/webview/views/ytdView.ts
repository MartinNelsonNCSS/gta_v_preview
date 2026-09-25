import type { TextureData } from '../../shared/model';
import { openLightbox, textureCanvas, textureDescription } from '../textureCanvas';
import { pendingPreview } from '../textureEditor';
import { h } from '../ui';

/** Grid of every texture in a .ytd, with a filter box and a full-size viewer (replace / export). */
export function ytdView(file: string, textures: TextureData[]): HTMLElement {
  const grid = h('div', { class: 'ytd-grid' });
  const count = h('span', { class: 'muted' });

  const renderCard = (t: TextureData, card: HTMLElement) => {
    const preview = pendingPreview(t);
    card.replaceChildren(
      ...(preview ? [h('span', { class: 'badge' }, 'preview')] : []),
      h('div', { class: 'checker ytd-image' }, textureCanvas(preview ?? t, 192)),
      h('div', { class: 'ytd-name' }, t.name),
      h('div', { class: 'muted small' }, textureDescription(t))
    );
  };
  const cards = textures
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => {
      const card = h('div', { class: 'ytd-card', title: 'Click to view, replace or export' });
      card.onclick = () => openLightbox(t, undefined, { original: t, setPreview: () => renderCard(t, card) });
      renderCard(t, card);
      return { t, card };
    });
  const filter = h('input', {
    type: 'search',
    placeholder: 'Filter textures…',
    oninput: () => apply(),
  });
  const apply = () => {
    const q = filter.value.trim().toLowerCase();
    const shown = cards.filter(({ t }) => !q || t.name.toLowerCase().includes(q));
    grid.replaceChildren(...shown.map((c) => c.card));
    count.textContent = `${shown.length} of ${textures.length} textures`;
  };
  apply();
  return h(
    'div',
    { class: 'ytd-view' },
    h('div', { class: 'toolbar' }, h('strong', null, file), count, h('span', { class: 'spacer' }), filter),
    grid
  );
}
