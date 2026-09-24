import * as THREE from 'three';
import type { ArchetypeData, ArchetypeRequest, EntityData, YtypData } from '../../shared/model';
import { boxHelper } from '../scene';
import { checkbox, cutSlider, fmt, h, pref, vscode } from '../ui';
import { entityMatrix, EntityScene, loadArchetypes } from './entityScene';
import { jsonTree } from './jsonTree';
import { kv, ModelPanel, section } from './modelPanel';

const TYPE_LABELS: Record<string, string> = {
  CBaseArchetypeDef: 'Base',
  CTimeArchetypeDef: 'Time',
  CMloArchetypeDef: 'Interior (MLO)',
};

export function ytypView(file: string, ytyp: YtypData): HTMLElement {
  const tabs: { label: string; render: () => HTMLElement; dispose?: () => void }[] = [];
  let archetypesTab: ArchetypesTab | undefined;
  tabs.push({
    label: `Archetypes (${ytyp.archetypes.length})`,
    render: () => (archetypesTab ??= new ArchetypesTab(ytyp)).el,
  });
  for (const a of ytyp.archetypes.filter((x) => x.mlo)) {
    let view: MloView | undefined;
    tabs.push({
      label: `Interior: ${a.name}`,
      render: () => (view ??= new MloView(a, ytyp)).el,
    });
  }
  tabs.push({ label: 'Raw', render: () => h('div', { class: 'raw-view' }, jsonTree(ytyp.raw, 'CMapTypes', true)) });

  const body = h('div', { class: 'tab-body' });
  const buttons = tabs.map((t, i) => h('button', { class: 'tab', onclick: () => activate(i) }, t.label));
  const rendered = new Map<number, HTMLElement>();
  const activate = (i: number) => {
    buttons.forEach((b, j) => b.classList.toggle('active', i === j));
    // Keep tab contents alive so 3D views don't reload when switching back.
    if (!rendered.has(i)) {
      const el = tabs[i].render();
      rendered.set(i, el);
      body.append(el);
    }
    rendered.forEach((el, j) => (el.hidden = j !== i));
  };

  const deps = ytyp.dependencies.length ? ` · depends on ${ytyp.dependencies.join(', ')}` : '';
  const root = h(
    'div',
    { class: 'ytyp-view' },
    h('div', { class: 'toolbar' }, h('strong', null, ytyp.name || file), h('span', { class: 'muted' }, `${file}${deps}`)),
    h('div', { class: 'tabs' }, buttons),
    body
  );
  // Interiors are the interesting part; open the first one directly.
  activate(tabs.length > 2 ? 1 : 0);
  return root;
}

function requestFor(name: string, ytyp: YtypData): ArchetypeRequest {
  const def = ytyp.archetypes.find((a) => a.name.toLowerCase() === name.toLowerCase());
  return { name, dictionary: def?.drawableDictionary || undefined };
}

// ---------------------------------------------------------------------------
// Archetypes tab
// ---------------------------------------------------------------------------

class ArchetypesTab {
  readonly el: HTMLElement;
  private readonly panel = new ModelPanel({ sidebar: false });
  private readonly details = h('div', { class: 'archetype-details' });
  private selected?: HTMLElement;
  private token = 0;

