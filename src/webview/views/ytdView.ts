import type { TextureData } from '../../shared/model';
import { openLightbox, textureCanvas, textureDescription } from '../textureCanvas';
import { pendingPreview } from '../textureEditor';
import { addTextures, deleteTextures } from '../ytdManage';
import { h } from '../ui';

/**
 * Grid of every texture in a .ytd, with a filter box, a full-size viewer
 * (replace / rename / delete / export), and adding or deleting textures.
 */
export function ytdView(file: string, textures: TextureData[]): HTMLElement {
  const grid = h('div', { class: 'ytd-grid' });
  const count = h('span', { class: 'muted' });
  const status = h('span', { class: 'muted edit-status' });
  const origin = textures.find((t) => t.origin)?.origin;
  /** Textures ticked for deletion; undefined when not selecting. */
  let selecting: Set<TextureData> | undefined;

  const renderCard = (t: TextureData, card: HTMLElement) => {
    const preview = pendingPreview(t);
    card.classList.toggle('selected', !!selecting?.has(t));
    card.replaceChildren(
      ...(selecting ? [h('input', { type: 'checkbox', class: 'card-check', checked: selecting.has(t), tabIndex: -1 })] : []),
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
      card.onclick = () => {
        if (selecting) {
          if (selecting.has(t)) selecting.delete(t);
          else selecting.add(t);
          renderCard(t, card);
          updateSelection();
        } else openLightbox(t, undefined, { original: t, setPreview: () => renderCard(t, card) });
      };
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

  // -- add / delete ------------------------------------------------------------
  const add = h('button', { class: 'chip', title: 'Add images (PNG, JPG, WebP, BMP, DDS) as new textures' }, 'Add Textures…');
  const del = h('button', { class: 'chip', title: 'Select textures to delete' }, 'Delete Textures…');
  const deleteBar = h('div', { class: 'toolbar select-bar', hidden: true });
  const confirmDelete = h('button', { class: 'chip active' }, 'Delete selected');
  const cancel = h('button', { class: 'chip' }, 'Cancel');
  const selectionInfo = h('span');
  deleteBar.append(selectionInfo, h('span', { class: 'spacer' }), h('button', { class: 'chip', onclick: () => setAll(true) }, 'Select all shown'), h('button', { class: 'chip', onclick: () => setAll(false) }, 'Select none'), cancel, confirmDelete);
  if (!origin) for (const b of [add, del]) ((b.disabled = true), (b.title = "This dictionary's file is unknown."));

  const updateSelection = () => {
    const n = selecting?.size ?? 0;
    selectionInfo.textContent = n ? `${n} texture${n === 1 ? '' : 's'} selected` : 'Click textures to select them for deletion.';
    confirmDelete.disabled = !n;
  };
  const setSelecting = (on: boolean) => {
    selecting = on ? new Set() : undefined;
    deleteBar.hidden = !on;
    del.classList.toggle('active', on);
    cards.forEach(({ t, card }) => renderCard(t, card));
    updateSelection();
  };
  const setAll = (on: boolean) => {
    if (!selecting) return;
    const q = filter.value.trim().toLowerCase();
    for (const { t } of cards) if (!q || t.name.toLowerCase().includes(q)) on ? selecting.add(t) : selecting.delete(t);
    if (!on) selecting.clear();
    cards.forEach(({ t, card }) => renderCard(t, card));
    updateSelection();
  };
  del.onclick = () => setSelecting(!selecting);
  cancel.onclick = () => setSelecting(false);
  confirmDelete.onclick = async () => {
    if (!selecting?.size || !origin) return;
    confirmDelete.disabled = true;
    const reply = await deleteTextures(origin, [...selecting].map((t) => t.name));
    confirmDelete.disabled = false;
    if (reply.ok) {
      status.textContent = 'Deleted; reloading…';
      setSelecting(false);
    } else if (reply.error) status.textContent = `Couldn't delete: ${reply.error}`;
  };
  add.onclick = () => origin && void addTextures(origin, textures.map((t) => t.name), (s) => (status.textContent = s));

  apply();
  return h(
    'div',
    { class: 'ytd-view' },
    h('div', { class: 'toolbar' }, h('strong', null, file), count, add, del, status, h('span', { class: 'spacer' }), filter),
    deleteBar,
    grid
  );
}
