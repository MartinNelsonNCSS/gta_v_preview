import * as THREE from 'three';
import type { ArchetypeData, ArchetypeRequest, DrawableData, EntityData } from '../../shared/model';
import { availableLod, boxHelper, buildDrawable, TextureStore } from '../scene';
import { newRequestId, onHostMessage, pref, vscode } from '../ui';
import { Viewer } from '../viewer';
import { fetchTextures, renderOptions } from './modelPanel';

/** Textures in scenes with many models are capped lower to keep memory reasonable. */
export const SCENE_TEXTURE_SIZE = 512;

/** Entity transform. CEntityDef stores the inverse rotation, so conjugate it. */
export function entityMatrix(e: EntityData): THREE.Matrix4 {
  const [x, y, z, w] = e.rotation;
  const q = new THREE.Quaternion(-x, -y, -z, w).normalize();
  return new THREE.Matrix4().compose(new THREE.Vector3(...e.position), q, new THREE.Vector3(...e.scale));
}

/** Asks the host for archetype models and definitions; `onBatch` is called as they arrive. */
export function loadArchetypes(
  requests: ArchetypeRequest[],
  onBatch: (models: Record<string, DrawableData | null>, defs: Record<string, ArchetypeData | null>) => void,
  maxTextureSize?: number
): Promise<void> {
  const requestId = newRequestId();
  return new Promise((resolve) => {
    const off = onHostMessage((m) => {
      if (m.type !== 'archetypeModels' || m.requestId !== requestId) return;
      onBatch(m.models, m.archetypes);
      if (m.done) {
        off();
        resolve();
      }
    });
    vscode.postMessage({ type: 'loadArchetypes', requestId, archetypes: requests, maxTextureSize });
  });
}

/** One placed entity in the scene. */
export interface Placement {
  entity: EntityData;
  /** World transform. */
  matrix: THREE.Matrix4;
  /** Index of the MLO instance placement this came from, if any. */
  parent?: number;
}

/**
 * A 3D scene of placed archetype entities (MLO interiors, maps). Shows
 * placeholder boxes immediately, then swaps in models as the host finds
 * them, then fetches textures. Handles picking and selection highlighting.
 */
export class EntityScene {
  readonly viewer: Viewer;
  readonly store = new TextureStore();
  readonly placements: Placement[] = [];
  readonly groups: THREE.Group[] = [];
  readonly models = new Map<string, DrawableData | null>();
  readonly defs = new Map<string, ArchetypeData | null>();
  /** Called when the user picks an entity in 3D (index, or -1 for none). */
  onPick?: (index: number) => void;
  private readonly cache = new Map<object, unknown>();
  private readonly requested = new Set<string>();
  private selection?: THREE.Object3D;
  private hiddenFilter: (p: Placement) => boolean = () => false;

  constructor(
    readonly stage: HTMLElement,
    private readonly status: HTMLElement,
    localDefs: ArchetypeData[] = []
  ) {
    this.viewer = new Viewer(stage);
    this.viewer.setGridVisible(pref('grid', true));
    this.store.showTextures = pref('textures', true);
    this.store.onChange(() => this.viewer.requestRender());
    for (const d of localDefs) this.defs.set(d.name.toLowerCase(), d);
    this.enablePicking();
  }

  /** Adds entities (as placeholders); returns the index of the first one. */
  add(placements: Placement[]): number {
    const start = this.placements.length;
    for (const p of placements) {
      const g = new THREE.Group();
      g.matrixAutoUpdate = false;
      g.matrix.copy(p.matrix);
      g.userData.entityIndex = this.placements.length;
      const model = this.models.get(p.entity.archetype.toLowerCase());
      if (model) g.add(this.build(model));
      else g.add(this.placeholder(p.entity));
      g.visible = !this.hiddenFilter(p);
      this.placements.push(p);
      this.groups.push(g);
      this.viewer.content.add(g);
    }
    this.viewer.requestRender();
    return start;
  }

  /** Hides entities matching `hidden`. */
  setHidden(hidden: (p: Placement) => boolean): void {
    this.hiddenFilter = hidden;
    this.placements.forEach((p, i) => (this.groups[i].visible = !hidden(p)));
    this.viewer.requestRender();
  }

