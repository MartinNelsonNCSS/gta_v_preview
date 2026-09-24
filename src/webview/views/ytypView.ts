import * as THREE from 'three';
import type { ArchetypeData, ArchetypeRequest, DrawableData, EntityData, YtypData } from '../../shared/model';
import { availableLod, boxHelper, buildDrawable, TextureStore } from '../scene';
import { checkbox, cutSlider, fmt, h, newRequestId, onHostMessage, pref, vscode } from '../ui';
import { Viewer } from '../viewer';
import { fetchTextures, kv, ModelPanel, renderOptions, section } from './modelPanel';

/** Textures in interiors are capped lower to keep memory reasonable. */
const MLO_TEXTURE_SIZE = 512;

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

// ---------------------------------------------------------------------------
// Model loading
// ---------------------------------------------------------------------------

function requestFor(name: string, ytyp: YtypData): ArchetypeRequest {
  const def = ytyp.archetypes.find((a) => a.name.toLowerCase() === name.toLowerCase());
  return { name, dictionary: def?.drawableDictionary || undefined };
}

/** Asks the host for archetype models; `onBatch` is called as they arrive. */
function loadArchetypes(
  requests: ArchetypeRequest[],
  onBatch: (models: Record<string, DrawableData | null>) => void,
  maxTextureSize?: number
): Promise<void> {
  const requestId = newRequestId();
  return new Promise((resolve) => {
    const off = onHostMessage((m) => {
      if (m.type !== 'archetypeModels' || m.requestId !== requestId) return;
      onBatch(m.models);
      if (m.done) {
        off();
        resolve();
      }
    });
    vscode.postMessage({ type: 'loadArchetypes', requestId, archetypes: requests, maxTextureSize });
  });
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
          ondblclick: () => vscode.postMessage({ type: 'openAsset', name: a.drawableDictionary || a.name, ext: a.drawableDictionary ? 'ydd' : 'ydr' }),
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
          a.assetType === 'ASSET_TYPE_FRAGMENT'
            ? `${a.name} is a fragment (.yft), which isn't supported yet.`
            : `No ${a.drawableDictionary ? `${a.drawableDictionary}.ydd` : `${a.name}.ydr`} found near this file.`
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

/** Entity transform. CEntityDef stores the inverse rotation, so conjugate it. */
function entityMatrix(e: EntityData): THREE.Matrix4 {
  const [x, y, z, w] = e.rotation;
  const q = new THREE.Quaternion(-x, -y, -z, w).normalize();
  return new THREE.Matrix4().compose(new THREE.Vector3(...e.position), q, new THREE.Vector3(...e.scale));
}

class MloView {
  readonly el: HTMLElement;
  private readonly viewer: Viewer;
  private readonly store = new TextureStore();
  private readonly cache = new Map<object, unknown>();
  private readonly entityGroups: THREE.Group[] = [];
  private readonly models = new Map<string, DrawableData | null>();
  private readonly portals = new THREE.Group();
  private readonly rooms = new THREE.Group();
  private readonly status = h('div', { class: 'status' });
  private readonly info = h('div', { class: 'entity-info' });
  private readonly entityRows: HTMLElement[] = [];
  private selection?: THREE.Object3D;
  private selectedIndex = -1;
  private readonly hiddenSets = new Set<string>();

  constructor(private readonly archetype: ArchetypeData, private readonly ytyp: YtypData) {
    const mlo = archetype.mlo!;
    const stage = h('div', { class: 'stage' }, this.status);
    const sidebar = h('div', { class: 'sidebar' });
    this.el = h('div', { class: 'model-panel' }, this.toolbar(), h('div', { class: 'model-body' }, stage, sidebar));
    this.viewer = new Viewer(stage);
    this.viewer.setGridVisible(pref('grid', true));
    this.store.showTextures = pref('textures', true);
    this.store.onChange(() => this.viewer.requestRender());

    // Placeholders first, so the layout is visible immediately.
    const content = mlo.entities.map((e, i) => {
      const g = new THREE.Group();
      g.matrixAutoUpdate = false;
      g.matrix.copy(entityMatrix(e));
      g.userData.entityIndex = i;
      g.add(this.placeholder(e));
      this.entityGroups.push(g);
      return g;
    });
    this.viewer.setContent(...content);
    this.buildRoomsAndPortals();
    this.viewer.frame();

    this.canvasPicking(stage);
    sidebar.append(...this.sidebarContent());
    void this.loadModels();
  }

  private toolbar(): HTMLElement {
    return h(
      'div',
      { class: 'toolbar' },
      h('strong', null, this.archetype.name),
      h('span', { class: 'muted' }, `${this.archetype.mlo!.entities.length} entities · ${this.archetype.mlo!.rooms.length} rooms · ${this.archetype.mlo!.portals.length} portals`),
      h('span', { class: 'sep' }),
      checkbox('Textures', 'textures', true, (v) => {
        this.store.showTextures = v;
        this.store.refresh();
        this.viewer.requestRender();
      }),
      checkbox('Portals', 'mloPortals', false, (v) => ((this.portals.visible = v), this.viewer.requestRender())),
      checkbox('Room bounds', 'mloRooms', false, (v) => ((this.rooms.visible = v), this.viewer.requestRender())),
      checkbox('Grid', 'grid', true, (v) => this.viewer.setGridVisible(v)),
      cutSlider(
        () => {
          const b = new THREE.Box3().setFromObject(this.viewer.content);
          return b.isEmpty() ? undefined : { min: b.min.z, max: b.max.z };
        },
        (z) => this.viewer.setCutHeight(z)
      ),
      h('span', { class: 'spacer' }),
      h('button', { class: 'chip', onclick: () => this.viewer.frame() }, 'Frame')
    );
  }

  private placeholder(e: EntityData): THREE.Object3D {
    const def = this.ytyp.archetypes.find((a) => a.name.toLowerCase() === e.archetype.toLowerCase());
    const box =
      def && !def.mlo && def.bbMax.some((v, i) => v > def.bbMin[i])
        ? boxHelper(def.bbMin, def.bbMax, 0x8a8f98)
        : boxHelper([-0.25, -0.25, 0], [0.25, 0.25, 0.5], 0x8a8f98);
    box.userData.placeholder = true;
    return box;
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
    this.viewer.overlay.add(this.portals, this.rooms);
  }

  private async loadModels(): Promise<void> {
    const mlo = this.archetype.mlo!;
    const names = [...new Set(mlo.entities.map((e) => e.archetype))];
    let loaded = 0;
    let found = 0;
    this.setStatus(`Loading models… 0 / ${names.length}`);
    await loadArchetypes(
      names.map((n) => requestFor(n, this.ytyp)),
      (models) => {
        for (const [name, d] of Object.entries(models)) {
          this.models.set(name.toLowerCase(), d);
          loaded++;
          if (d) {
            found++;
            this.store.add(d.textures, 'embedded');
            this.attachModel(name, d);
          }
        }
        this.setStatus(`Loading models… ${loaded} / ${names.length}`);
        this.viewer.requestRender();
      },
      MLO_TEXTURE_SIZE
    );
    if (!this.viewer.userMoved) this.viewer.frame();
    const missing = names.length - found;
    const summary = missing ? `${found} of ${names.length} models found; ${missing} shown as boxes (base-game or missing files).` : '';
    this.setStatus(summary);

    const textureNames = [...this.models.values()].flatMap((d) => d?.shaders.map((s) => s.diffuse).filter((n): n is string => !!n) ?? []);
    const hints = this.ytyp.archetypes.map((a) => a.textureDictionary).filter((t) => !!t);
    await fetchTextures(this.store, textureNames, hints, (s) => this.setStatus([summary, s].filter(Boolean).join(' · ')), MLO_TEXTURE_SIZE);
  }

  private attachModel(name: string, d: DrawableData): void {
    const key = name.toLowerCase();
    const opts = renderOptions();
    const lod = availableLod(d, 'high');
    this.archetype.mlo!.entities.forEach((e, i) => {
      if (e.archetype.toLowerCase() !== key) return;
      const g = this.entityGroups[i];
      g.children.filter((c) => c.userData.placeholder).forEach((c) => g.remove(c));
      g.add(buildDrawable(d, lod, this.store, opts, this.cache));
    });
  }

  private setStatus(text: string): void {
    this.status.textContent = text;
    this.status.hidden = !text;
  }

  // -- selection --------------------------------------------------------------

  private canvasPicking(stage: HTMLElement): void {
    let down = { x: 0, y: 0 };
    stage.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    stage.addEventListener('pointerup', (e) => {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return; // was a drag
      let o: THREE.Object3D | null = this.viewer.pick(e.clientX, e.clientY)?.object ?? null;
      while (o && o.userData.entityIndex === undefined) o = o.parent;
      this.select(o ? (o.userData.entityIndex as number) : -1, false);
    });
  }

  private select(index: number, focus: boolean): void {
    if (this.selection) {
      this.viewer.overlay.remove(this.selection);
      this.selection = undefined;
    }
    this.entityRows[this.selectedIndex]?.classList.remove('selected');
    this.selectedIndex = index;
    const e = this.archetype.mlo!.entities[index];
    if (!e) {
      this.info.replaceChildren(h('div', { class: 'muted' }, 'Click an entity to inspect it.'));
      this.viewer.requestRender();
      return;
    }
    const g = this.entityGroups[index];
    g.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(g);
    this.selection = new THREE.Box3Helper(box, 0xffc107);
    this.viewer.overlay.add(this.selection);
    const row = this.entityRows[index];
    row?.classList.add('selected');
    if (!focus) row?.scrollIntoView({ block: 'nearest' });
    if (focus) this.viewer.frame(box);

    const model = this.models.get(e.archetype.toLowerCase());
    this.info.replaceChildren(
      kv('Archetype', e.archetype),
      kv('Model', model ? `${model.name}` : model === null ? 'not found' : 'loading…'),
      kv('Room', e.room ?? '—'),
      ...(e.entitySet ? [kv('Entity set', e.entitySet)] : []),
      kv('Position', e.position.map((v) => fmt(v, 3)).join(', ')),
      kv('Rotation', e.rotation.map((v) => fmt(v, 3)).join(', ')),
      kv('Scale', e.scale.map((v) => fmt(v, 2)).join(', ')),
      kv('LOD distance', fmt(e.lodDist)),
      kv('Flags', `0x${e.flags.toString(16)}`)
    );
    this.viewer.requestRender();
  }

  // -- sidebar ------------------------------------------------------------------

  private sidebarContent(): HTMLElement[] {
    const mlo = this.archetype.mlo!;
    const entityRow = (i: number) => {
      const e = mlo.entities[i];
      const row = h('div', { class: 'entity-row', onclick: () => this.select(i, true), title: 'Click to focus' }, e.archetype);
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
                  const on = (ev.target as HTMLInputElement).checked;
                  if (on) this.hiddenSets.delete(s.name);
                  else this.hiddenSets.add(s.name);
                  this.applySetVisibility();
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
      return h(
        'details',
        { class: 'room' },
        h('summary', null, `${r.name} (${r.entityIndices.length})`),
        r.entityIndices.filter((i) => mlo.entities[i]).map(entityRow)
      );
    });
    const unassigned = mlo.entities.map((_, i) => i).filter((i) => !assigned.has(i));
    const setsGroups = mlo.entitySets.map((s) => {
      const indices = unassigned.filter((i) => mlo.entities[i].entitySet === s.name);
      return indices.length ? h('details', { class: 'room' }, h('summary', null, `Set: ${s.name} (${indices.length})`), indices.map(entityRow)) : null;
    });
    const loose = unassigned.filter((i) => !mlo.entities[i].entitySet);
    const looseGroup = loose.length ? h('details', { class: 'room' }, h('summary', null, `No room (${loose.length})`), loose.map(entityRow)) : null;

    this.select(-1, false);
    return [
      section('Selection', true, this.info),
      ...(sets ? [sets] : []),
      section(`Rooms (${mlo.rooms.length})`, true, ...rooms, ...setsGroups.filter((x): x is HTMLDetailsElement => !!x), looseGroup ?? []),
    ];
  }

  private applySetVisibility(): void {
    this.archetype.mlo!.entities.forEach((e, i) => {
      this.entityGroups[i].visible = !e.entitySet || !this.hiddenSets.has(e.entitySet);
    });
    this.viewer.requestRender();
  }
}

