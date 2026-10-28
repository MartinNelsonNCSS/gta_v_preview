import {
  AUDIO_IDS,
  ClothPack,
  COMPONENT_SLOTS,
  DRAWABLE_FLAGS,
  newId,
  RENDER_FLAGS,
  DrawableKind,
  Gender,
  MAX_DRAWABLES_PER_SLOT,
  MAX_TEXTURES,
  PackDrawable,
  packNameProblem,
  PROP_SLOTS,
  slotLabel,
  slotLimit,
} from '../../formats/clothPack';
import type { PackIssue, TextureData } from '../../shared/model';
import { openLightbox, textureCanvas, textureDescription } from '../textureCanvas';
import { h, hostRequest, newRequestId, pref, setPref, vscode } from '../ui';
import { ModelPanel } from './modelPanel';
import { duplicateInspector, resolveImport } from '../packDialogs';
import { OutfitItem, OutfitPreview } from '../outfitPreview';
import { buildDds } from '../../formats/dds';
import { canvasToRgba, decodeImage } from '../imageUtils';

const PREVIEW_TEXTURE_SIZE = 512;
const GENDERS: Gender[] = ['male', 'female'];
const SEVERITY_ORDER: PackIssue['severity'][] = ['error', 'warning', 'info'];

const pad3 = (n: number) => String(n).padStart(3, '0');
const fileName = (p: string) => p.split('/').pop() ?? p;
/** A model's short label: the part after the collection prefix (`…^jbib_001_u`), without extension. */
const shortName = (p: string) => fileName(p).replace(/^.*\^/, '').replace(/\.ydd$/i, '');
const groupKey = (d: PackDrawable) => `${d.gender}/${d.kind}/${d.slot}`;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * Clothing pack editor: drawables grouped by gender and slot (drag to reorder,
 * multi-select for bulk changes), a 3D preview with texture variations, a
 * property panel, and checks / build / texture optimisation.
 */
export class PackView {
  readonly el: HTMLElement;
  private pack: ClothPack = { version: 1, name: '', drawables: [] };
  private exists: Record<string, boolean> = {};
  private file = '';
  private selected = new Set<string>();
  private focus?: string;
  private anchor?: string;
  private issues: PackIssue[] = [];
  private checked = false;
  private readonly toolbar = h('div', { class: 'toolbar' });
  private readonly list = h('div', { class: 'slot-list pack-list' });
  private readonly listBody = h('div');
  private filter = '';
  private groupBy: 'slot' | 'group' = pref('packGroupBy', 'slot');
  private readonly details = h('div', { class: 'sidebar pack-details' });
  private readonly panel = new ModelPanel({ sidebar: false, searchTextures: false });
  private readonly outfit = new OutfitPreview();
  private readonly single = h('div', { class: 'pack-single' });
  private readonly strip = h('div', { class: 'variation-strip' });
  private readonly title = h('div', { class: 'variation-title' });
  private readonly status = h('span', { class: 'muted edit-status' });
  private shownModel?: string;
  /** Embedded textures of the last previewed model. */
  private embeddedInfo?: { id: string; textures: TextureData[] };
  private token = 0;
  private dragging?: string;

