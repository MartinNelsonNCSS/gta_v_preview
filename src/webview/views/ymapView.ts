import * as THREE from 'three';
import type { CarGenData, EntityData, YmapData } from '../../shared/model';
import { boxHelper } from '../scene';
import { checkbox, cutSlider, fmt, h, pref } from '../ui';
import { entityMatrix, EntityScene, Placement } from './entityScene';
import { jsonTree } from './jsonTree';
import { kv, section } from './modelPanel';
import { entityDetails, modelState } from './ytypView';

const HD_LEVELS = new Set(['LODTYPES_DEPTH_HD', 'LODTYPES_DEPTH_ORPHANHD']);
const isLod = (e: EntityData) => !!e.lodLevel && !HD_LEVELS.has(e.lodLevel);

/** Map view for .ymap files: entities placed in the world, MLO instances expanded. */
export function ymapView(file: string, ymap: YmapData): HTMLElement {
  const body = h('div', { class: 'tab-body' });
  let map: MapTab | undefined;
  let raw: HTMLElement | undefined;
  const tabs = [
    { label: `Map (${ymap.entities.length} entities)`, render: () => (map ??= new MapTab(ymap)).el },
    { label: 'Raw', render: () => (raw ??= h('div', { class: 'raw-view' }, jsonTree(ymap.raw, 'CMapData', true))) },
  ];
  const buttons = tabs.map((t, i) => h('button', { class: 'tab', onclick: () => activate(i) }, t.label));
  const activate = (i: number) => {
    buttons.forEach((b, j) => b.classList.toggle('active', i === j));
    const el = tabs[i].render();
    if (!el.parentElement) body.append(el);
    [...body.children].forEach((c) => ((c as HTMLElement).hidden = c !== el));
  };
  const parent = ymap.parent ? ` · parent ${ymap.parent}` : '';
  const root = h(
    'div',
    { class: 'ytyp-view' },
    h('div', { class: 'toolbar' }, h('strong', null, ymap.name || file), h('span', { class: 'muted' }, `${file}${parent}`)),
    h('div', { class: 'tabs' }, buttons),
    body
  );
  activate(0);
  return root;
}

class MapTab {
  readonly el: HTMLElement;
  private readonly scene: EntityScene;
  private readonly carGens = new THREE.Group();
  private readonly extents = new THREE.Group();
  private readonly info = h('div', { class: 'entity-info' });
  private readonly list = h('div', { class: 'entity-list' });
  private readonly rows: HTMLElement[] = [];
  private selectedIndex = -1;
  private showLod = pref('ymapLod', false);

  constructor(private readonly ymap: YmapData) {
    const status = h('div', { class: 'status' });
    const stage = h('div', { class: 'stage' }, status);
    const sidebar = h('div', { class: 'sidebar' });
    this.scene = new EntityScene(stage, status);
    this.el = h('div', { class: 'model-panel' }, this.toolbar(), h('div', { class: 'model-body' }, stage, sidebar));

    // Only hide LOD entities when the map also has HD ones to look at.
    const hasHd = ymap.entities.some((e) => !isLod(e));
    if (!hasHd) this.showLod = true;
    this.scene.setHidden((p) => this.hidden(p));
    this.scene.add(ymap.entities.map((entity) => ({ entity, matrix: entityMatrix(entity) })));
    this.buildCarGens();
    this.buildExtents();
    this.scene.viewer.frame();
    this.scene.onPick = (i) => this.select(i, false);
    sidebar.append(...this.sidebarContent());
    void this.load();
  }

  private hidden(p: Placement): boolean {
    const top = p.parent === undefined ? p.entity : this.scene.placements[p.parent].entity;
    return !this.showLod && isLod(top);
  }

