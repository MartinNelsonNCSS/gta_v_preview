import * as THREE from 'three';
import type { DrawableData, LodLevel, ShaderData, TextureData } from '../../shared/model';
import { LOD_LEVELS } from '../../shared/model';
import {
  applyRenderOptions,
  availableLod,
  boxHelper,
  buildDrawable,
  lodStats,
  RenderOptions,
  TextureStore,
} from '../scene';
import { openLightbox, textureCanvas, textureDescription } from '../textureCanvas';
import { buildCollision } from '../collision';
import { checkbox, cutSlider, fmt, h, newRequestId, onHostMessage, pref, select, setPref, vscode } from '../ui';
import { Viewer } from '../viewer';

const LOD_LABELS: Record<LodLevel, string> = { high: 'High', med: 'Medium', low: 'Low', vlow: 'Very low' };

/** Shared render toggles for every 3D view in this editor. */
export function renderOptions(): RenderOptions {
  return {
    textures: pref('textures', true),
    wireframe: pref('wireframe', false),
    vertexColors: pref('vertexColors', false),
    doubleSided: pref('doubleSided', true),
  };
}

/**
 * Requests textures that aren't embedded from nearby .ytd files. Textures are
 * added to `store` as they arrive; resolves when the host finishes searching.
 */
export function fetchTextures(
  store: TextureStore,
  names: string[],
  hints: string[],
  onStatus: (s: string) => void,
  maxSize?: number
): Promise<void> {
  const missing = [...new Set(names.map((n) => n.toLowerCase()))].filter((n) => !store.has(n));
  if (!missing.length) return Promise.resolve();
  const requestId = newRequestId();
  onStatus(`Searching for ${missing.length} texture${missing.length === 1 ? '' : 's'}…`);
  return new Promise((resolve) => {
    const off = onHostMessage((m) => {
      if (m.type !== 'textures' || m.requestId !== requestId) return;
      if (m.textures.length) store.add(m.textures, m.source);
      if (m.done) {
        off();
        const still = missing.filter((n) => !store.has(n));
        onStatus(
          still.length
            ? `${still.length} texture${still.length === 1 ? '' : 's'} not found (searched ${m.searched} .ytd file${m.searched === 1 ? '' : 's'})`
            : ''
        );
        resolve();
      } else {
        onStatus(`Searching textures… (${m.searched} dictionaries checked)`);
      }
    });
    vscode.postMessage({ type: 'findTextures', requestId, names: missing, hints, maxSize });
  });
}

export interface ModelPanelOptions {
  /** Texture dictionary names to search first (e.g. from a .ytyp archetype). */
  textureHints?: string[];
  sidebar?: boolean;
  /** Search nearby .ytd files for textures the model doesn't embed (default true). */
  searchTextures?: boolean;
}

/** Toolbar + 3D view + info sidebar for one or more drawables. */
export class ModelPanel {
  readonly el: HTMLElement;
  private readonly viewer: Viewer;
  private readonly store = new TextureStore();
  private readonly toolbar: HTMLElement;
  private readonly sidebar: HTMLElement;
  private readonly status: HTMLElement;
  private drawables: DrawableData[] = [];
  private current = 0;
  private lod: LodLevel = 'high';
  private opts = renderOptions();
  private bounds?: THREE.Object3D;
  private collision?: THREE.Object3D;
  /** Texture key that replaces the diffuse of variation-driven shaders (ped clothing). */
  private variationKey?: string;
  private offStore: () => void;

  constructor(private readonly options: ModelPanelOptions = {}) {
    this.toolbar = h('div', { class: 'toolbar' });
    this.status = h('div', { class: 'status' });
    const stage = h('div', { class: 'stage' }, this.status);
    this.sidebar = h('div', { class: 'sidebar' });
    this.el = h(
      'div',
      { class: 'model-panel' },
      this.toolbar,
      h('div', { class: 'model-body' }, stage, options.sidebar === false ? null : this.sidebar)
    );
    this.viewer = new Viewer(stage);
    this.viewer.setGridVisible(pref('grid', true));
    this.store.showTextures = this.opts.textures;
    this.offStore = this.store.onChange(() => {
      this.viewer.requestRender();
      this.renderSidebar();
    });
  }

