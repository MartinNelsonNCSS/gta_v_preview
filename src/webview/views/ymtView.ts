import type { PedDrawable, PedSlot, TextureData, YmtData } from '../../shared/model';
import { openLightbox, textureCanvas, textureDescription } from '../textureCanvas';
import { h, hostRequest, newRequestId, vscode } from '../ui';
import { jsonTree } from './jsonTree';
import { ModelPanel } from './modelPanel';

/** Variation thumbnails and models are decoded smaller than standalone previews. */
const VARIATION_TEXTURE_SIZE = 512;

/** Preview for .ymt files: a clothing/prop browser for ped variation files, a raw tree otherwise. */
export function ymtView(file: string, ymt: YmtData, files: string[]): HTMLElement {
  const ped = ymt.pedVariation;
  const tabs: { label: string; render: () => HTMLElement }[] = [];
  if (ped) {
    const available = new Set(files);
    const prefix = file.replace(/\.ymt$/i, '').toLowerCase();
    const count = (slots: PedSlot[]) => slots.reduce((n, s) => n + s.drawables.length, 0);
    if (ped.components.length) {
      let browser: SlotBrowser | undefined;
      tabs.push({ label: `Clothing (${count(ped.components)})`, render: () => (browser ??= new SlotBrowser(ped.components, prefix, available)).el });
    }
    if (ped.props.length) {
      let browser: SlotBrowser | undefined;
      tabs.push({ label: `Props (${count(ped.props)})`, render: () => (browser ??= new SlotBrowser(ped.props, prefix, available)).el });
    }
  }
  let raw: HTMLElement | undefined;
  tabs.push({ label: 'Raw', render: () => (raw ??= h('div', { class: 'raw-view' }, jsonTree(ymt.raw, ymt.rootType, true))) });

  const body = h('div', { class: 'tab-body' });
  const buttons = tabs.map((t, i) => h('button', { class: 'tab', onclick: () => activate(i) }, t.label));
  const activate = (i: number) => {
    buttons.forEach((b, j) => b.classList.toggle('active', i === j));
    const el = tabs[i].render();
    if (!el.parentElement) body.append(el);
    [...body.children].forEach((c) => ((c as HTMLElement).hidden = c !== el));
  };
  const summary = ped
    ? [ped.dlcName && `DLC ${ped.dlcName}`, ped.hasLowLods && 'has low LODs', ped.selectionSets && `${ped.selectionSets} selection sets`].filter(Boolean).join(' · ')
    : ymt.rootType;
  const root = h(
    'div',
    { class: 'ytyp-view' },
    h('div', { class: 'toolbar' }, h('strong', null, file), h('span', { class: 'muted' }, summary || (ped ? 'Ped variation' : ''))),
    h('div', { class: 'tabs' }, buttons),
    body
  );
  activate(0);
  return root;
}

/**
 * Browses ped components or props: pick a drawable to see its model (if the
 * .ydd isn't encrypted) and each texture variation from its .ytd files.
 */
class SlotBrowser {
  readonly el: HTMLElement;
  // Variation textures come from the .ymt's own .ytd files, so no workspace-wide texture search.
  private readonly panel = new ModelPanel({ sidebar: false, searchTextures: false });
  private readonly strip = h('div', { class: 'variation-strip' });
  private readonly title = h('div', { class: 'variation-title' });
  private selectedRow?: HTMLElement;
  private token = 0;

  constructor(private readonly slots: PedSlot[], private readonly prefix: string, private readonly files: Set<string>) {
    const list = h(
      'div',
      { class: 'slot-list' },
      slots.map((slot) =>
        h(
          'details',
          { class: 'room', open: true },
          h('summary', null, `${slot.label} `, h('span', { class: 'muted' }, `${slot.key} · ${slot.drawables.length}`)),
          slot.drawables.map((d) => this.row(slot, d))
        )
      )
    );
    this.el = h(
      'div',
      { class: 'slot-browser' },
      list,
      h('div', { class: 'slot-preview' }, this.panel.el, h('div', { class: 'variation-panel' }, this.title, this.strip))
    );
    const first = slots[0]?.drawables[0];
    if (first) queueMicrotask(() => this.select(slots[0], first, list.querySelector('.entity-row') as HTMLElement));
  }

  /** The streamed (`<ped>^name`) or plain file base for `name`, if it exists nearby. */
  private resolve(name: string, exts: string[]): string | undefined {
    for (const base of [`${this.prefix}^${name}`, name]) {
      for (const ext of exts) if (this.files.has(`${base}.${ext}`.toLowerCase())) return base.toLowerCase();
    }
    return undefined;
  }