  private async load(): Promise<void> {
    let { requested, found } = await this.scene.loadModels();
    // Expand interiors placed by this map using their layout from a nearby .ytyp.
    let interiors = 0;
    const count = this.scene.placements.length;
    for (let i = 0; i < count; i++) {
      const p = this.scene.placements[i];
      const def = this.scene.defs.get(p.entity.archetype.toLowerCase());
      if (!p.entity.isMloInstance || !def?.mlo) continue;
      interiors++;
      this.scene.add(
        def.mlo.entities.map((entity) => ({ entity, matrix: p.matrix.clone().multiply(entityMatrix(entity)), parent: i }))
      );
    }
    if (interiors) {
      const more = await this.scene.loadModels();
      requested += more.requested;
      found += more.found;
      this.renderList();
    }
    if (!this.scene.viewer.userMoved) this.scene.viewer.frame();
    const missing = requested - found;
    const parts = [
      interiors ? `${interiors} interior${interiors === 1 ? '' : 's'} expanded` : '',
      missing ? `${found} of ${requested} models found; ${missing} shown as boxes (base-game or missing files)` : '',
    ].filter(Boolean);
    const summary = parts.join('; ');
    this.scene.setStatus(summary);
    await this.scene.loadTextures(summary);
    if (this.selectedIndex >= 0) this.select(this.selectedIndex, false);
  }

  private toolbar(): HTMLElement {
    const viewer = () => this.scene.viewer;
    const y = this.ymap;
    const counts = [
      `${y.entities.length} entities`,
      y.carGenerators.length ? `${y.carGenerators.length} car generators` : '',
      y.timecycleModifiers.length ? `${y.timecycleModifiers.length} timecycle modifiers` : '',
    ].filter(Boolean);
    return h(
      'div',
      { class: 'toolbar' },
      h('span', { class: 'muted' }, counts.join(' · ')),
      h('span', { class: 'sep' }),
      checkbox('Textures', 'textures', true, (v) => {
        this.scene.store.showTextures = v;
        this.scene.store.refresh();
        viewer().requestRender();
      }),
      checkbox('LOD entities', 'ymapLod', false, (v) => {
        this.showLod = v || !this.ymap.entities.some((e) => !isLod(e));
        this.scene.setHidden((p) => this.hidden(p));
      }),
      y.carGenerators.length ? checkbox('Car generators', 'ymapCarGens', true, (v) => ((this.carGens.visible = v), viewer().requestRender())) : null,
      checkbox('Extents', 'ymapExtents', false, (v) => ((this.extents.visible = v), viewer().requestRender())),
      checkbox('Grid', 'grid', true, (v) => viewer().setGridVisible(v)),
      cutSlider(() => ({ min: y.entitiesExtents[0][2], max: y.entitiesExtents[1][2] }), (z) => viewer().setCutHeight(z)),
      h('span', { class: 'spacer' }),
      h('button', { class: 'chip', onclick: () => viewer().frame() }, 'Frame')
    );
  }