  setStatus(text: string): void {
    this.status.textContent = text;
    this.status.hidden = !text;
  }

  /**
   * Loads models for every archetype not requested yet. Returns the number of
   * archetypes requested and how many had models.
   */
  async loadModels(): Promise<{ requested: number; found: number }> {
    const names = [...new Set(this.placements.map((p) => p.entity.archetype))].filter((n) => !this.requested.has(n.toLowerCase()));
    names.forEach((n) => this.requested.add(n.toLowerCase()));
    let loaded = 0;
    let found = 0;
    if (!names.length) return { requested: 0, found: 0 };
    this.setStatus(`Loading models… 0 / ${names.length}`);
    await loadArchetypes(
      names.map((name) => ({ name, dictionary: this.defs.get(name.toLowerCase())?.drawableDictionary || undefined })),
      (models, defs) => {
        for (const [name, def] of Object.entries(defs)) if (def && !this.defs.get(name.toLowerCase())) this.defs.set(name.toLowerCase(), def);
        for (const [name, d] of Object.entries(models)) {
          loaded++;
          this.models.set(name.toLowerCase(), d);
          if (d) {
            found++;
            this.store.add(d.textures, 'embedded');
          }
          this.refresh(name);
        }
        this.setStatus(`Loading models… ${loaded} / ${names.length}`);
        this.viewer.requestRender();
      },
      SCENE_TEXTURE_SIZE
    );
    return { requested: names.length, found };
  }

  /** Fetches external textures for every loaded model. */
  async loadTextures(prefix: string): Promise<void> {
    const names = [...this.models.values()].flatMap((d) => d?.shaders.map((s) => s.diffuse).filter((n): n is string => !!n) ?? []);
    const hints = [...this.defs.values()].map((a) => a?.textureDictionary).filter((t): t is string => !!t);
    await fetchTextures(this.store, names, hints, (s) => this.setStatus([prefix, s].filter(Boolean).join(' · ')), SCENE_TEXTURE_SIZE);
  }

  /** Replaces placeholders for `name` with its model (or a better placeholder). */
  private refresh(name: string): void {
    const key = name.toLowerCase();
    const model = this.models.get(key);
    this.placements.forEach((p, i) => {
      if (p.entity.archetype.toLowerCase() !== key) return;
      const g = this.groups[i];
      g.children.filter((c) => c.userData.placeholder).forEach((c) => g.remove(c));
      g.add(model ? this.build(model) : this.placeholder(p.entity));
    });
  }

  private build(d: DrawableData): THREE.Object3D {
    return buildDrawable(d, availableLod(d, 'high'), this.store, renderOptions(), this.cache);
  }

  private placeholder(e: EntityData): THREE.Object3D {
    const def = this.defs.get(e.archetype.toLowerCase());
    const hasBox = def && !def.mlo && def.bbMax.some((v, i) => v > def.bbMin[i]);
    const box = hasBox ? boxHelper(def.bbMin, def.bbMax, 0x8a8f98) : boxHelper([-0.25, -0.25, 0], [0.25, 0.25, 0.5], 0x8a8f98);
    box.userData.placeholder = true;
    return box;
  }

  // -- selection --------------------------------------------------------------

  private enablePicking(): void {
    let down = { x: 0, y: 0 };
    this.stage.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    this.stage.addEventListener('pointerup', (e) => {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return; // was a drag
      let o: THREE.Object3D | null = this.viewer.pick(e.clientX, e.clientY)?.object ?? null;
      while (o && o.userData.entityIndex === undefined) o = o.parent;
      this.onPick?.(o ? (o.userData.entityIndex as number) : -1);
    });
  }

  /** Highlights entity `index` (or clears with -1); optionally frames it. */
  highlight(index: number, focus: boolean): void {
    if (this.selection) {
      this.viewer.overlay.remove(this.selection);
      this.selection = undefined;
    }
    const g = this.groups[index];
    if (g) {
      g.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(g);
      this.selection = new THREE.Box3Helper(box, 0xffc107);
      this.viewer.overlay.add(this.selection);
      if (focus) this.viewer.frame(box);
    }
    this.viewer.requestRender();
  }
}