  constructor() {
    const search = h('input', { type: 'search', placeholder: 'Filter by name, tag or group…', class: 'pack-filter' });
    search.oninput = () => {
      this.filter = search.value.trim().toLowerCase();
      this.renderList();
    };
    const groupBy = h(
      'select',
      { title: 'Group the list by slot or by your own groups' },
      h('option', { value: 'slot', selected: this.groupBy === 'slot' }, 'By slot'),
      h('option', { value: 'group', selected: this.groupBy === 'group' }, 'By group')
    );
    groupBy.onchange = () => {
      this.groupBy = groupBy.value as 'slot' | 'group';
      setPref('packGroupBy', this.groupBy);
      this.renderList();
    };
    this.list.append(h('div', { class: 'pack-list-head' }, search, groupBy), this.listBody);
    this.single.append(this.panel.el, h('div', { class: 'variation-panel' }, this.title, this.strip));
    this.outfit.el.hidden = true;
    this.el = h(
      'div',
      { class: 'ytyp-view pack-view' },
      this.toolbar,
      h(
        'div',
        { class: 'slot-browser pack-body' },
        this.list,
        h('div', { class: 'slot-preview' }, this.single, this.outfit.el),
        this.details
      )
    );
    this.el.tabIndex = 0;
    this.el.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
      if (e.key === 'Escape' && (this.selected.size || this.focus)) {
        this.selected.clear();
        this.focus = undefined;
        this.render();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected.size) {
        e.preventDefault();
        this.removeSelected();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        e.preventDefault();
        this.selected = new Set(this.pack.drawables.map((d) => d.id));
        this.render();
      }
    });
  }

  update(file: string, pack: ClothPack, exists: Record<string, boolean>): void {
    this.file = file;
    this.pack = pack;
    this.exists = exists;
    const ids = new Set(pack.drawables.map((d) => d.id));
    this.selected = new Set([...this.selected].filter((id) => ids.has(id)));
    if (this.focus && !ids.has(this.focus)) this.focus = undefined;
    this.render();
  }

  // -- editing -------------------------------------------------------------------

  /** Applies a change to a copy of the pack and sends it to the host (which updates the document). */
  private commit(change: (pack: ClothPack) => void): void {
    const next = clone(this.pack);
    change(next);
    this.pack = next;
    vscode.postMessage({ type: 'packEdit', pack: next });
    this.render();
  }

  private edit(ids: Iterable<string>, change: (d: PackDrawable) => void): void {
    const set = new Set(ids);
    this.commit((p) => p.drawables.filter((d) => set.has(d.id)).forEach(change));
  }

  private removeSelected(): void {
    const n = this.selected.size;
    if (!n) return;
    const ids = new Set(this.selected);
    this.selected.clear();
    this.commit((p) => (p.drawables = p.drawables.filter((d) => !ids.has(d.id))));
    this.say(`Removed ${n} drawable${n === 1 ? '' : 's'} (Undo with Ctrl/Cmd+Z).`);
  }

  /** Moves drawable `id` before `before` (or to the end of its group). */
  private move(id: string, before?: string): void {
    this.commit((p) => {
      const from = p.drawables.findIndex((d) => d.id === id);
      if (from < 0) return;
      const [d] = p.drawables.splice(from, 1);
      let to = before ? p.drawables.findIndex((x) => x.id === before) : -1;
      if (to < 0) {
        // End of its group: after the group's last member.
        const last = p.drawables.map((x) => groupKey(x)).lastIndexOf(groupKey(d));
        to = last + 1;
      }
      p.drawables.splice(to, 0, d);
    });
  }

  private step(id: string, delta: number): void {
    const d = this.pack.drawables.find((x) => x.id === id);
    if (!d) return;
    const group = this.pack.drawables.filter((x) => groupKey(x) === groupKey(d));
    const i = group.indexOf(d);
    const target = group[i + delta];
    if (!target) return;
    if (delta < 0) this.move(id, target.id);
    else this.move(id, group[i + 2]?.id);
  }

  private say(text: string): void {
    this.status.textContent = text;
  }

  // -- rendering -----------------------------------------------------------------

  private render(): void {
    this.renderToolbar();
    this.renderList();
    this.renderDetails();
    const focus = this.pack.drawables.find((d) => d.id === this.focus);
    const outfit = this.outfitItems(focus);
    const key = outfit
      ? JSON.stringify(['outfit', outfit.map((d) => [d.id, d.model, d.textures[0], d.highHeels, d.hairScale, d.kind, d.slot]), this.pack.body])
      : focus
        ? JSON.stringify([focus.model, focus.textures])
        : undefined;
    if (key !== this.shownModel) {
      this.shownModel = key;
      this.single.hidden = !!outfit;
      this.outfit.el.hidden = !outfit;
      if (outfit && focus) void this.showOutfit(outfit, focus.gender);
      else void this.showPreview(focus);
    }
  }

  private renderToolbar(): void {
    const name = h('input', { type: 'text', value: this.pack.name, class: 'pack-name', title: 'Collection name: used in every file name (lower-case, digits, _)', spellcheck: false });
    name.onchange = () => {
      const v = name.value.trim();
      const problem = packNameProblem(v);
      if (problem) {
        this.say(`Name: ${problem}`);
        name.value = this.pack.name;
      } else this.commit((p) => (p.name = v));
    };
    const add = (gender: Gender) =>
      h('button', { class: 'chip', title: `Add ${gender} models (.ydd); slot, gender and textures are detected from file names`, onclick: () => void this.addDrawables(gender) }, `+ ${gender === 'male' ? 'Male' : 'Female'}`);
    const counts = GENDERS.map((g) => `${this.pack.drawables.filter((d) => d.gender === g).length} ${g}`).join(' · ');
    this.toolbar.replaceChildren(
      h('strong', null, this.file),
      h('label', { class: 'toggle' }, 'Name', name),
      h('span', { class: 'muted' }, counts),
      h('span', { class: 'sep' }),
      add('male'),
      add('female'),
      h('button', { class: 'chip', title: 'Check models and textures for problems', onclick: () => void this.runChecks() }, 'Check'),
      h('button', { class: 'chip', title: 'Find identical models and shared texture files', onclick: () => void this.findDuplicates() }, 'Duplicates…'),
      h('button', { class: 'chip', title: 'Optimise the pack’s textures (size, mipmaps, compression)', onclick: () => vscode.postMessage({ type: 'packOptimize' }) }, 'Optimise textures…'),
      h('button', { class: 'chip active', title: 'Build the FiveM resource', onclick: () => void this.build() }, 'Build'),
      this.status
    );
  }

  private issuesFor(id?: string): PackIssue[] {
    return this.issues.filter((i) => i.id === id);
  }

  private worst(id: string): PackIssue['severity'] | undefined {
    const own = this.issuesFor(id);
    return SEVERITY_ORDER.find((s) => own.some((i) => i.severity === s));
  }

  private missingFiles(d: PackDrawable): string[] {
    if (d.reserved) return [];
    return [d.model, ...d.textures, ...(d.cloth ? [d.cloth] : []), ...(d.firstPerson ? [d.firstPerson] : [])].filter((p) => this.exists[p] === false);
  }

  private matches(d: PackDrawable): boolean {
    if (!this.filter) return true;
    const text = [d.name, d.model, d.group, ...(d.tags ?? []), d.slot, slotLabel(d.kind, d.slot)].filter(Boolean).join(' ').toLowerCase();
    return this.filter.split(/\s+/).every((w) => text.includes(w));
  }

  private renderList(): void {
    const scroll = this.list.scrollTop;
    const order = this.pack.drawables;
    const limit = slotLimit(this.pack);
    // Numbers are positions within the whole slot, even when the list is filtered.
    const number = new Map<string, number>();
    const counters = new Map<string, number>();
    for (const d of order) {
      const n = counters.get(groupKey(d)) ?? 0;
      counters.set(groupKey(d), n + 1);
      number.set(d.id, n);
    }
    const sections = GENDERS.map((gender) => {
      const all = order.filter((d) => d.gender === gender);
      const own = all.filter((d) => this.matches(d));
      const groups =
        this.groupBy === 'group'
          ? [...new Set(own.map((d) => d.group ?? ''))]
              .sort((a, b) => (a ? (b ? a.localeCompare(b) : -1) : 1))
              .map((g) => ({ title: g || 'No group', sub: '', items: own.filter((d) => (d.group ?? '') === g), over: false }))
          : (['component', 'prop'] as DrawableKind[]).flatMap((kind) =>
              (kind === 'prop' ? PROP_SLOTS : COMPONENT_SLOTS)
                .map((s) => {
                  const items = own.filter((d) => d.kind === kind && d.slot === s.key);
                  const total = all.filter((d) => d.kind === kind && d.slot === s.key).length;
                  return { title: s.label, sub: s.key, items, over: total > limit };
                })
                .filter((g) => g.items.length)
            );
      return h(
        'details',
        { class: 'room', open: true },
        h('summary', null, h('strong', null, gender === 'male' ? 'Male' : 'Female'), h('span', { class: 'muted' }, ` · ${all.length}${own.length !== all.length ? ` (${own.length} shown)` : ''}`)),
        groups.length
          ? groups.map((g) =>
              h(
                'div',
                { class: 'pack-group' },
                h(
                  'div',
                  { class: 'pack-group-title' },
                  `${g.title} `,
                  h('span', { class: 'muted' }, `${g.sub ? `${g.sub} · ` : ''}${g.items.length}`),
                  g.over ? h('span', { class: 'warn small' }, ` (split: over ${limit})`) : null
                ),
                g.items.map((d) => this.row(d, number.get(d.id) ?? 0))
              )
            )
          : h('div', { class: 'muted small pack-empty' }, all.length ? 'Nothing matches the filter.' : `No ${gender} drawables yet.`)
      );
    });
    this.listBody.replaceChildren(...sections);
    this.list.scrollTop = scroll;
  }

  private row(d: PackDrawable, index: number): HTMLElement {
    const missing = this.missingFiles(d).length;
    const worst = missing ? 'error' : this.worst(d.id);
    const box = h('input', {
      type: 'checkbox',
      checked: this.selected.has(d.id),
      onclick: (e: Event) => {
        e.stopPropagation();
        if (this.selected.has(d.id)) this.selected.delete(d.id);
        else this.selected.add(d.id);
        this.anchor = d.id;
        this.render();
      },
    });
    const row = h(
      'div',
      {
        class: `entity-row slot-row pack-row${this.selected.has(d.id) ? ' selected' : ''}${this.focus === d.id ? ' focused' : ''}`,
        draggable: true,
        title: `${d.model}\n${d.textures.length} texture${d.textures.length === 1 ? '' : 's'}${missing ? `\n${missing} file(s) missing` : ''}\nDrag to reorder · Ctrl/Cmd-click or Shift-click to select several`,
      },
      box,
      h('span', { class: `dot ${worst === 'error' ? 'missing' : worst === 'warning' ? 'warn-dot' : 'ok'}` }),
      h('span', { class: 'pack-index' }, this.groupBy === 'group' ? `${d.slot} ${pad3(index)}` : pad3(index)),
      h('span', { class: 'pack-label' }, d.name || (d.reserved ? 'reserved' : shortName(d.model))),
      ...(d.tags ?? []).slice(0, 3).map((t) => h('span', { class: 'pack-tag' }, t)),
      (d.tags?.length ?? 0) > 3 ? h('span', { class: 'muted small' }, `+${d.tags!.length - 3}`) : null,
      h(
        'span',
        { class: 'muted small' },
        d.reserved
          ? 'placeholder'
          : `${d.textures.length} tex${d.hasSkin ? ' · skin' : ''}${d.cloth ? ' · cloth' : ''}${d.highHeels ? ' · heels' : ''}${d.hairScale ? ' · hair scale' : ''}${d.firstPerson ? ' · 1st person' : ''}`
      )
    );
    row.onclick = (e) => this.click(d, e);
    row.ondragstart = (e) => {
      this.dragging = d.id;
      e.dataTransfer?.setData('text/plain', d.id);
      row.classList.add('dragging');
    };
    row.ondragend = () => {
      this.dragging = undefined;
      row.classList.remove('dragging');
    };
    row.ondragover = (e) => {
      const dragged = this.pack.drawables.find((x) => x.id === this.dragging);
      if (dragged && groupKey(dragged) === groupKey(d)) {
        e.preventDefault();
        row.classList.add('drop-target');
      }
    };
    row.ondragleave = () => row.classList.remove('drop-target');
    row.ondrop = (e) => {
      e.preventDefault();
      row.classList.remove('drop-target');
      if (this.dragging && this.dragging !== d.id) this.move(this.dragging, d.id);
    };
    return row;
  }

  private click(d: PackDrawable, e: MouseEvent): void {
    if (e.shiftKey && this.anchor) {
      const flat = this.visibleOrder();
      const [a, b] = [flat.indexOf(this.anchor), flat.indexOf(d.id)].sort((x, y) => x - y);
      if (a >= 0 && b >= 0) flat.slice(a, b + 1).forEach((id) => this.selected.add(id));
    } else if (e.metaKey || e.ctrlKey) {
      if (this.selected.has(d.id)) this.selected.delete(d.id);
      else this.selected.add(d.id);
      this.anchor = d.id;
    } else {
      this.selected = new Set([d.id]);
      this.anchor = d.id;
    }
    this.focus = d.id;
    this.render();
  }

  /** Drawable ids in the order the list shows them. */
  private visibleOrder(): string[] {
    return GENDERS.flatMap((g) =>
      (['component', 'prop'] as DrawableKind[]).flatMap((kind) =>
        (kind === 'prop' ? PROP_SLOTS : COMPONENT_SLOTS).flatMap((s) => this.pack.drawables.filter((d) => d.gender === g && d.kind === kind && d.slot === s.key && this.matches(d)).map((d) => d.id))
      )
    );
  }

  // -- details -------------------------------------------------------------------

  private slotSelect(value: string | undefined, onChange: (kind: DrawableKind, slot: string) => void): HTMLSelectElement {
    const select = h(
      'select',
      { title: 'Slot' },
      ...(value === undefined ? [h('option', { value: '', selected: true }, '—')] : []),
      h('optgroup', { label: 'Clothing' }, COMPONENT_SLOTS.map((s) => h('option', { value: `component:${s.key}`, selected: value === `component:${s.key}` }, `${s.label} (${s.key})`))),
      h('optgroup', { label: 'Props' }, PROP_SLOTS.map((s) => h('option', { value: `prop:${s.key}`, selected: value === `prop:${s.key}` }, `${s.label} (${s.key})`)))
    );
    select.onchange = () => {
      const [kind, slot] = select.value.split(':') as [DrawableKind, string];
      if (slot) onChange(kind, slot);
    };
    return select;
  }

  private genderSelect(value: Gender | undefined, onChange: (g: Gender) => void): HTMLSelectElement {
    const select = h(
      'select',
      { title: 'Gender' },
      ...(value === undefined ? [h('option', { value: '', selected: true }, '—')] : []),
      ...GENDERS.map((g) => h('option', { value: g, selected: value === g }, g === 'male' ? 'Male' : 'Female'))
    );
    select.onchange = () => select.value && onChange(select.value as Gender);
    return select;
  }

  private field(label: string, ...content: (Node | string | null)[]): HTMLElement {
    return h('div', { class: 'pack-field' }, h('div', { class: 'k' }, label), h('div', { class: 'pack-field-value' }, ...content.filter((c): c is Node | string => c !== null)));
  }

  private issueList(issues: PackIssue[]): HTMLElement | null {
    if (!issues.length) return null;
    return h(
      'div',
      { class: 'pack-issues' },
      issues
        .slice()
        .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
        .map((i) => h('div', { class: `pack-issue ${i.severity}` }, `${i.severity === 'error' ? '✖' : i.severity === 'warning' ? '⚠' : 'ℹ'} ${i.message}`))
    );
  }

  private renderDetails(): void {
    const chosen = this.pack.drawables.filter((d) => this.selected.has(d.id));
    if (chosen.length > 1) return this.renderBulk(chosen);
    const d = chosen[0] ?? this.pack.drawables.find((x) => x.id === this.focus);
    if (!d) return this.renderSummary();

    const group = this.pack.drawables.filter((x) => groupKey(x) === groupKey(d));
    const index = group.indexOf(d);
    const name = h('input', { type: 'text', value: d.name ?? '', placeholder: shortName(d.model), spellcheck: false });
    name.onchange = () => this.edit([d.id], (x) => (x.name = name.value.trim() || undefined));
    const pathRow = (path: string, actions: Node[]) =>
      h('div', { class: 'pack-path' }, h('span', { class: this.exists[path] === false ? 'opt-bad' : '', title: path }, fileName(path).replace(/^.*\^/, '')), h('span', { class: 'spacer' }), ...actions);

    const textures = d.textures.map((t, i) =>
      h(
        'div',
        { class: 'pack-path' },
        h('span', { class: 'pack-letter' }, String.fromCharCode(97 + i)),
        h('span', { class: this.exists[t] === false ? 'opt-bad' : i >= MAX_TEXTURES ? 'warn' : '', title: t }, fileName(t).replace(/^.*\^/, '')),
        h('span', { class: 'spacer' }),
        h('button', { class: 'chip mini', title: 'Move up', disabled: i === 0, onclick: () => this.edit([d.id], (x) => x.textures.splice(i - 1, 0, ...x.textures.splice(i, 1))) }, '↑'),
        h('button', { class: 'chip mini', title: 'Move down', disabled: i === d.textures.length - 1, onclick: () => this.edit([d.id], (x) => x.textures.splice(i + 1, 0, ...x.textures.splice(i, 1))) }, '↓'),
        h('button', { class: 'chip mini', title: 'Remove from this drawable (the file is kept)', onclick: () => this.edit([d.id], (x) => x.textures.splice(i, 1)) }, '✕')
      )
    );

    this.setDetails(
      h('div', { class: 'pack-details-title' }, h('strong', null, `${slotLabel(d.kind, d.slot)} ${pad3(index)}`), h('span', { class: 'muted' }, ` · ${d.gender}`)),
      this.field('Name', name),
      this.groupField([d.id], d.group),
      this.tagsField(d),
      this.field('Gender', this.genderSelect(d.gender, (g) => this.edit([d.id], (x) => (x.gender = g)))),
      this.field(
        'Slot',
        this.slotSelect(`${d.kind}:${d.slot}`, (kind, slot) =>
          this.edit([d.id], (x) => {
            x.kind = kind;
            x.slot = slot;
            if (kind === 'prop') delete x.hasSkin;
          })
        )
      ),
      this.field(
        'Order',
        h('button', { class: 'chip', disabled: index === 0, onclick: () => this.step(d.id, -1) }, 'Move up'),
        h('button', { class: 'chip', disabled: index === group.length - 1, onclick: () => this.step(d.id, 1) }, 'Move down')
      ),
      d.kind === 'component'
        ? h(
            'label',
            { class: 'toggle block', title: 'The model shows skin: files are named _r / _whi and use the skin texture slot' },
            h('input', { type: 'checkbox', checked: !!d.hasSkin, onchange: (e: Event) => this.edit([d.id], (x) => (x.hasSkin = (e.target as HTMLInputElement).checked || undefined)) }),
            'Has skin'
          )
        : null,
      d.kind === 'component' && d.slot === 'hair'
        ? h(
            'label',
            { class: 'toggle block', title: 'Switch to the hair’s alternate model when wearing base-game masks (pedalternativevariations)' },
            h('input', { type: 'checkbox', checked: d.maskAlternate !== false, onchange: (e: Event) => this.edit([d.id], (x) => (x.maskAlternate = (e.target as HTMLInputElement).checked ? undefined : false)) }),
            'Hair alternate under masks'
          )
        : null,
      d.kind === 'component' && d.slot === 'berd'
        ? h(
            'label',
            { class: 'toggle block', title: 'Hairs switch to their alternate (tied/short) model while this mask is worn' },
            h('input', { type: 'checkbox', checked: !!d.hidesHair, onchange: (e: Event) => this.edit([d.id], (x) => (x.hidesHair = (e.target as HTMLInputElement).checked || undefined)) }),
            'Hides hair'
          )
        : null,
      d.kind === 'component' && d.slot === 'feet' ? this.amount('High heels', 'Raise the ped onto high heels by this amount (creature metadata)', d.highHeels, 1, (v) => this.edit([d.id], (x) => (v === undefined ? delete x.highHeels : (x.highHeels = v)))) : null,
      d.kind === 'prop' && d.slot === 'p_head' ? this.amount('Hair scale', 'Squash the hair under this hat by this amount (creature metadata)', d.hairScale, 0.5, (v) => this.edit([d.id], (x) => (v === undefined ? delete x.hairScale : (x.hairScale = v)))) : null,
      d.kind === 'prop'
        ? this.field(
            'Render',
            (() => {
              const sel = h('select', { title: 'How the prop is drawn' }, RENDER_FLAGS.map((f) => h('option', { value: f, selected: f === (d.renderFlag ?? '') }, f || 'default')));
              sel.onchange = () => this.edit([d.id], (x) => (sel.value ? (x.renderFlag = sel.value as PackDrawable['renderFlag']) : delete x.renderFlag));
              return sel;
            })()
          )
        : null,
      this.audioField(d),
      this.flagsField(d),
      h(
        'label',
        { class: 'toggle block', title: 'Keep this drawable number taken with an empty placeholder model' },
        h('input', { type: 'checkbox', checked: !!d.reserved, onchange: (e: Event) => this.edit([d.id], (x) => (x.reserved = (e.target as HTMLInputElement).checked || undefined)) }),
        'Reserved (placeholder)'
      ),
      d.reserved ? h('div', { class: 'muted small' }, 'Builds as an empty placeholder; the model and textures below are ignored.') : null,
      this.field('Model', pathRow(d.model, [h('button', { class: 'chip mini', onclick: () => void this.pick('model', (p) => this.edit([d.id], (x) => (x.model = p[0]))) }, 'Replace…')])),
      this.field(
        '1st person',
        d.firstPerson
          ? pathRow(d.firstPerson, [h('button', { class: 'chip mini', onclick: () => this.edit([d.id], (x) => delete x.firstPerson) }, 'Remove')])
          : h('button', { class: 'chip mini', title: 'Alternate model used in first-person view (streamed as _1)', onclick: () => void this.pick('model', (p) => this.edit([d.id], (x) => (x.firstPerson = p[0]))) }, 'Add .ydd…')
      ),
      d.kind === 'component'
        ? this.field(
            'Cloth',
            d.cloth
              ? pathRow(d.cloth, [h('button', { class: 'chip mini', onclick: () => this.edit([d.id], (x) => delete x.cloth) }, 'Remove')])
              : h('button', { class: 'chip mini', title: 'Cloth physics (.yld) for this drawable', onclick: () => void this.pick('cloth', (p) => this.edit([d.id], (x) => (x.cloth = p[0]))) }, 'Add .yld…')
          )
        : null,
      d.reserved
        ? null
        : h(
            'label',
            { class: 'toggle block', title: 'Keep this drawable\u2019s textures as they are when the build optimises textures' },
            h('input', { type: 'checkbox', checked: !!d.noOptimize, onchange: (e: Event) => this.edit([d.id], (x) => (x.noOptimize = (e.target as HTMLInputElement).checked || undefined)) }),
            "Don't optimise when building"
          ),
      h('div', { class: 'k pack-section' }, `Textures (${d.textures.length}${d.textures.length > MAX_TEXTURES ? `, max ${MAX_TEXTURES}` : ''})`),
      ...textures,
      h('button', { class: 'chip', onclick: () => void this.pick('textures', (p) => this.edit([d.id], (x) => x.textures.push(...p))) }, 'Add textures…'),
      ...(d.reserved ? [] : this.embeddedSection(d)),
      this.issueList([...this.missingFiles(d).map((m) => ({ severity: 'error' as const, message: `Missing file: ${m}` })), ...this.issuesFor(d.id)]),
      h('div', { class: 'pack-danger' }, h('button', { class: 'chip', onclick: () => this.removeSelectedOr(d.id) }, 'Remove drawable'))
    );
  }

  private setDetails(...items: (Node | string | null)[]): void {
    this.details.replaceChildren(...items.filter((x): x is Node | string => x !== null));
  }

  /** Optional numeric setting: a checkbox plus an amount (heels, hair scale). */
  private amount(label: string, title: string, value: number | undefined, fallback: number, set: (v: number | undefined) => void): HTMLElement {
    const box = h('input', { type: 'checkbox', checked: value !== undefined });
    const num = h('input', { type: 'number', step: '0.05', min: '0', max: '2', value: String(value ?? fallback), disabled: value === undefined, class: 'pack-amount' });
    box.onchange = () => set(box.checked ? Number(num.value) || fallback : undefined);
    num.onchange = () => box.checked && set(Number(num.value) || fallback);
    return h('label', { class: 'toggle block', title }, box, label, num);
  }

  private flagsField(d: PackDrawable): HTMLElement {
    const flags = d.flags ?? 0;
    const names = DRAWABLE_FLAGS.filter(([, v]) => flags & v).map(([n]) => n);
    return h(
      'details',
      { class: 'pack-flags' },
      h('summary', null, `Flags: ${names.length ? names.join(', ') : 'none'}`),
      DRAWABLE_FLAGS.map(([name, bit]) =>
        h(
          'label',
          { class: 'toggle block' },
          h('input', { type: 'checkbox', checked: !!(flags & bit), onchange: (e: Event) => this.edit([d.id], (x) => ((x.flags = (e.target as HTMLInputElement).checked ? (x.flags ?? 0) | bit : (x.flags ?? 0) & ~bit), x.flags || delete x.flags)) }),
          name
        )
      )
    );
  }

  private audioField(d: PackDrawable): HTMLElement {
    const options = d.kind === 'component' ? AUDIO_IDS[d.slot] ?? ['none'] : ['none'];
    const current = d.audio || 'none';
    const list = options.includes(current) ? options : [...options, current];
    const select = h('select', { title: 'Sound the drawable makes (clothing rustle, footsteps)' }, list.map((a) => h('option', { value: a, selected: a === current }, a)));
    select.onchange = () => this.edit([d.id], (x) => (select.value === 'none' ? delete x.audio : (x.audio = select.value)));
    return this.field('Audio', select);
  }

  private groupField(ids: string[], value: string | undefined): HTMLElement {
    const listId = 'pack-groups';
    const input = h('input', { type: 'text', value: value ?? '', placeholder: 'No group', spellcheck: false });
    input.setAttribute('list', listId); // read-only as a property
    input.onchange = () => this.edit(ids, (x) => (input.value.trim() ? (x.group = input.value.trim()) : delete x.group));
    const groups = [...new Set(this.pack.drawables.map((d) => d.group).filter((g): g is string => !!g))].sort();
    return this.field('Group', input, h('datalist', { id: listId }, groups.map((g) => h('option', { value: g }))));
  }

  private tagsField(d: PackDrawable): HTMLElement {
    const input = h('input', { type: 'text', placeholder: 'Add tag…', class: 'pack-tag-input', spellcheck: false });
    input.onkeydown = (e) => {
      if (e.key !== 'Enter' || !input.value.trim()) return;
      const tag = input.value.trim();
      this.edit([d.id], (x) => (x.tags = [...new Set([...(x.tags ?? []), tag])]));
    };
    return this.field(
      'Tags',
      ...(d.tags ?? []).map((t) =>
        h('span', { class: 'pack-tag' }, t, h('button', { class: 'pack-tag-x', title: 'Remove tag', onclick: () => this.edit([d.id], (x) => ((x.tags = (x.tags ?? []).filter((y) => y !== t)), x.tags.length || delete x.tags)) }, '×'))
      ),
      input
    );
  }

  /** Embedded textures of the model, with build-time replacements. */
  private embeddedSection(d: PackDrawable): HTMLElement[] {
    const info = this.embeddedInfo?.id === d.id ? this.embeddedInfo.textures : undefined;
    const replaced = d.embedded ?? {};
    const names = info ? info.map((t) => t.name) : Object.keys(replaced);
    if (!names.length) return info ? [] : [h('div', { class: 'k pack-section' }, 'Embedded textures'), h('div', { class: 'muted small' }, 'Loading…')];
    return [
      h('div', { class: 'k pack-section', title: 'Textures stored inside the model (.ydd); replacements are applied to the built copy only' }, `Embedded textures (${names.length})`),
      ...names.map((name) => {
        const t = info?.find((x) => x.name === name);
        return h(
          'div',
          { class: 'pack-path' },
          h('span', { title: name }, name),
          h('span', { class: 'muted small' }, t ? ` ${t.width}×${t.height} ${t.format}` : ''),
          replaced[name] ? h('span', { class: 'warn small', title: replaced[name] }, ' replaced') : null,
          h('span', { class: 'spacer' }),
          h('button', { class: 'chip mini', title: 'Replace at build time with an image (PNG, JPG, DDS…)', onclick: () => void this.replaceEmbedded(d, name) }, 'Replace…'),
          replaced[name] ? h('button', { class: 'chip mini', onclick: () => this.edit([d.id], (x) => (delete x.embedded![name], Object.keys(x.embedded!).length || delete x.embedded)) }, 'Revert') : null
        );
      }),
    ];
  }

  private async replaceEmbedded(d: PackDrawable, texture: string): Promise<void> {
    const picked = await hostRequest({ type: 'pickImage', requestId: newRequestId() }, 'pickedImage');
    if (!picked.name || !picked.data) return;
    try {
      let dds: Uint8Array;
      if (/\.dds$/i.test(picked.name)) dds = picked.data;
      else {
        const image = await decodeImage(picked.name, picked.data);
        dds = buildDds('A8B8G8R8', image.canvas.width, image.canvas.height, 1, canvasToRgba(image.canvas));
      }
      const name = `${shortName(d.model)}_${texture}.dds`;
      const saved = await hostRequest({ type: 'packSaveAsset', requestId: newRequestId(), name, data: dds }, 'packPicked');
      this.edit([d.id], (x) => (x.embedded = { ...(x.embedded ?? {}), [texture]: saved.paths[0] }));
      this.say(`${texture} will be replaced when building.`);
    } catch (err) {
      this.say(`Couldn't use ${picked.name}: ${(err as Error).message}`);
    }
  }

  private removeSelectedOr(id: string): void {
    if (!this.selected.size) this.selected = new Set([id]);
    this.removeSelected();
  }

  private renderBulk(chosen: PackDrawable[]): void {
    const ids = chosen.map((d) => d.id);
    const same = <T>(get: (d: PackDrawable) => T) => (chosen.every((d) => get(d) === get(chosen[0])) ? get(chosen[0]) : undefined);
    const components = chosen.filter((d) => d.kind === 'component');
    this.setDetails(
      h('div', { class: 'pack-details-title' }, h('strong', null, `${chosen.length} drawables selected`)),
      this.field('Gender', this.genderSelect(same((d) => d.gender), (g) => this.edit(ids, (x) => (x.gender = g)))),
      this.field(
        'Slot',
        this.slotSelect(same((d) => `${d.kind}:${d.slot}`), (kind, slot) =>
          this.edit(ids, (x) => {
            x.kind = kind;
            x.slot = slot;
            if (kind === 'prop') delete x.hasSkin;
          })
        )
      ),
      this.groupField(ids, same((d) => d.group)),
      this.field(
        'Tags',
        (() => {
          const input = h('input', { type: 'text', placeholder: 'Add tag to all…', spellcheck: false });
          input.onkeydown = (e) => e.key === 'Enter' && input.value.trim() && this.edit(ids, (x) => (x.tags = [...new Set([...(x.tags ?? []), input.value.trim()])]));
          return input;
        })()
      ),
      this.field(
        'Optimise',
        h('button', { class: 'chip', onclick: () => this.edit(ids, (x) => delete x.noOptimize) }, 'Allow'),
        h('button', { class: 'chip', onclick: () => this.edit(ids, (x) => (x.noOptimize = true)) }, "Don't")
      ),
      components.length
        ? this.field(
            'Has skin',
            h('button', { class: 'chip', onclick: () => this.edit(components.map((d) => d.id), (x) => (x.hasSkin = true)) }, 'Set'),
            h('button', { class: 'chip', onclick: () => this.edit(components.map((d) => d.id), (x) => delete x.hasSkin) }, 'Clear')
          )
        : null,
      this.field(
        'Order',
        h(
          'button',
          {
            class: 'chip',
            title: 'Sort the selected drawables by name within their slots',
            onclick: () =>
              this.commit((p) => {
                const set = new Set(ids);
                const label = (d: PackDrawable) => (d.name || fileName(d.model)).toLowerCase();
                const groups = new Map<string, PackDrawable[]>();
                for (const d of p.drawables) if (set.has(d.id)) groups.set(groupKey(d), [...(groups.get(groupKey(d)) ?? []), d]);
                for (const members of groups.values()) {
                  const slots = members.map((m) => p.drawables.indexOf(m));
                  const sorted = members.slice().sort((a, b) => label(a).localeCompare(label(b), undefined, { numeric: true }));
                  slots.forEach((at, i) => (p.drawables[at] = sorted[i]));
                }
              }),
          },
          'Sort by name'
        )
      ),
      this.issueList(chosen.flatMap((d) => this.issuesFor(d.id).map((i) => ({ ...i, message: `${slotLabel(d.kind, d.slot)}: ${i.message}` })))),
      h('div', { class: 'pack-danger' }, h('button', { class: 'chip', onclick: () => this.removeSelected() }, `Remove ${chosen.length} drawables`))
    );
  }

  private splitField(): HTMLElement {
    const input = h('input', { type: 'number', min: '1', max: '256', step: '1', value: String(slotLimit(this.pack)), class: 'pack-amount', title: 'Drawables per gender and slot before the pack is split into another collection (1–256)' });
    input.onchange = () => {
      const v = Math.max(1, Math.min(256, Math.floor(Number(input.value) || 256)));
      this.commit((p) => (v === 256 ? delete p.maxPerSlot : (p.maxPerSlot = v)));
    };
    return this.field('Split at', input, h('span', { class: 'muted small' }, 'per slot'));
  }

  private buildOptimizeFields(): HTMLElement[] {
    const o = this.pack.optimize;
    const set = (change: Partial<NonNullable<ClothPack['optimize']>> | undefined) =>
      this.commit((p) => (change ? (p.optimize = { maxSize: 2048, addMips: true, compress: true, embedded: true, ...p.optimize, ...change }) : delete p.optimize));
    const enabled = h('input', { type: 'checkbox', checked: !!o, onchange: (e: Event) => set((e.target as HTMLInputElement).checked ? {} : undefined) });
    const rows: HTMLElement[] = [
      h('div', { class: 'k pack-section' }, 'Build'),
      h('label', { class: 'toggle block', title: 'Optimise copies of the textures while building; your source files are not changed' }, enabled, 'Optimise textures while building'),
    ];
    if (o) {
      const size = h('select', null, [0, 4096, 2048, 1024, 512].map((n) => h('option', { value: String(n), selected: n === o.maxSize }, n ? `At most ${n} px` : 'No size limit')));
      size.onchange = () => set({ maxSize: Number(size.value) });
      const toggle = (label: string, key: 'addMips' | 'compress' | 'embedded', title: string) =>
        h('label', { class: 'toggle block pack-indent', title }, h('input', { type: 'checkbox', checked: o[key], onchange: (e: Event) => set({ [key]: (e.target as HTMLInputElement).checked }) }), label);
      rows.push(
        this.field('Size', size),
        toggle('Add missing mipmaps', 'addMips', 'Generate mipmaps for textures that have none'),
        toggle('Compress uncompressed', 'compress', 'Convert 32-bit textures to DXT1/DXT5'),
        toggle('Also textures inside models', 'embedded', 'Optimise textures embedded in the .ydd files too. They are rewritten in place: the file gets smaller, but the model\u2019s streaming memory stays the same')
      );
    }
    return rows;
  }

  /** Base ped models shown under the clothes in the outfit preview. */
  private bodyFields(): HTMLElement[] {
    const rows: HTMLElement[] = [h('div', { class: 'k pack-section', title: 'Optional: base freemode body parts (exported .ydd + .ytd) to dress in the preview' }, 'Preview body')];
    for (const g of GENDERS) {
      const parts = this.pack.body?.[g] ?? [];
      rows.push(
        this.field(
          g === 'male' ? 'Male' : 'Female',
          ...parts.map((part, i) =>
            h(
              'span',
              { class: 'pack-tag', title: `${part.model}${part.texture ? `\n${part.texture}` : ''}` },
              shortName(part.model),
              h('button', { class: 'pack-tag-x', title: 'Remove', onclick: () => this.commit((p) => p.body![g]!.splice(i, 1)) }, '×')
            )
          ),
          h(
            'button',
            {
              class: 'chip mini',
              title: 'Add a body model (.ydd), then optionally its texture (.ytd)',
              onclick: () =>
                void this.pick('model', (models) =>
                  void this.pick('textures', (tex) => this.commit((p) => ((p.body ??= {}), (p.body[g] ??= []).push({ model: models[0], ...(tex[0] ? { texture: tex[0] } : {}) })))).then(() => {
                    // No texture chosen: add the model alone.
                    if (!this.pack.body?.[g]?.some((b) => b.model === models[0])) this.commit((p) => ((p.body ??= {}), (p.body[g] ??= []).push({ model: models[0] })));
                  })
                ),
            },
            'Add…'
          )
        )
      );
    }
    rows.push(h('div', { class: 'muted small' }, 'Select several drawables (Ctrl/Cmd-click) to preview them together; body parts are added under them.'));
    return rows;
  }

  /** "Add reserved drawable": a placeholder in a chosen gender and slot. */
  private reservedAdder(): HTMLElement {
    let gender: Gender = 'male';
    let target: [DrawableKind, string] = ['component', 'jbib'];
    return this.field(
      'Reserve',
      this.genderSelect(gender, (g) => (gender = g)),
      this.slotSelect('component:jbib', (kind, slot) => (target = [kind, slot])),
      h(
        'button',
        {
          class: 'chip mini',
          title: 'Add a placeholder that keeps the next drawable number in this slot taken',
          onclick: () => {
            const id = newId();
            this.commit((p) => p.drawables.push({ id, gender, kind: target[0], slot: target[1], model: '', textures: [], reserved: true }));
            this.selected = new Set([id]);
            this.focus = id;
          },
        },
        'Add'
      )
    );
  }

  private renderSummary(): void {
    const output = h('input', { type: 'text', value: this.pack.output ?? `build/${this.pack.name}`, spellcheck: false, title: 'Build output folder, relative to the pack file' });
    output.onchange = () => this.commit((p) => (p.output = output.value.trim() || undefined));
    const bySlot = GENDERS.map((g) => {
      const own = this.pack.drawables.filter((d) => d.gender === g);
      return this.field(g === 'male' ? 'Male' : 'Female', `${own.filter((d) => d.kind === 'component').length} clothing, ${own.filter((d) => d.kind === 'prop').length} props`);
    });
    this.setDetails(
      h('div', { class: 'pack-details-title' }, h('strong', null, 'Pack')),
      this.field('Collection', this.pack.name),
      ...bySlot,
      this.field('Build to', output),
      this.splitField(),
      this.reservedAdder(),
      ...this.buildOptimizeFields(),
      ...this.bodyFields(),
      h(
        'div',
        { class: 'muted small pack-help' },
        'Add models with + Male / + Female: the slot, gender, texture variations (…_diff_000_a.ytd) and cloth (.yld) are found from file names. ' +
          'Select a drawable to preview and edit it; Ctrl/Cmd-click or Shift-click to select several; drag rows to reorder within a slot. ' +
          'Build writes a FiveM resource (fxmanifest, stream files, .ymt and shop meta).'
      ),
      this.checked ? this.issueList(this.issuesFor(undefined)) ?? h('div', { class: 'opt-ok' }, this.issues.length ? `${this.issues.length} issue(s) on drawables (marked in the list).` : '✓ No problems found.') : null
    );
  }

  // -- actions -------------------------------------------------------------------

  private async pick(purpose: 'textures' | 'cloth' | 'model', use: (paths: string[]) => void): Promise<void> {
    const reply = await hostRequest({ type: 'packPickFiles', requestId: newRequestId(), purpose }, 'packPicked');
    if (reply.paths.length) use(reply.paths);
  }

  /**
   * Picks models; when everything is detected and nothing is a duplicate they are
   * added straight away, otherwise a dialog asks for the missing gender/slot.
   */
  private async addDrawables(gender: Gender): Promise<void> {
    this.say('Choose models…');
    const reply = await hostRequest({ type: 'packAddDrawables', requestId: newRequestId(), gender }, 'packCandidates');
    this.say('');
    if (!reply.candidates.length) return;
    const ready = reply.candidates.every((c) => c.gender && c.kind && c.slot && !c.duplicateOf);
    const added: PackDrawable[] | undefined = ready
      ? reply.candidates.map((c) => ({
          id: newId(),
          gender: c.gender!,
          kind: c.kind!,
          slot: c.slot!,
          model: c.model,
          textures: c.textures,
          ...(c.hasSkin ? { hasSkin: true } : {}),
          ...(c.cloth && c.kind === 'component' ? { cloth: c.cloth } : {}),
        }))
      : await resolveImport(reply.candidates, this.pack);
    if (!added?.length) return;
    this.selected = new Set(added.map((d) => d.id));
    this.focus = added[0].id;
    this.commit((p) => p.drawables.push(...added));
    this.say(`Added ${added.length} drawable${added.length === 1 ? '' : 's'}.`);
  }

  private async findDuplicates(): Promise<void> {
    this.say('Looking for duplicates…');
    const reply = await hostRequest({ type: 'packFindDuplicates', requestId: newRequestId() }, 'packDuplicates');
    this.say('');
    duplicateInspector(reply.groups, this.pack, {
      show: (id) => {
        this.selected = new Set([id]);
        this.focus = id;
        this.filter = '';
        this.render();
        this.list.querySelector('.pack-row.focused')?.scrollIntoView({ block: 'center' });
      },
      remove: (ids) => {
        const set = new Set(ids);
        this.commit((p) => (p.drawables = p.drawables.filter((d) => !set.has(d.id))));
        this.say(`Removed ${ids.length} duplicate${ids.length === 1 ? '' : 's'} (Undo with Ctrl/Cmd+Z).`);
      },
    });
  }

  private async runChecks(): Promise<void> {
    this.say('Checking…');
    const reply = await hostRequest({ type: 'packCheck', requestId: newRequestId() }, 'packChecks');
    this.issues = reply.issues;
    this.checked = true;
    const n = (s: PackIssue['severity']) => reply.issues.filter((i) => i.severity === s).length;
    this.say(reply.issues.length ? `${n('error')} error(s), ${n('warning')} warning(s), ${n('info')} note(s).` : '✓ No problems found.');
    this.render();
  }

  private async build(): Promise<void> {
    this.say('Building…');
    const reply = await hostRequest({ type: 'packBuild', requestId: newRequestId() }, 'packBuilt');
    if (reply.ok) {
      this.status.replaceChildren(
        h('span', { class: 'opt-ok' }, `✓ Built ${reply.files} files to ${reply.output}`),
        ...(reply.warnings?.length ? [h('span', { class: 'warn' }, ` · ${reply.warnings.join(' ')}`)] : []),
        ' ',
        h('button', { class: 'chip mini', onclick: () => vscode.postMessage({ type: 'packReveal' }) }, 'Show in Explorer')
      );
    } else this.say(reply.cancelled ? '' : `Build failed: ${reply.error}`);
  }

  // -- preview -------------------------------------------------------------------

  /**
   * Drawables to show together: the selection (of the focused drawable's gender)
   * when several are selected, or the focused one with body parts when the pack
   * has some; undefined for the single-drawable preview.
   */
  private outfitItems(focus: PackDrawable | undefined): PackDrawable[] | undefined {
    if (!focus) return undefined;
    const chosen = this.pack.drawables.filter((d) => this.selected.has(d.id) && d.gender === focus.gender && !d.reserved);
    if (chosen.length > 1) return chosen;
    if (this.pack.body?.[focus.gender]?.length && !focus.reserved) return [focus];
    return undefined;
  }

  private async showOutfit(drawables: PackDrawable[], gender: Gender): Promise<void> {
    const token = ++this.token;
    const body = this.pack.body?.[gender] ?? [];
    this.outfit.setStatus(`Loading ${drawables.length + body.length} models…`);
    const load = async (model: string, texture?: string) => {
      const [m, t] = await Promise.all([
        hostRequest({ type: 'packLoadModel', requestId: newRequestId(), path: model, maxTextureSize: PREVIEW_TEXTURE_SIZE }, 'drawableFile'),
        texture ? hostRequest({ type: 'packLoadTexture', requestId: newRequestId(), path: texture, maxSize: PREVIEW_TEXTURE_SIZE }, 'textureFile') : Promise.resolve(undefined),
      ]);
      const tex = t?.textures.find((x) => !/_(n|s|nm|spec|normal)$/i.test(x.name)) ?? t?.textures[0];
      return { drawable: m.drawables[0], texture: tex, error: m.error };
    };
    const items: OutfitItem[] = [];
    const failed: string[] = [];
    for (const [i, part] of body.entries()) {
      const r = await load(part.model, part.texture);
      if (r.drawable) items.push({ key: `body${i}`, drawable: r.drawable, texture: r.texture, kind: 'body' });
      else failed.push(shortName(part.model));
    }
    for (const d of drawables) {
      const r = await load(d.model, d.textures[0]);
      if (r.drawable && d.id === this.focus) this.embeddedInfo = { id: d.id, textures: r.drawable.textures };
      if (r.drawable) items.push({ key: d.id, drawable: r.drawable, texture: r.texture, kind: d.kind, slot: d.slot, highHeels: d.highHeels, hairScale: d.hairScale });
      else failed.push(d.name || shortName(d.model));
    }
    if (token !== this.token) return;
    if (this.selected.size <= 1) this.renderDetails();
    this.outfit.show(items, true);
    this.outfit.setStatus(failed.length ? `Couldn't load ${failed.join(', ')}` : '');
  }

  private async showPreview(d: PackDrawable | undefined): Promise<void> {
    const token = ++this.token;
    this.panel.setVariationTexture(undefined);
    if (!d || d.reserved) {
      this.panel.setDrawables([]);
      this.title.replaceChildren(h('span', { class: 'muted' }, d ? 'Reserved placeholder: nothing to preview.' : 'Select a drawable to preview it (Esc clears the selection).'));
      this.strip.replaceChildren();
      return;
    }
    this.title.replaceChildren(h('strong', null, d.name || shortName(d.model)), h('span', { class: 'muted' }, ` · ${d.textures.length} variation${d.textures.length === 1 ? '' : 's'}`));
    this.panel.setStatus('Loading model…');
    const cards = d.textures.map((t, i) => {
      const holder = h('div', { class: 'checker thumb-image' }, h('span', { class: 'muted small' }, '…'));
      const card = h('div', { class: 'thumb variation', title: t }, holder, h('div', { class: 'thumb-name' }, String.fromCharCode(65 + i)));
      return { t, card, holder };
    });
    this.strip.replaceChildren(...(cards.length ? cards.map((c) => c.card) : [h('div', { class: 'muted' }, 'No texture variations.')]));

    const model = await hostRequest({ type: 'packLoadModel', requestId: newRequestId(), path: d.model, maxTextureSize: PREVIEW_TEXTURE_SIZE }, 'drawableFile');
    if (token !== this.token) return;
    this.panel.setDrawables(model.drawables);
    this.embeddedInfo = { id: d.id, textures: model.drawables[0]?.textures ?? [] };
    if (this.selected.size <= 1) this.renderDetails();
    this.panel.setStatus(model.error ?? (model.drawables.length ? '' : 'The model file is empty.'));

    let applied = false;
    for (const c of cards) {
      const reply = await hostRequest({ type: 'packLoadTexture', requestId: newRequestId(), path: c.t, maxSize: PREVIEW_TEXTURE_SIZE }, 'textureFile');
      if (token !== this.token) return;
      const tex: TextureData | undefined = reply.textures.find((x) => !/_(n|s|nm|spec|normal)$/i.test(x.name)) ?? reply.textures[0];
      if (!tex) {
        c.holder.replaceChildren(h('span', { class: 'muted small' }, reply.error ? 'unreadable' : 'missing'));
        continue;
      }
      c.holder.replaceChildren(textureCanvas(tex, 96));
      c.card.title = `${c.t}\n${tex.name} · ${textureDescription(tex)}\nClick to apply · double-click to view`;
      const apply = () => {
        this.strip.querySelectorAll('.variation').forEach((el) => el.classList.toggle('active', el === c.card));
        this.panel.setVariationTexture(tex);
      };
      c.card.onclick = apply;
      c.card.ondblclick = () => openLightbox(tex, fileName(c.t), { original: tex, setPreview: () => undefined });
      if (!applied) {
        apply();
        applied = true;
      }
    }
  }
}
