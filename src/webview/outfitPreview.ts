import * as THREE from 'three';
import type { DrawableData, TextureData } from '../shared/model';
import { availableLod, buildDrawable, TextureStore } from './scene';
import { renderOptions } from './views/modelPanel';
import { Viewer } from './viewer';
import { h } from './ui';

/** Ground level of the freemode peds in clothing model space. */
const FLOOR_Z = -1;
/** Approximate head bone of the freemode peds (clothing space faces −Y): where head props attach. */
const HEAD_BONE = new THREE.Matrix4().set(
  0, 0, 1, 0,
  0, -1, 0, 0,
  1, 0, 0, 0.6,
  0, 0, 0, 1
);
/** Hair-scale pivot (roughly the top of the skull). */
const HAIR_PIVOT = new THREE.Vector3(0, 0, 0.62);
const HEAD_PROPS = new Set(['p_head', 'p_eyes', 'p_ears', 'p_mouth']);

export interface OutfitItem {
  key: string;
  drawable: DrawableData;
  /** Diffuse to use instead of the model's own reference (a texture variation). */
  texture?: TextureData;
  kind: 'component' | 'prop' | 'body';
  slot?: string;
  highHeels?: number;
  hairScale?: number;
}

/**
 * Several drawables shown together on one ped (clothing on a body, props on
 * the head), with a floor at ground level and, for high heels, the lowered
 * floor the heel must reach (as in addon clothing tools).
 */
export class OutfitPreview {
  readonly el: HTMLElement;
  private readonly viewer: Viewer;
  private readonly store = new TextureStore();
  private readonly status = h('div', { class: 'status' });
  private readonly legend = h('div', { class: 'outfit-legend muted small' });
  private framed = false;

  constructor() {
    const stage = h('div', { class: 'stage' }, this.status, this.legend);
    this.el = h('div', { class: 'outfit-preview' }, stage);
    this.viewer = new Viewer(stage);
    this.viewer.setViewDirection(0.9, -1.6, 0.5); // clothing faces −Y
  }

  setStatus(text: string): void {
    this.status.textContent = text;
    this.status.hidden = !text;
  }

  show(items: OutfitItem[], reframe: boolean): void {
    const opts = renderOptions();
    const objects: THREE.Object3D[] = [];
    const heels = Math.max(0, ...items.map((i) => i.highHeels ?? 0));
    const hairScale = Math.max(0, ...items.map((i) => i.hairScale ?? 0));
    for (const item of items) {
      const d = this.withTexture(item);
      const group = buildDrawable(d, availableLod(d, 'high'), this.store, opts);
      if (item.kind === 'prop' && item.slot && HEAD_PROPS.has(item.slot)) {
        group.matrixAutoUpdate = false;
        group.matrix.copy(HEAD_BONE);
      }
      if (item.kind === 'component' && item.slot === 'hair' && hairScale > 0) squashHair(group, 1 - hairScale);
      objects.push(group);
    }
    objects.push(floor(FLOOR_Z, 0x888888, 0.18));
    if (heels > 0) objects.push(floor(FLOOR_Z - heels / 10, 0xff9f43, 0.35));
    this.viewer.setContent(...objects);
    this.legend.textContent = [
      heels > 0 ? `Orange floor: where the heel must reach (${heels.toFixed(2)} → ${(heels / 10).toFixed(3)} m below ground).` : '',
      hairScale > 0 ? `Hair squashed by ${Math.round(hairScale * 100)}% under the hat (approximate).` : '',
      items.some((i) => i.kind === 'prop' && i.slot && !HEAD_PROPS.has(i.slot)) ? 'Props on hands, wrists, hips and feet are shown at their anchor’s origin.' : '',
    ]
      .filter(Boolean)
      .join(' ');
    if (reframe || !this.framed) {
      this.viewer.frame();
      this.framed = true;
    }
  }

  /** Points the drawable's diffuse at its chosen variation under a unique name. */
  private withTexture(item: OutfitItem): DrawableData {
    this.store.add(item.drawable.textures, 'embedded');
    if (!item.texture) return item.drawable;
    const key = `__outfit__/${item.key}/${item.texture.name}`.toLowerCase();
    this.store.add([{ ...item.texture, name: key }], 'variation');
    return { ...item.drawable, shaders: item.drawable.shaders.map((s) => (s.diffuse ? { ...s, diffuse: key, diffuseIsOverlay: false } : s)) };
  }
}

function floor(z: number, color: number, opacity: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.4), new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }));
  mesh.position.z = z;
  return mesh;
}

/** Shrinks hair above the skull towards the pivot, roughly as the game's hair-scale bones do. */
function squashHair(group: THREE.Object3D, scale: number): void {
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry.clone();
    const p = geometry.getAttribute('position') as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      if (v.z <= HAIR_PIVOT.z) continue;
      v.sub(HAIR_PIVOT).multiplyScalar(scale).add(HAIR_PIVOT);
      p.setXYZ(i, v.x, v.y, v.z);
    }
    p.needsUpdate = true;
    geometry.computeBoundingSphere();
    mesh.geometry = geometry;
  });
}