// ---------------------------------------------------------------------------
// Raw tree
// ---------------------------------------------------------------------------

/** Collapsible JSON tree; children render lazily when first expanded. */
function jsonTree(value: unknown, key: string, open = false): HTMLElement {
  if (value === null || typeof value !== 'object') {
    return h('div', { class: 'json-leaf' }, h('span', { class: 'json-key' }, key), ': ', h('span', { class: `json-${typeof value}` }, JSON.stringify(value)));
  }
  if (Array.isArray(value) && value.every((v) => typeof v === 'number') && value.length <= 4) {
    return h('div', { class: 'json-leaf' }, h('span', { class: 'json-key' }, key), ': ', h('span', { class: 'json-number' }, `[${value.map((v) => fmt(v, 4)).join(', ')}]`));
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value).filter(([k]) => k !== '_type');
  const type = Array.isArray(value) ? `[${value.length}]` : (value as { _type?: string })._type ?? '{}';
  const details = h('details', { class: 'json-node', open }, h('summary', null, h('span', { class: 'json-key' }, key), ' ', h('span', { class: 'muted' }, type)));
  let rendered = false;
  const render = () => {
    if (rendered || !details.open) return;
    rendered = true;
    details.append(h('div', { class: 'json-children' }, entries.map(([k, v]) => jsonTree(v, k))));
  };
  details.addEventListener('toggle', render);
  render();
  return details;
}
