import * as THREE from 'three';
import type { DrawableData, LodLevel, ShaderData, TextureData } from '../shared/model';
import { LOD_LEVELS } from '../shared/model';
import { decodeBc7 } from './bc7';

export interface RenderOptions {
  textures: boolean;
  wireframe: boolean;
  vertexColors: boolean;
  doubleSided: boolean;
}

/** Where a texture came from, for the UI. */
export type TextureSource = 'embedded' | string;

/**
 * Shared texture registry. Materials register interest in a texture name;
 * when it arrives (embedded or found in a .ytd) every waiting material is
 * updated in place.
 */
export class TextureStore {
  private readonly textures = new Map<string, { tex: THREE.Texture | null; data: TextureData; source: TextureSource }>();
  private readonly waiting = new Map<string, Set<THREE.MeshStandardMaterial>>();
  private readonly listeners = new Set<() => void>();
  /** Decals baked over a base colour, keyed by texture name and colour. */
  private readonly baked = new Map<string, THREE.Texture>();
  showTextures = true;

  add(list: TextureData[], source: TextureSource): void {
    for (const data of list) {
      const key = data.name.toLowerCase();
      if (this.textures.has(key)) continue;
      const tex = toThreeTexture(data);
      this.textures.set(key, { tex, data, source });
      this.waiting.get(key)?.forEach((m) => this.apply(m, key));
    }
    this.listeners.forEach((l) => l());
  }

  has(name: string): boolean {
    return this.textures.has(name.toLowerCase());
  }

  info(name: string): { data: TextureData; source: TextureSource } | undefined {
    return this.textures.get(name.toLowerCase());
  }

  all(): { data: TextureData; source: TextureSource }[] {
    return [...this.textures.values()];
  }

  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Binds `material.map` to the named texture now or when it arrives. */
  bind(material: THREE.MeshStandardMaterial, name: string): void {
    const key = name.toLowerCase();
    let set = this.waiting.get(key);
    if (!set) this.waiting.set(key, (set = new Set()));
    set.add(material);
    material.userData.textureName = key;
    this.apply(material, key);
  }

  unbindAll(): void {
    this.waiting.clear();
  }

  /** Re-applies texture visibility to every bound material. */
  refresh(): void {
    for (const [key, mats] of this.waiting) mats.forEach((m) => this.apply(m, key));
  }

  /** `tex` composited over a solid colour, so transparent areas show the base (e.g. paint under a livery). */
  private bakeOver(key: string, tex: THREE.Texture, color: number): THREE.Texture {
    const cacheKey = `${key}|${color}`;
    let out = this.baked.get(cacheKey);
    if (!out) {
      const src = tex.image as { data: Uint8Array; width: number; height: number };
      // Composite in sRGB space, like the texture data itself (hex colours are sRGB).
      const [br, bg, bb] = [(color >> 16) & 255, (color >> 8) & 255, color & 255];
      const data = new Uint8Array(src.data.length);
      for (let i = 0; i < data.length; i += 4) {
        const a = src.data[i + 3] / 255;
        data[i] = br + (src.data[i] - br) * a;
        data[i + 1] = bg + (src.data[i + 1] - bg) * a;
        data[i + 2] = bb + (src.data[i + 2] - bb) * a;
        data[i + 3] = 255;
      }
      out = new THREE.DataTexture(data, src.width, src.height, THREE.RGBAFormat, THREE.UnsignedByteType);
      out.colorSpace = THREE.SRGBColorSpace;
      out.wrapS = out.wrapT = THREE.RepeatWrapping;
      out.minFilter = THREE.LinearMipmapLinearFilter;
      out.generateMipmaps = true;
      out.anisotropy = 8;
      out.flipY = false;
      out.needsUpdate = true;
      this.baked.set(cacheKey, out);
    }
    return out;
  }

  private apply(m: THREE.MeshStandardMaterial, key: string): void {
    const entry = this.textures.get(key);
    let tex = this.showTextures && entry?.tex ? entry.tex : null;
    if (tex && m.userData.overlayOn !== undefined) tex = this.bakeOver(key, tex, m.userData.overlayOn as number);
    m.map = tex;
    if (m.userData.emissive) m.emissiveMap = tex;
    m.color.set(tex ? 0xffffff : m.userData.fallbackColor ?? 0xcccccc);
    m.needsUpdate = true;
  }
}