  constructor(private readonly ytyp: YtypData) {
    const rows = ytyp.archetypes.map((a) => {
      const size = a.bbMax.map((v, i) => v - a.bbMin[i]);
      const row = h(
        'tr',
        {
          onclick: () => this.select(a, row),
          ondblclick: () =>
            vscode.postMessage({
              type: 'openAsset',
              name: a.drawableDictionary || a.name,
              ext: a.drawableDictionary ? 'ydd' : a.assetType === 'ASSET_TYPE_FRAGMENT' ? 'yft' : 'ydr',
            }),
          title: 'Click to preview · double-click to open the model file',
        },
        h('td', null, a.name),
        h('td', null, TYPE_LABELS[a.type] ?? a.type),
        h('td', null, a.assetType.replace(/^ASSET_TYPE_/, '').toLowerCase()),
        h('td', { class: 'num' }, fmt(a.lodDist)),
        h('td', null, a.textureDictionary || '—'),
        h('td', { class: 'num' }, a.mlo ? '—' : size.map((v) => fmt(v, 1)).join('×'))
      );
      return { a, row };
    });
    const tbody = h('tbody', null, rows.map((r) => r.row));
    const filter = h('input', {
      type: 'search',
      placeholder: 'Filter archetypes…',
      oninput: () => {
        const q = filter.value.trim().toLowerCase();
        rows.forEach(({ a, row }) => (row.hidden = !!q && !`${a.name} ${a.textureDictionary}`.toLowerCase().includes(q)));
      },
    });
    this.el = h(
      'div',
      { class: 'archetypes-tab' },
      h(
        'div',
        { class: 'archetype-list' },
        h('div', { class: 'toolbar' }, filter),
        h(
          'div',
          { class: 'table-scroll' },
          h(
            'table',
            { class: 'data-table' },
            h('thead', null, h('tr', null, ['Name', 'Type', 'Asset', 'LOD dist', 'Texture dict', 'Size (m)'].map((c) => h('th', null, c)))),
            tbody
          )
        ),
        this.details
      ),
      h('div', { class: 'archetype-preview' }, this.panel.el)
    );
    const first = rows.find((r) => !r.a.mlo);
    if (first) this.select(first.a, first.row);
  }

  private select(a: ArchetypeData, row: HTMLElement): void {
    this.selected?.classList.remove('selected');
    row.classList.add('selected');
    this.selected = row;
    this.details.replaceChildren(archetypeDetails(a));
    const token = ++this.token;
    if (a.mlo) {
      this.panel.setDrawables([]);
      this.panel.setStatus('Interiors are shown in their own tab.');
      return;
    }
    this.panel.setStatus(`Loading ${a.name}…`);
    void loadArchetypes([requestFor(a.name, this.ytyp)], (models) => {
      if (token !== this.token) return;
      const d = models[a.name];
      if (d) {
        this.panel.setStatus('');
        this.panel.setTextureHints(a.textureDictionary ? [a.textureDictionary] : []);
        this.panel.setDrawables([d]);
      } else {
        this.panel.setDrawables([]);
        this.panel.setStatus(
          `No ${a.drawableDictionary ? `${a.drawableDictionary}.ydd` : a.assetType === 'ASSET_TYPE_FRAGMENT' ? `${a.name}.yft` : `${a.name}.ydr`} found near this file.`
        );
      }
    });
  }
}

function archetypeDetails(a: ArchetypeData): HTMLElement {
  return h(
    'div',
    null,
    kv('Name', a.name),
    kv('Asset', `${a.assetName} (${a.assetType.replace(/^ASSET_TYPE_/, '').toLowerCase()})`),
    a.drawableDictionary ? kv('Drawable dictionary', a.drawableDictionary) : null,
    kv('Texture dictionary', a.textureDictionary || '—'),
    a.physicsDictionary ? kv('Physics dictionary', a.physicsDictionary) : null,
    a.clipDictionary ? kv('Clip dictionary', a.clipDictionary) : null,
    kv('LOD distance', fmt(a.lodDist)),
    kv('Flags', `${a.flags} (0x${a.flags.toString(16)})`),
    a.timeFlags !== undefined ? kv('Time flags', `0x${a.timeFlags.toString(16)}`) : null,
    kv('Special attribute', String(a.specialAttribute)),
    kv('Bounds min', a.bbMin.map((v) => fmt(v, 3)).join(', ')),
    kv('Bounds max', a.bbMax.map((v) => fmt(v, 3)).join(', ')),
    kv('Sphere', `${a.bsCentre.map((v) => fmt(v, 3)).join(', ')} r=${fmt(a.bsRadius, 3)}`)
  );
}

// ---------------------------------------------------------------------------
// Interior (MLO) view
// ---------------------------------------------------------------------------