  setDrawables(drawables: DrawableData[], keepCamera = false): void {
    this.drawables = drawables;
    this.current = Math.min(this.current, Math.max(0, drawables.length - 1));
    for (const d of drawables) this.store.add(d.textures, 'embedded');
    this.renderToolbar();
    this.show(!keepCamera);
    // Fetch every referenced texture (not just diffuse) so the sidebar can show them all.
    const names = drawables.flatMap((d) => d.shaders.flatMap((s) => s.textures.map((t) => t.texture)));
    const hints = [...(this.options.textureHints ?? []), ...drawables.map((d) => d.name)];
    if (this.options.searchTextures !== false) void fetchTextures(this.store, names, hints, (s) => this.setStatus(s));
  }

  /**
   * Uses `texture` as the diffuse for the drawable's clothing shaders, the way
   * the game applies a ped variation's .ytd. Pass undefined to restore.
   */
  setVariationTexture(texture: TextureData | undefined, source = 'variation'): void {
    this.variationKey = texture ? `__variation__/${source}/${texture.name}`.toLowerCase() : undefined;
    if (texture && this.variationKey) this.store.add([{ ...texture, name: this.variationKey }], source);
    if (this.drawable) this.show(false);
  }

  setTextureHints(hints: string[]): void {
    this.options.textureHints = hints;
  }

  setStatus(text: string): void {
    this.status.textContent = text;
    this.status.hidden = !text;
  }

  dispose(): void {
    this.offStore();
    this.viewer.dispose();
  }

  private get drawable(): DrawableData | undefined {
    return this.drawables[this.current];
  }

  private show(frame: boolean): void {
    const d = this.drawable;
    this.viewer.clearOverlay();
    if (!d) {
      this.viewer.setContent();
      return;
    }
    this.lod = availableLod(d, this.lod);
    this.store.unbindAll();
    this.viewer.setContent(buildDrawable(this.withVariation(d), this.lod, this.store, this.opts));
    this.bounds = boxHelper(d.bbMin, d.bbMax, 0xffc107);
    this.bounds.visible = pref('bounds', false);
    this.viewer.overlay.add(this.bounds);
    this.collision = d.bounds ? buildCollision(d.bounds, { overlay: true, wireframe: false, triangles: true, primitives: true }) : undefined;
    if (this.collision) {
      this.collision.visible = pref('collision', false);
      this.viewer.overlay.add(this.collision);
    }
    if (frame) this.viewer.frame();
    this.renderToolbar();
    this.renderSidebar();
  }

  /** Applies the variation texture to shaders that take their colour from a variation .ytd. */
  private withVariation(d: DrawableData): DrawableData {
    const key = this.variationKey;
    if (!key) return d;
    const isVariation = (s: ShaderData) => !!s.diffuse && /_diff_\d{3}/.test(s.diffuse);
    const targets = d.shaders.some(isVariation) ? isVariation : (s: ShaderData) => !!s.diffuse;
    return { ...d, shaders: d.shaders.map((s) => (targets(s) ? { ...s, diffuse: key, diffuseIsOverlay: false } : s)) };
  }

  private renderToolbar(): void {
    const d = this.drawable;
    const items: (HTMLElement | null)[] = [];
    if (this.drawables.length > 1) {
      items.push(
        h('span', { class: 'label' }, 'Drawable'),
        select(
          this.drawables.map((x, i) => ({ value: String(i), label: x.name || `#${i}` })),
          String(this.current),
          (v) => {
            this.current = Number(v);
            this.show(true);
          }
        )
      );
    }
    if (d) {
      items.push(
        h('span', { class: 'label' }, 'LOD'),
        select(
          LOD_LEVELS.map((l) => ({ value: l, label: LOD_LABELS[l], disabled: !d.lods[l].length })),
          this.lod,
          (v) => {
            this.lod = v;
            this.show(false);
          }
        )
      );
    }
    const rebuild = () => this.show(false);
    items.push(
      h('span', { class: 'sep' }),
      checkbox('Textures', 'textures', true, (v) => {
        this.opts.textures = v;
        this.store.showTextures = v;
        this.store.refresh();
        this.viewer.requestRender();
      }),
      checkbox('Wireframe', 'wireframe', false, (v) => {
        this.opts.wireframe = v;
        applyRenderOptions(this.viewer.content, this.opts);
        this.viewer.requestRender();
      }),
      checkbox('Vertex colours', 'vertexColors', false, (v) => {
        this.opts.vertexColors = v;
        rebuild();
      }),
      checkbox('Double-sided', 'doubleSided', true, (v) => {
        this.opts.doubleSided = v;
        applyRenderOptions(this.viewer.content, this.opts);
        this.viewer.requestRender();
      }),
      checkbox('Grid', 'grid', true, (v) => this.viewer.setGridVisible(v)),
      checkbox('Bounds', 'bounds', false, (v) => {
        if (this.bounds) this.bounds.visible = v;
        this.viewer.requestRender();
      }),
      d?.bounds
        ? checkbox('Collision', 'collision', false, (v) => {
            if (this.collision) this.collision.visible = v;
            this.viewer.requestRender();
          })
        : null,
      cutSlider(
        () => (d ? { min: d.bbMin[2], max: d.bbMax[2] } : undefined),
        (z) => this.viewer.setCutHeight(z)
      ),
      h('span', { class: 'spacer' }),
      h('button', { class: 'chip', onclick: () => this.viewer.frame(), title: 'Frame model' }, 'Frame')
    );
    this.toolbar.replaceChildren(...items.filter((x): x is HTMLElement => !!x));
  }