function toThreeTexture(t: TextureData): THREE.Texture | null {
  const px = t.pixels;
  if (!px) return null;
  let rgba: Uint8Array | null = px.data;
  if (px.encoding === 'bc7') rgba = decodeBc7(px.data, px.width, px.height);
  if (!rgba) return null;
  const tex = new THREE.DataTexture(rgba, px.width, px.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.flipY = false; // GTA uses D3D UVs (origin top-left), matching unflipped uploads.
  tex.needsUpdate = true;
  return tex;
}

/** Pastel colour derived from a string, so untextured parts stay distinguishable. */
export function colorFor(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return new THREE.Color().setHSL((h % 360) / 360, 0.35, 0.62).getHex();
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

type Blend = 'opaque' | 'cutout' | 'alpha' | 'decal';

function blendMode(shader: ShaderData | undefined): Blend {
  const n = shader?.name.toLowerCase() ?? '';
  if (/decal|dirt|glue/.test(n)) return 'decal';
  if (/glass|alpha|additive|water/.test(n)) return 'alpha';
  if (/cutout|fence|hair|trees|grass|ped|cloth/.test(n)) return 'cutout';
  switch (shader?.renderBucket) {
    case 1:
      return 'alpha';
    case 2:
      return 'decal';
    case 3:
      return 'cutout';
  }
  return 'opaque';
}

function createMaterial(shader: ShaderData | undefined, index: number, store: TextureStore, opts: RenderOptions) {
  const blend = blendMode(shader);
  const emissive = /emissive/i.test(shader?.name ?? '');
  const glass = /glass/i.test(shader?.name ?? '');
  const m = new THREE.MeshStandardMaterial({
    roughness: 0.85,
    metalness: 0,
    side: opts.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    wireframe: opts.wireframe,
    vertexColors: false,
    transparent: blend === 'alpha' || blend === 'decal',
    depthWrite: blend === 'opaque' || blend === 'cutout',
    alphaTest: blend === 'cutout' ? 0.35 : blend === 'decal' ? 0.01 : 0,
    opacity: glass ? 0.45 : 1,
    polygonOffset: blend === 'decal',
    polygonOffsetFactor: blend === 'decal' ? -1 : 0,
    polygonOffsetUnits: blend === 'decal' ? -4 : 0,
  });
  const paint = /^vehicle_paint/i.test(shader?.name ?? '');
  // Vehicle paint is a solid colour set at runtime; use a neutral grey.
  m.userData.fallbackColor = paint ? 0xb4b8be : colorFor(shader?.diffuse ?? `shader${index}`);
  m.userData.shaderIndex = index;
  if (shader?.diffuseIsOverlay) m.userData.overlayOn = m.userData.fallbackColor;
  if (paint) {
    m.roughness = 0.35;
    m.metalness = 0.1;
  }
  if (emissive) {
    m.userData.emissive = true;
    m.emissive.set(0xffffff);
    m.emissiveIntensity = 0.6;
  }
  if (shader?.diffuse) store.bind(m, shader.diffuse);
  else m.color.set(m.userData.fallbackColor);
  return m;
}

// ---------------------------------------------------------------------------
// Drawables
// ---------------------------------------------------------------------------

export interface DrawableStats {
  models: number;
  geometries: number;
  vertices: number;
  triangles: number;
}

export function lodStats(d: DrawableData, lod: LodLevel): DrawableStats {
  const models = d.lods[lod];
  const meshes = models.flatMap((m) => m.meshes);
  return {
    models: models.length,
    geometries: meshes.length,
    vertices: meshes.reduce((a, g) => a + g.positions.length / 3, 0),
    triangles: meshes.reduce((a, g) => a + g.indices.length / 3, 0),
  };
}

/** Highest-detail LOD at or below `preferred` that has any models. */
export function availableLod(d: DrawableData, preferred: LodLevel): LodLevel {
  const start = LOD_LEVELS.indexOf(preferred);
  for (let i = start; i < LOD_LEVELS.length; i++) if (d.lods[LOD_LEVELS[i]].length) return LOD_LEVELS[i];
  for (let i = start - 1; i >= 0; i--) if (d.lods[LOD_LEVELS[i]].length) return LOD_LEVELS[i];
  return preferred;
}

/**
 * Builds a three.js group for one LOD of a drawable. Geometry and materials
 * are shared via `cache` so repeated MLO entities don't duplicate them.
 */
export function buildDrawable(
  d: DrawableData,
  lod: LodLevel,
  store: TextureStore,
  opts: RenderOptions,
  cache?: Map<object, unknown>
): THREE.Group {
  const group = new THREE.Group();
  group.name = d.name;
  let materials = cache?.get(d) as THREE.MeshStandardMaterial[] | undefined;
  if (!materials) {
    materials = d.shaders.map((s, i) => createMaterial(s, i, store, opts));
    cache?.set(d, materials);
  }
  for (const model of d.lods[lod]) {
    const modelGroup = new THREE.Group();
    // Rigid (non-skinned) parts are authored relative to the bone they're attached to.
    const bone = d.bones[model.boneIndex];
    if (!model.skinned && bone && model.boneIndex > 0) {
      modelGroup.matrixAutoUpdate = false;
      modelGroup.matrix.fromArray(bone.world);
    }
    for (const mesh of model.meshes) {
      let geometry = cache?.get(mesh) as THREE.BufferGeometry | undefined;
      if (!geometry) {
        geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
        if (mesh.normals) geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
        if (mesh.uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(mesh.uvs, 2));
        if (mesh.colors) geometry.setAttribute('color', new THREE.BufferAttribute(mesh.colors, 4, true));
        geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
        if (!mesh.normals) geometry.computeVertexNormals();
        geometry.computeBoundingSphere();
        cache?.set(mesh, geometry);
      }
      const material = materials[mesh.shaderIndex] ?? createMaterial(undefined, mesh.shaderIndex, store, opts);
      if (opts.vertexColors && mesh.colors) {
        // Vertex colours are per-geometry, so clone rather than mutate the shared material.
        const vc = material.clone();
        vc.vertexColors = true;
        if (material.userData.textureName) store.bind(vc, material.userData.textureName);
        modelGroup.add(new THREE.Mesh(geometry, vc));
      } else {
        modelGroup.add(new THREE.Mesh(geometry, material));
      }
    }
    group.add(modelGroup);
  }
  return group;
}

/** Applies render toggles to every material under `root`. */
export function applyRenderOptions(root: THREE.Object3D, opts: RenderOptions): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const m = mesh.material as THREE.MeshStandardMaterial | undefined;
    if (!m || !(m as THREE.Material).isMaterial || !m.userData || m.userData.shaderIndex === undefined) return;
    m.wireframe = opts.wireframe;
    m.side = opts.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
    m.needsUpdate = true;
  });
}

/** A wireframe box, used for bounds and for entities whose model couldn't be found. */
export function boxHelper(min: number[], max: number[], color: number): THREE.LineSegments {
  const box = new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));
  const helper = new THREE.Box3Helper(box, color);
  return helper;
}