/** Details rows for an entity, shared by the interior and map views. */
export function entityDetails(e: EntityData, model: string): HTMLElement[] {
  return [
    kv('Archetype', e.archetype),
    kv('Model', model),
    ...(e.room ? [kv('Room', e.room)] : []),
    ...(e.entitySet ? [kv('Entity set', e.entitySet)] : []),
    ...(e.lodLevel ? [kv('LOD level', e.lodLevel.replace(/^LODTYPES_DEPTH_/, ''))] : []),
    kv('Position', e.position.map((v) => fmt(v, 3)).join(', ')),
    kv('Rotation', e.rotation.map((v) => fmt(v, 3)).join(', ')),
    kv('Scale', e.scale.map((v) => fmt(v, 2)).join(', ')),
    kv('LOD distance', fmt(e.lodDist)),
    kv('Flags', `0x${e.flags.toString(16)}`),
  ];
}

export function modelState(scene: EntityScene, e: EntityData): string {
  const key = e.archetype.toLowerCase();
  if (!scene.models.has(key)) return 'loading…';
  const d = scene.models.get(key);
  return d ? d.name : scene.defs.get(key)?.mlo ? 'interior (MLO)' : 'not found';
}

class MloView {
  readonly el: HTMLElement;
  private readonly scene: EntityScene;
  private readonly portals = new THREE.Group();
  private readonly rooms = new THREE.Group();
  private readonly info = h('div', { class: 'entity-info' });
  private readonly entityRows: HTMLElement[] = [];
  private selectedIndex = -1;
  private readonly hiddenSets = new Set<string>();

  constructor(private readonly archetype: ArchetypeData, ytyp: YtypData) {
    const mlo = archetype.mlo!;
    const status = h('div', { class: 'status' });
    const stage = h('div', { class: 'stage' }, status);
    const sidebar = h('div', { class: 'sidebar' });
    this.scene = new EntityScene(stage, status, ytyp.archetypes);
    this.el = h('div', { class: 'model-panel' }, this.toolbar(), h('div', { class: 'model-body' }, stage, sidebar));

    this.scene.add(mlo.entities.map((entity) => ({ entity, matrix: entityMatrix(entity) })));
    this.buildRoomsAndPortals();
    this.scene.viewer.frame();
    this.scene.onPick = (i) => this.select(i, false);
    sidebar.append(...this.sidebarContent());
    void this.load();
  }

  private async load(): Promise<void> {
    const { requested, found } = await this.scene.loadModels();
    if (!this.scene.viewer.userMoved) this.scene.viewer.frame();
    const missing = requested - found;
    const summary = missing ? `${found} of ${requested} models found; ${missing} shown as boxes (base-game or missing files).` : '';
    this.scene.setStatus(summary);
    await this.scene.loadTextures(summary);
    if (this.selectedIndex >= 0) this.select(this.selectedIndex, false);
  }

  private toolbar(): HTMLElement {
    const mlo = this.archetype.mlo!;
    const viewer = () => this.scene.viewer;
    return h(
      'div',
      { class: 'toolbar' },
      h('strong', null, this.archetype.name),
      h('span', { class: 'muted' }, `${mlo.entities.length} entities · ${mlo.rooms.length} rooms · ${mlo.portals.length} portals`),
      h('span', { class: 'sep' }),
      checkbox('Textures', 'textures', true, (v) => {
        this.scene.store.showTextures = v;
        this.scene.store.refresh();
        viewer().requestRender();
      }),
      checkbox('Portals', 'mloPortals', false, (v) => ((this.portals.visible = v), viewer().requestRender())),
      checkbox('Room bounds', 'mloRooms', false, (v) => ((this.rooms.visible = v), viewer().requestRender())),
      checkbox('Grid', 'grid', true, (v) => viewer().setGridVisible(v)),
      cutSlider(
        () => {
          const b = new THREE.Box3().setFromObject(viewer().content);
          return b.isEmpty() ? undefined : { min: b.min.z, max: b.max.z };
        },
        (z) => viewer().setCutHeight(z)
      ),
      h('span', { class: 'spacer' }),
      h('button', { class: 'chip', onclick: () => viewer().frame() }, 'Frame')
    );
  }