  private renderSidebar(): void {
    const d = this.drawable;
    if (!d || this.options.sidebar === false) {
      this.sidebar.replaceChildren();
      return;
    }
    const size = d.bbMax.map((v, i) => v - d.bbMin[i]);
    const stats = lodStats(d, this.lod);
    const lodRows = LOD_LEVELS.filter((l) => d.lods[l].length).map((l) => {
      const s = lodStats(d, l);
      return h('tr', null, h('td', null, LOD_LABELS[l]), h('td', null, fmt(s.vertices)), h('td', null, fmt(s.triangles)), h('td', null, fmt(d.lodDistances[l])));
    });

    const info = section(
      'Model',
      true,
      kv('Name', d.name || '—'),
      kv('Size', `${size.map((v) => fmt(v)).join(' × ')} m`),
      kv('Models / geometries', `${stats.models} / ${stats.geometries}`),
      kv('Bones', d.bones.length ? String(d.bones.length) : '—'),
      kv('Collision', d.bounds ? `${fmt(d.bounds.triangles)} tris, ${fmt(d.bounds.primitives.length)} primitives` : '—'),
      h(
        'table',
        { class: 'grid-table' },
        h('tr', null, h('th', null, 'LOD'), h('th', null, 'Verts'), h('th', null, 'Tris'), h('th', null, 'Dist')),
        lodRows
      )
    );

    const shaders = section(
      `Shaders (${d.shaders.length})`,
      true,
      d.shaders.map((s, i) =>
        h(
          'div',
          { class: 'shader' },
          h('div', { class: 'shader-name' }, `${i}: ${s.name}`),
          s.textures.map((t) => {
            const found = this.store.info(t.texture);
            const state = found?.data.pixels ? 'ok' : found ? 'ref' : 'missing';
            return h(
              'div',
              { class: `tex-ref ${state}`, title: found ? `${found.source === 'embedded' ? 'Embedded' : `From ${found.source}`}` : 'Not found' },
              h('span', { class: 'param' }, t.param),
              h('span', null, t.texture)
            );
          })
        )
      )
    );

    const textures = this.store.all().filter((t) => t.data.pixels);
    const gallery = section(
      `Textures (${textures.length})`,
      true,
      h(
        'div',
        { class: 'thumbs' },
        textures.map(({ data, source }) =>
          h(
            'div',
            {
              class: 'thumb',
              title: `${data.name}\n${textureDescription(data)}\n${source === 'embedded' ? 'Embedded' : `From ${source}`}`,
              onclick: () => openLightbox(data, source === 'embedded' ? 'embedded' : source),
            },
            h('div', { class: 'checker thumb-image' }, textureCanvas(data, 96)),
            h('div', { class: 'thumb-name' }, data.name.replace(/^__variation__\/[^/]*\//, ''))
          )
        )
      )
    );

    const bones = d.bones.length
      ? section(
          `Skeleton (${d.bones.length})`,
          false,
          h(
            'div',
            { class: 'bones' },
            d.bones.map((b, i) => h('div', null, `${i}: ${b.name}`, h('span', { class: 'muted' }, ` tag ${b.tag}`)))
          )
        )
      : null;

    this.sidebar.replaceChildren(...[info, shaders, gallery, bones].filter((x): x is HTMLElement => !!x));
  }
}

function section(title: string, open: boolean, ...content: (Node | Node[] | null)[]): HTMLElement {
  const key = `section:${title.replace(/\s*\(.*$/, '')}`;
  const el = h('details', { class: 'section', open: pref(key, open) }, h('summary', null, title), ...content.flat().filter((x): x is Node => !!x));
  el.addEventListener('toggle', () => setPref(key, el.open));
  return el;
}

function kv(k: string, v: string): HTMLElement {
  return h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v));
}

export { section, kv };
