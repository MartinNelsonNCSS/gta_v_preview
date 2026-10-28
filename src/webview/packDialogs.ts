import { COMPONENT_SLOTS, ClothPack, DrawableKind, Gender, newId, PackDrawable, PROP_SLOTS, slotLabel } from '../formats/clothPack';
import type { PackCandidate } from '../shared/model';
import { h } from './ui';

const fileName = (p: string) => p.split('/').pop() ?? p;

function overlay(title: string, body: HTMLElement[], footer: HTMLElement[], onClose: () => void): { el: HTMLElement; close: () => void } {
  const close = () => {
    el.remove();
    window.removeEventListener('keydown', onKey);
    onClose();
  };
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  const el = h(
    'div',
    { class: 'lightbox', onclick: (e: Event) => e.target === el && close() },
    h(
      'div',
      { class: 'lightbox-panel add-panel pack-dialog' },
      h('div', { class: 'lightbox-header' }, h('strong', null, title), h('button', { class: 'chip', onclick: close, title: 'Close (Esc)' }, '✕')),
      h('div', { class: 'add-list' }, body),
      h('div', { class: 'row add-options' }, footer)
    )
  );
  window.addEventListener('keydown', onKey);
  document.body.append(el);
  return { el, close };
}

function slotOptions(value?: string): HTMLSelectElement {
  return h(
    'select',
    null,
    h('option', { value: '', selected: !value }, '— slot —'),
    h('optgroup', { label: 'Clothing' }, COMPONENT_SLOTS.map((s) => h('option', { value: `component:${s.key}`, selected: value === `component:${s.key}` }, `${s.label} (${s.key})`))),
    h('optgroup', { label: 'Props' }, PROP_SLOTS.map((s) => h('option', { value: `prop:${s.key}`, selected: value === `prop:${s.key}` }, `${s.label} (${s.key})`)))
  );
}

function genderOptions(value?: Gender): HTMLSelectElement {
  return h(
    'select',
    null,
    h('option', { value: '', selected: !value }, '— gender —'),
    h('option', { value: 'male', selected: value === 'male' }, 'Male'),
    h('option', { value: 'female', selected: value === 'female' }, 'Female')
  );
}

/**
 * Lets the user fill in what couldn't be detected for picked models (gender,
 * slot) and decide about duplicates of drawables already in the pack. Resolves
 * with the drawables to add, or undefined when cancelled.
 */
export function resolveImport(candidates: PackCandidate[], pack: ClothPack): Promise<PackDrawable[] | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const describe = (id: string) => {
      const d = pack.drawables.find((x) => x.id === id);
      if (!d) return 'an existing drawable';
      const n = pack.drawables.filter((x) => x.gender === d.gender && x.kind === d.kind && x.slot === d.slot).indexOf(d);
      return `${d.gender} ${slotLabel(d.kind, d.slot)} ${String(n).padStart(3, '0')}`;
    };
    const rows = candidates.map((c) => {
      const include = h('input', { type: 'checkbox', checked: !c.duplicateOf });
      const pick = h('input', { type: 'checkbox', class: 'resolve-pick' });
      const gender = genderOptions(c.gender);
      const slot = slotOptions(c.kind && c.slot ? `${c.kind}:${c.slot}` : undefined);
      const skin = h('input', { type: 'checkbox', checked: !!c.hasSkin });
      const note = h('div', { class: 'small' });
      const el = h(
        'div',
        { class: 'resolve-row' },
        pick,
        h('label', { class: 'toggle', title: 'Add this model' }, include),
        h('div', { class: 'add-fields' }, h('div', { class: 'add-source', title: c.model }, fileName(c.model)), note),
        gender,
        slot,
        h('label', { class: 'toggle', title: 'Has skin' }, skin, 'skin')
      );
      const update = () => {
        const problems = [!gender.value && 'set the gender', !slot.value && 'set the slot'].filter(Boolean);
        const info = [`${c.textures.length} texture${c.textures.length === 1 ? '' : 's'}`, c.cloth ? 'cloth' : '', c.duplicateOf ? `same model as ${describe(c.duplicateOf)}` : ''].filter(Boolean).join(' · ');
        note.textContent = include.checked && problems.length ? `Needed: ${problems.join(', ')}` : info;
        note.className = include.checked && problems.length ? 'small opt-bad' : c.duplicateOf ? 'small warn' : 'small muted';
        validate();
      };
      [include, gender, slot].forEach((x) => x.addEventListener('change', update));
      return { c, el, include, pick, gender, slot, skin, update };
    });

    const add = h('button', { class: 'chip active' }, 'Add');
    const validate = () => {
      const chosen = rows.filter((r) => r.include.checked);
      add.disabled = !chosen.length || chosen.some((r) => !r.gender.value || !r.slot.value);
      add.textContent = `Add ${chosen.length} drawable${chosen.length === 1 ? '' : 's'}`;
    };
    // Bulk: apply gender/slot to the ticked rows.
    const bulkGender = genderOptions();
    const bulkSlot = slotOptions();
    const apply = () => {
      const targets = rows.filter((r) => r.pick.checked);
      for (const r of targets.length ? targets : rows) {
        if (bulkGender.value) r.gender.value = bulkGender.value;
        if (bulkSlot.value) r.slot.value = bulkSlot.value;
        r.update();
      }
    };
    const dupCount = candidates.filter((c) => c.duplicateOf).length;
    const { close } = overlay(
      'Add drawables',
      [
        h(
          'div',
          { class: 'resolve-bulk' },
          h('span', { class: 'muted' }, 'Set for ticked rows (or all):'),
          bulkGender,
          bulkSlot,
          h('button', { class: 'chip', onclick: apply }, 'Apply')
        ),
        ...(dupCount ? [h('div', { class: 'warn small' }, `${dupCount} model${dupCount === 1 ? ' is' : 's are'} already in the pack and left unticked.`)] : []),
        ...rows.map((r) => r.el),
      ],
      [h('span', { class: 'spacer' }), add],
      () => !done && resolve(undefined)
    );
    add.onclick = () => {
      done = true;
      const drawables = rows
        .filter((r) => r.include.checked)
        .map((r): PackDrawable => {
          const [kind, slot] = r.slot.value.split(':') as [DrawableKind, string];
          return {
            id: newId(),
            gender: r.gender.value as Gender,
            kind,
            slot,
            model: r.c.model,
            textures: r.c.textures,
            ...(kind === 'component' && r.skin.checked ? { hasSkin: true } : {}),
            ...(r.c.cloth && kind === 'component' ? { cloth: r.c.cloth } : {}),
          };
        });
      close();
      resolve(drawables);
    };
    rows.forEach((r) => r.update());
  });
}