  private buildCarGens(): void {
    const material = new THREE.MeshBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.35, depthWrite: false });
    const edge = new THREE.LineBasicMaterial({ color: 0x4fc3f7 });
    for (const c of this.ymap.carGenerators) this.carGens.add(carGenObject(c, material, edge));
    this.carGens.visible = pref('ymapCarGens', true);
    this.scene.viewer.overlay.add(this.carGens);
  }

  private buildExtents(): void {
    const [smin, smax] = this.ymap.streamingExtents;
    const [emin, emax] = this.ymap.entitiesExtents;
    this.extents.add(boxHelper(smin, smax, 0x8a8f98), boxHelper(emin, emax, 0xffc107));
    this.extents.visible = pref('ymapExtents', false);
    this.scene.viewer.overlay.add(this.extents);
  }

  private select(index: number, focus: boolean): void {
    this.rows[this.selectedIndex]?.classList.remove('selected');
    this.selectedIndex = index;
    this.scene.highlight(index, focus);
    const p = this.scene.placements[index];
    if (!p) {
      this.info.replaceChildren(h('div', { class: 'muted' }, 'Click an entity to inspect it.'));
      return;
    }
    const row = this.rows[index];
    row?.classList.add('selected');
    if (!focus) row?.scrollIntoView({ block: 'nearest' });
    const parent = p.parent !== undefined ? [kv('Inside interior', this.scene.placements[p.parent].entity.archetype)] : [];
    this.info.replaceChildren(...parent, ...entityDetails(p.entity, modelState(this.scene, p.entity)));
  }

  private renderList(): void {
    const filter = (this.list.previousElementSibling as HTMLInputElement | null)?.value.trim().toLowerCase() ?? '';
    const rows: HTMLElement[] = [];
    this.scene.placements.forEach((p, i) => {
      // Interior contents are listed under their instance, indented.
      const label = p.entity.isMloInstance ? `▣ ${p.entity.archetype}` : p.entity.archetype;
      const row = h(
        'div',
        {
          class: `entity-row${p.parent !== undefined ? ' nested' : ''}${isLod(p.entity) ? ' muted' : ''}`,
          onclick: () => this.select(i, true),
          title: p.entity.lodLevel?.replace(/^LODTYPES_DEPTH_/, '') ?? '',
        },
        label
      );
      this.rows[i] = row;
      if (!filter || p.entity.archetype.toLowerCase().includes(filter)) rows.push(row);
    });
    // Put each interior's contents right after it.
    const ordered: HTMLElement[] = [];
    const children = new Map<number, HTMLElement[]>();
    this.scene.placements.forEach((p, i) => {
      if (p.parent === undefined || !rows.includes(this.rows[i])) return;
      if (!children.has(p.parent)) children.set(p.parent, []);
      children.get(p.parent)!.push(this.rows[i]);
    });
    this.scene.placements.forEach((p, i) => {
      if (p.parent !== undefined) return;
      if (rows.includes(this.rows[i])) ordered.push(this.rows[i]);
      ordered.push(...(children.get(i) ?? []));
    });
    this.list.replaceChildren(...ordered);
    this.rows[this.selectedIndex]?.classList.add('selected');
  }

  private sidebarContent(): HTMLElement[] {
    const y = this.ymap;
    const filter = h('input', { type: 'search', placeholder: 'Filter entities…', class: 'sidebar-filter', oninput: () => this.renderList() });
    this.renderList();
    const block = y.block;
    const info = section(
      'Map',
      false,
      kv('Name', y.name),
      kv('Parent', y.parent || '—'),
      kv('Flags', `0x${y.flags.toString(16)}`),
      kv('Content flags', `0x${y.contentFlags.toString(16)}`),
      kv('Physics dictionaries', y.physicsDictionaries.length ? y.physicsDictionaries.join(', ') : '—'),
      ...(y.boxOccluders || y.occludeModels ? [kv('Occluders', `${y.boxOccluders} boxes, ${y.occludeModels} models`)] : []),
      ...(y.grassBatches ? [kv('Grass batches', fmt(y.grassBatches))] : []),
      ...(y.lodLights ? [kv('LOD lights', fmt(y.lodLights))] : []),
      ...(block ? [kv('Exported by', block.exportedBy || '—'), kv('Exported', block.time || '—')] : [])
    );
    const carGens = y.carGenerators.length
      ? section(
          `Car generators (${y.carGenerators.length})`,
          false,
          y.carGenerators.map((c) =>
            h('div', { class: 'entity-row', title: c.position.map((v) => fmt(v, 1)).join(', ') }, c.model || 'random', c.popGroup ? h('span', { class: 'muted' }, ` · ${c.popGroup}`) : null)
          )
        )
      : null;
    this.select(-1, false);
    return [
      section('Selection', true, this.info),
      info,
      section(`Entities (${y.entities.length})`, true, filter, this.list),
      ...(carGens ? [carGens] : []),
    ];
  }
}

/** A car-sized box oriented along the generator's direction, with a nose marker. */
function carGenObject(c: CarGenData, material: THREE.Material, edge: THREE.LineBasicMaterial): THREE.Object3D {
  const length = Math.max(Math.hypot(c.orientX, c.orientY), 1);
  const width = Math.max(c.perpendicularLength, 1);
  const g = new THREE.Group();
  const box = new THREE.BoxGeometry(width, length, 1.5);
  g.add(new THREE.Mesh(box, material), new THREE.LineSegments(new THREE.EdgesGeometry(box), edge));
  const nose = new THREE.Mesh(new THREE.ConeGeometry(width * 0.3, 0.8, 12), material);
  nose.position.set(0, length / 2 + 0.4, 0);
  g.add(nose);
  g.position.set(c.position[0], c.position[1], c.position[2] + 0.75);
  g.rotation.z = Math.atan2(c.orientY, c.orientX) - Math.PI / 2;
  return g;
}