  private row(slot: PedSlot, d: PedDrawable): HTMLElement {
    const model = this.resolve(d.file, ['ydd', 'ydr', 'yft']);
    const found = d.textures.filter((t) => this.resolve(t.file, ['ytd'])).length;
    const row = h(
      'div',
      {
        class: 'entity-row slot-row',
        onclick: () => this.select(slot, d, row),
        title: `${d.file} — model ${model ? 'found' : 'missing'}, ${found}/${d.textures.length} textures found`,
      },
      h('span', { class: `dot ${model ? 'ok' : 'missing'}` }),
      `${String(d.index).padStart(3, '0')}`,
      h('span', { class: 'muted' }, ` · ${d.textures.length} tex${d.cloth ? ' · cloth' : ''}`)
    );
    return row;
  }

  private select(slot: PedSlot, d: PedDrawable, row: HTMLElement): void {
    this.selectedRow?.classList.remove('selected');
    row.classList.add('selected');
    this.selectedRow = row;
    const token = ++this.token;
    this.title.replaceChildren(h('strong', null, `${slot.label} ${String(d.index).padStart(3, '0')}`), h('span', { class: 'muted' }, ` · ${d.file}`));
    void this.loadModel(d, token);
    void this.loadVariations(d, token);
  }

  private async loadModel(d: PedDrawable, token: number): Promise<void> {
    this.panel.setVariationTexture(undefined);
    const base = this.resolve(d.file, ['ydd', 'ydr', 'yft']);
    if (!base) {
      this.panel.setDrawables([]);
      this.panel.setStatus(`No model file for ${d.file} next to this .ymt — showing textures only.`);
      return;
    }
    this.panel.setStatus('Loading model…');
    const reply = await hostRequest({ type: 'loadDrawableFile', requestId: newRequestId(), name: base, maxTextureSize: VARIATION_TEXTURE_SIZE }, 'drawableFile');
    if (token !== this.token) return;
    if (reply.error || !reply.drawables.length) {
      this.panel.setDrawables([]);
      this.panel.setStatus(reply.error ?? 'The model file is empty.');
      return;
    }
    this.panel.setStatus('');
    this.panel.setDrawables(reply.drawables);
    if (this.activeTexture) this.panel.setVariationTexture(this.activeTexture);
  }

  private activeTexture?: TextureData;

  private async loadVariations(d: PedDrawable, token: number): Promise<void> {
    this.activeTexture = undefined;
    const cards = d.textures.map((t) => {
      const holder = h('div', { class: 'checker thumb-image' }, h('span', { class: 'muted small' }, '…'));
      const card = h('div', { class: 'thumb variation', title: t.file }, holder, h('div', { class: 'thumb-name' }, t.letter.toUpperCase()));
      return { t, card, holder };
    });
    this.strip.replaceChildren(...(cards.length ? cards.map((c) => c.card) : [h('div', { class: 'muted' }, 'No texture variations.')]));

    for (const c of cards) {
      const base = this.resolve(c.t.file, ['ytd']);
      if (!base) {
        c.holder.replaceChildren(h('span', { class: 'muted small' }, 'missing'));
        c.card.title = `${c.t.file}.ytd not found`;
        continue;
      }
      const reply = await hostRequest({ type: 'loadTextureFile', requestId: newRequestId(), name: base, maxSize: VARIATION_TEXTURE_SIZE }, 'textureFile');
      if (token !== this.token) return;
      // A variation .ytd normally holds just the diffuse; skip normal/spec maps if present.
      const tex = reply.textures.find((x) => !/_(n|s|nm|spec|normal)$/i.test(x.name)) ?? reply.textures[0];
      if (!tex) {
        c.holder.replaceChildren(h('span', { class: 'muted small' }, reply.error ? 'unreadable' : 'empty'));
        c.card.title = reply.error ?? `${base}.ytd is empty`;
        continue;
      }
      c.holder.replaceChildren(textureCanvas(tex, 96));
      c.card.title = `${base}.ytd\n${tex.name} · ${textureDescription(tex)}\nClick to apply · double-click to enlarge`;
      c.card.onclick = () => this.applyVariation(tex, c.card);
      c.card.ondblclick = () => openLightbox(tex, `${base}.ytd`);
      if (!this.activeTexture) this.applyVariation(tex, c.card);
    }
  }

  private applyVariation(tex: TextureData, card: HTMLElement): void {
    this.activeTexture = tex;
    this.strip.querySelectorAll('.variation').forEach((el) => el.classList.toggle('active', el === card));
    this.panel.setVariationTexture(tex);
  }
}

/** Shown for XML files that would otherwise open in a binary preview. */
export function textView(file: string, text: string, note: string): HTMLElement {
  return h(
    'div',
    { class: 'ytd-view' },
    h(
      'div',
      { class: 'toolbar' },
      h('strong', null, file),
      h('span', { class: 'muted' }, note),
      h('span', { class: 'spacer' }),
      h('button', { class: 'chip active', onclick: () => vscode.postMessage({ type: 'openAsText' }) }, 'Open as text')
    ),
    h('pre', { class: 'text-view' }, text)
  );
}
