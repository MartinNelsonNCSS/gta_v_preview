import type { BoundsData } from '../../shared/model';
import { buildCollision, CollisionHit, CollisionOptions, materialColor } from '../collision';
import { checkbox, cutSlider, fmt, h, pref } from '../ui';
import { Viewer } from '../viewer';
import { kv, section } from './modelPanel';

const MATERIAL_NAMES_FALLBACK = (i: number) => `material ${i}`;

/** Collision viewer for .ybn files. */
export function ybnView(file: string, bounds: BoundsData): HTMLElement {
  const status = h('div', { class: 'status' });
  const stage = h('div', { class: 'stage' }, status);
  const sidebar = h('div', { class: 'sidebar' });
  const toolbar = h('div', { class: 'toolbar' });
  const root = h('div', { class: 'model-panel' }, toolbar, h('div', { class: 'model-body' }, stage, sidebar));
  const viewer = new Viewer(stage);
  viewer.setGridVisible(pref('grid', true));

  const hidden = new Set<number>();
  const opts: CollisionOptions = {
    wireframe: pref('ybnWireframe', false),
    triangles: pref('ybnTriangles', true),
    primitives: pref('ybnPrimitives', true),
    hiddenMaterials: hidden,
  };
  const rebuild = () => viewer.setContent(buildCollision(bounds, opts));
  const names = new Map(bounds.materials.map((m) => [m.index, m.name]));
  const selection = h('div', { class: 'muted' }, 'Click the collision to identify its material.');

  toolbar.append(
    h('strong', null, file),
    h('span', { class: 'sep' }),
    checkbox('Triangles', 'ybnTriangles', true, (v) => ((opts.triangles = v), rebuild())),
    checkbox('Primitives', 'ybnPrimitives', true, (v) => ((opts.primitives = v), rebuild())),
    checkbox('Wireframe', 'ybnWireframe', false, (v) => ((opts.wireframe = v), rebuild())),
    checkbox('Grid', 'grid', true, (v) => viewer.setGridVisible(v)),
    cutSlider(() => ({ min: bounds.bbMin[2], max: bounds.bbMax[2] }), (z) => viewer.setCutHeight(z)),
    h('span', { class: 'spacer' }),
    h('button', { class: 'chip', onclick: () => viewer.frame() }, 'Frame')
  );

  const size = bounds.bbMax.map((v, i) => v - bounds.bbMin[i]);
  const types = Object.entries(bounds.typeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => kv(k, fmt(n)));
  const materialRows = bounds.materials.map((m) => {
    const input = h('input', {
      type: 'checkbox',
      checked: true,
      onchange: () => {
        if (input.checked) hidden.delete(m.index);
        else hidden.add(m.index);
        rebuild();
      },
    });
    return h(
      'label',
      { class: 'toggle block material-row', title: `Material type ${m.index}` },
      input,
      h('span', { class: 'swatch', style: `background:#${materialColor(m.index).getHexString()}` }),
      h('span', { class: 'material-name' }, m.name),
      h('span', { class: 'muted' }, fmt(m.count))
    );
  });
  const setAll = (on: boolean) => {
    hidden.clear();
    if (!on) bounds.materials.forEach((m) => hidden.add(m.index));
    materialRows.forEach((r) => ((r.querySelector('input') as HTMLInputElement).checked = on));
    rebuild();
  };

  sidebar.append(
    section('Selection', true, selection),
    section(
      'Bounds',
      true,
      kv('Size', `${size.map((v) => fmt(v)).join(' × ')} m`),
      kv('Triangles', fmt(bounds.triangles)),
      kv('Primitives', fmt(bounds.primitives.length)),
      ...types
    ),
    section(
      `Materials (${bounds.materials.length})`,
      true,
      h('div', { class: 'row' }, h('button', { class: 'chip', onclick: () => setAll(true) }, 'All'), h('button', { class: 'chip', onclick: () => setAll(false) }, 'None')),
      ...materialRows
    )
  );

  // Click to identify.
  let down = { x: 0, y: 0 };
  stage.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
  stage.addEventListener('pointerup', (e) => {
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
    const hit = viewer.pick(e.clientX, e.clientY);
    const info = hit && (hit.object.userData.lookup?.(hit) as CollisionHit | undefined);
    if (!hit || !info) {
      selection.replaceChildren('Nothing under the cursor.');
      return;
    }
    const p = hit.point;
    selection.replaceChildren(
      kv('Material', names.get(info.material) ?? MATERIAL_NAMES_FALLBACK(info.material)),
      kv('Material index', String(info.material)),
      kv('Shape', info.kind),
      kv('Point', [p.x, p.y, p.z].map((v) => fmt(v, 2)).join(', '))
    );
  });

  rebuild();
  viewer.frame();
  status.textContent = bounds.triangles || bounds.primitives.length ? '' : 'This file contains no collision geometry.';
  return root;
}