  private buildRoomsAndPortals(): void {
    const mlo = this.archetype.mlo!;
    for (const p of mlo.portals) {
      if (p.corners.length < 3) continue;
      const pts = p.corners.map((c) => new THREE.Vector3(...c));
      const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x4fc3f7 }));
      const fill = new THREE.Mesh(
        new THREE.BufferGeometry().setFromPoints([pts[0], pts[1], pts[2], pts[0], pts[2], pts[3] ?? pts[2]]),
        new THREE.MeshBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false })
      );
      this.portals.add(line, fill);
    }
    mlo.rooms.forEach((r, i) => {
      if (r.name.toLowerCase() === 'limbo') return;
      this.rooms.add(boxHelper(r.bbMin, r.bbMax, new THREE.Color().setHSL((i * 0.17) % 1, 0.7, 0.55).getHex()));
    });
    this.portals.visible = pref('mloPortals', false);
    this.rooms.visible = pref('mloRooms', false);
    this.scene.viewer.overlay.add(this.portals, this.rooms);
  }

  private select(index: number, focus: boolean): void {
    this.entityRows[this.selectedIndex]?.classList.remove('selected');
    this.selectedIndex = index;
    this.scene.highlight(index, focus);
    const e = this.archetype.mlo!.entities[index];
    if (!e) {
      this.info.replaceChildren(h('div', { class: 'muted' }, 'Click an entity to inspect it.'));
      return;
    }
    const row = this.entityRows[index];
    row?.classList.add('selected');
    if (!focus) row?.scrollIntoView({ block: 'nearest' });
    this.info.replaceChildren(...entityDetails(e, modelState(this.scene, e)));
  }

  private sidebarContent(): HTMLElement[] {
    const mlo = this.archetype.mlo!;
    const entityRow = (i: number) => {
      const row = h('div', { class: 'entity-row', onclick: () => this.select(i, true), title: 'Click to focus' }, mlo.entities[i].archetype);
      this.entityRows[i] = row;
      return row;
    };

    const sets = mlo.entitySets.length
      ? section(
          `Entity sets (${mlo.entitySets.length})`,
          true,
          mlo.entitySets.map((s) =>
            h(
              'label',
              { class: 'toggle block' },
              h('input', {
                type: 'checkbox',
                checked: true,
                onchange: (ev: Event) => {
                  if ((ev.target as HTMLInputElement).checked) this.hiddenSets.delete(s.name);
                  else this.hiddenSets.add(s.name);
                  this.scene.setHidden((p) => !!p.entity.entitySet && this.hiddenSets.has(p.entity.entitySet));
                },
              }),
              `${s.name} (${s.entityCount})`
            )
          )
        )
      : null;

    const assigned = new Set<number>();
    const rooms = mlo.rooms.map((r) => {
      r.entityIndices.forEach((i) => assigned.add(i));
      return h('details', { class: 'room' }, h('summary', null, `${r.name} (${r.entityIndices.length})`), r.entityIndices.filter((i) => mlo.entities[i]).map(entityRow));
    });
    const unassigned = mlo.entities.map((_, i) => i).filter((i) => !assigned.has(i));
    const setGroups = mlo.entitySets.flatMap((s) => {
      const indices = unassigned.filter((i) => mlo.entities[i].entitySet === s.name);
      return indices.length ? [h('details', { class: 'room' }, h('summary', null, `Set: ${s.name} (${indices.length})`), indices.map(entityRow))] : [];
    });
    const loose = unassigned.filter((i) => !mlo.entities[i].entitySet);
    const looseGroup = loose.length ? [h('details', { class: 'room' }, h('summary', null, `No room (${loose.length})`), loose.map(entityRow))] : [];

    this.select(-1, false);
    return [section('Selection', true, this.info), ...(sets ? [sets] : []), section(`Rooms (${mlo.rooms.length})`, true, ...rooms, ...setGroups, ...looseGroup)];
  }
}