export interface DuplicateGroup {
  kind: 'model' | 'texture';
  ids: string[];
  file: string;
}

/**
 * Lists drawables whose models are identical (same gender and slot) and
 * texture files shared between drawables, with show / remove actions.
 */
export function duplicateInspector(groups: DuplicateGroup[], pack: ClothPack, actions: { show(id: string): void; remove(ids: string[]): void }): void {
  const label = (id: string) => {
    const d = pack.drawables.find((x) => x.id === id);
    if (!d) return id;
    const n = pack.drawables.filter((x) => x.gender === d.gender && x.kind === d.kind && x.slot === d.slot).indexOf(d);
    return `${d.gender === 'male' ? 'Male' : 'Female'} ${slotLabel(d.kind, d.slot)} ${String(n).padStart(3, '0')}${d.name ? ` "${d.name}"` : ''}`;
  };
  const models = groups.filter((g) => g.kind === 'model');
  const textures = groups.filter((g) => g.kind === 'texture');
  let close = () => {};
  const item = (id: string, removable: boolean) =>
    h(
      'div',
      { class: 'dup-item' },
      h('span', null, label(id)),
      h('span', { class: 'spacer' }),
      h('button', { class: 'chip mini', onclick: () => (close(), actions.show(id)) }, 'Show'),
      removable ? h('button', { class: 'chip mini', onclick: () => (close(), actions.remove([id])) }, 'Remove') : null
    );
  const body = [
    ...(groups.length ? [] : [h('div', { class: 'opt-ok' }, '✓ No duplicates found.')]),
    ...models.map((g) =>
      h(
        'div',
        { class: 'dup-group' },
        h('div', { class: 'dup-title' }, h('strong', null, `Identical model (${g.ids.length})`), h('span', { class: 'muted small' }, ` ${fileName(g.file)}`), h('span', { class: 'spacer' }), h('button', { class: 'chip mini', onclick: () => (close(), actions.remove(g.ids.slice(1))) }, 'Keep first, remove others')),
        g.ids.map((id) => item(id, true))
      )
    ),
    ...(textures.length ? [h('div', { class: 'pack-section' }, 'Shared texture files (fine if intended)')] : []),
    ...textures.map((g) => h('div', { class: 'dup-group' }, h('div', { class: 'dup-title' }, h('span', { class: 'muted small' }, fileName(g.file))), g.ids.map((id) => item(id, false)))),
  ];
  const removeAll = h(
    'button',
    { class: 'chip active', disabled: !models.length, onclick: () => (close(), actions.remove(models.flatMap((g) => g.ids.slice(1)))) },
    `Remove all duplicate models (${models.reduce((n, g) => n + g.ids.length - 1, 0)})`
  );
  close = overlay('Duplicates', body, [h('span', { class: 'spacer' }), removeAll], () => undefined).close;
}
