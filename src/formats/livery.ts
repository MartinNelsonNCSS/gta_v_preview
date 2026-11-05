import type { DrawableData, LodLevel, ShaderData } from '../shared/model';

/*
 * Vehicle liveries.
 *
 * Vehicle paint shaders (vehicle_paint*) that carry a DiffuseSampler2 draw that
 * texture over the paint colour: the livery. The game picks livery N by
 * swapping the number at the end of the texture name, so a model referencing
 * `navaho_sign_2` has liveries `navaho_sign_1`, `navaho_sign_2`, … in its
 * texture dictionary. Liveries are mapped with the second UV set where the
 * mesh has one.
 */

/** Textures `<prefix><n>` (n ≥ 1) that a group of livery shaders switch between. */
export interface LiverySet {
  /** Lower-cased name without the trailing number, e.g. `navaho_sign_`; the whole name when unnumbered. */
  prefix: string;
  /** Whether the name ends in a number (only then can there be several liveries). */
  numbered: boolean;
  /** Texture the model itself references (lower case). */
  reference: string;
  /** Indices of the shaders that draw this livery. */
  shaders: number[];
}

/** Splits `navaho_sign_2` into prefix `navaho_sign_` and number 2. */
export function splitLiveryName(name: string): { prefix: string; index: number } | undefined {
  const m = /^(.*?)(\d+)$/.exec(name.toLowerCase());
  if (!m || !m[1]) return undefined;
  return { prefix: m[1], index: Number(m[2]) };
}

export function isLiveryShader(s: ShaderData): boolean {
  return !!s.diffuseIsOverlay && /^vehicle_paint/i.test(s.name);
}

/** Livery sets of a drawable, in shader order. */
export function liverySets(d: DrawableData): LiverySet[] {
  const sets = new Map<string, LiverySet>();
  d.shaders.forEach((s, i) => {
    if (!isLiveryShader(s) || !s.diffuse) return;
    const split = splitLiveryName(s.diffuse);
    const prefix = split?.prefix ?? s.diffuse;
    let set = sets.get(prefix);
    if (!set) sets.set(prefix, (set = { prefix, numbered: !!split, reference: s.diffuse, shaders: [] }));
    set.shaders.push(i);
  });
  return [...sets.values()];
}

/** Livery number of `name` within `set`, or undefined when it isn't one of its textures. */
export function liveryIndex(set: Pick<LiverySet, 'prefix' | 'numbered'>, name: string): number | undefined {
  const lower = name.toLowerCase();
  if (!set.numbered) return lower === set.prefix ? 1 : undefined;
  if (!lower.startsWith(set.prefix)) return undefined;
  const rest = lower.slice(set.prefix.length);
  return /^\d+$/.test(rest) ? Number(rest) : undefined;
}

/** Which paint colour a paint shader shows, as far as the shader name tells. */
export function paintRole(shaderName: string): string | undefined {
  const n = /^vehicle_paint(\d+)/i.exec(shaderName)?.[1];
  return n === '1' ? 'primary' : n === '2' ? 'secondary' : n === '3' ? 'livery over primary' : undefined;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** One livery-mapped mesh in model space. */
export interface LiveryMesh {
  positions: Float32Array;
  normals?: Float32Array;
  /** The UVs the livery is drawn with. */
  uvs: Float32Array;
  indices: Uint16Array | Uint32Array;
}

/** Meshes of `lod` drawn with one of `shaders`, moved into model space (rigid parts follow their bone). */
export function liveryMeshes(d: DrawableData, lod: LodLevel, shaders: number[]): LiveryMesh[] {
  const wanted = new Set(shaders);
  const out: LiveryMesh[] = [];
  for (const model of d.lods[lod]) {
    const bone = !model.skinned && model.boneIndex > 0 ? d.bones[model.boneIndex] : undefined;
    for (const mesh of model.meshes) {
      const uvs = mesh.uvs2 ?? mesh.uvs;
      if (!wanted.has(mesh.shaderIndex) || !uvs) continue;
      let positions = mesh.positions;
      let normals = mesh.normals;
      if (bone) {
        const m = bone.world;
        positions = new Float32Array(positions.length);
        for (let i = 0; i < positions.length; i += 3) {
          const [x, y, z] = [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]];
          positions[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
          positions[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
          positions[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        }
        if (mesh.normals) {
          normals = new Float32Array(mesh.normals.length);
          for (let i = 0; i < normals.length; i += 3) {
            const [x, y, z] = [mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]];
            normals[i] = m[0] * x + m[4] * y + m[8] * z;
            normals[i + 1] = m[1] * x + m[5] * y + m[9] * z;
            normals[i + 2] = m[2] * x + m[6] * y + m[10] * z;
          }
        }
      }
      out.push({ positions, normals, uvs, indices: mesh.indices });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Decals
// ---------------------------------------------------------------------------

export type Vec3 = [number, number, number];

export interface RgbaImage {
  width: number;
  height: number;
  /** width × height × 4 bytes, not premultiplied. */
  data: Uint8Array | Uint8ClampedArray;
}

/** An image projected onto the model along `normal`, centred on `position`. */
export interface Decal {
  position: Vec3;
  /** Points out of the surface; the image is projected against it. */
  normal: Vec3;
  /** Width in metres; the height follows the image's aspect ratio. */
  size: number;
  /** Degrees, clockwise as seen looking at the surface. */
  rotation: number;
  /** 0–1. */
  opacity: number;
  /** How far in front of and behind the surface it reaches, in metres. */
  depth: number;
  /** Also paints a copy on the other side of the vehicle (mirrored across x = 0, still readable). */
  mirror: boolean;
  /** Flips the image horizontally. */
  flip?: boolean;
  image: RgbaImage;
}

export interface DecalFrame {
  origin: Vec3;
  normal: Vec3;
  right: Vec3;
  up: Vec3;
  halfWidth: number;
  halfHeight: number;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * The decal's frame. "Up" follows the vehicle's up axis (z) unless the decal
 * faces straight up or down (a roof or bonnet), where it follows forward (y).
 */
export function decalFrame(d: Pick<Decal, 'position' | 'normal' | 'size' | 'rotation' | 'image'>): DecalFrame {
  const n = normalize(d.normal);
  const ref: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const r0 = normalize(cross(ref, n));
  const u0 = cross(n, r0);
  const a = (d.rotation * Math.PI) / 180;
  const [c, s] = [Math.cos(a), Math.sin(a)];
  const right: Vec3 = [r0[0] * c - u0[0] * s, r0[1] * c - u0[1] * s, r0[2] * c - u0[2] * s];
  const up: Vec3 = [u0[0] * c + r0[0] * s, u0[1] * c + r0[1] * s, u0[2] * c + r0[2] * s];
  const aspect = d.image.height / Math.max(1, d.image.width);
  return { origin: d.position, normal: n, right, up, halfWidth: d.size / 2, halfHeight: (d.size * aspect) / 2 };
}

/** Decals closer than this to x = 0 count as on the centreline (no mirrored copy). */
export const CENTRE_EPSILON = 1e-4;

/** The decal and, when mirrored, its copy on the other side. */
export function decalInstances(d: Decal): { decal: Decal; flip: boolean }[] {
  const list = [{ decal: d, flip: !!d.flip }];
  // On the centreline the copy would land on the decal itself.
  if (d.mirror && Math.abs(d.position[0]) > CENTRE_EPSILON) {
    const position: Vec3 = [-d.position[0], d.position[1], d.position[2]];
    const normal: Vec3 = [-d.normal[0], d.normal[1], d.normal[2]];
    // A fresh frame on the mirrored normal keeps text readable; the rotation mirrors.
    list.push({ decal: { ...d, position, normal, rotation: -d.rotation }, flip: !!d.flip });
  }
  return list;
}

/** Where `p` falls on the decal: u, v in 0–1 across the image (v down) and the distance along the normal. */
export function decalCoords(f: DecalFrame, p: Vec3): { u: number; v: number; dist: number } {
  const d: Vec3 = [p[0] - f.origin[0], p[1] - f.origin[1], p[2] - f.origin[2]];
  return { u: dot(d, f.right) / (2 * f.halfWidth) + 0.5, v: 0.5 - dot(d, f.up) / (2 * f.halfHeight), dist: dot(d, f.normal) };
}

/**
 * Paints decals into a livery texture (in place). Every livery triangle near a
 * decal is rasterised in texture space; each texel's model-space position is
 * projected onto the decal. Faces turned away from the decal aren't painted.
 * Returns how many texels each decal covered (0: it falls where the model has
 * no livery space, e.g. parts whose livery UVs are collapsed to a point).
 */
export function paintDecals(target: RgbaImage, meshes: LiveryMesh[], decals: Decal[]): number[] {
  const { width: W, height: H } = target;
  const out = target.data;
  const written = new Uint8Array(W * H);
  return decals.map((decal) => {
    let covered = 0;
    for (const { decal: inst, flip } of decalInstances(decal)) {
      written.fill(0);
      const f = decalFrame(inst);
      const reach = Math.hypot(f.halfWidth, f.halfHeight) + inst.depth;
      for (const mesh of meshes) covered += paintMesh(mesh, f, inst, flip, reach, W, H, out, written);
    }
    return covered;
  });
}

function paintMesh(
  mesh: LiveryMesh,
  f: DecalFrame,
  decal: Decal,
  flip: boolean,
  reach: number,
  W: number,
  H: number,
  out: Uint8Array | Uint8ClampedArray,
  written: Uint8Array
): number {
  let covered = 0;
  const { positions: P, normals: N, uvs: T, indices: I } = mesh;
  const [ox, oy, oz] = f.origin;
  const img = decal.image;
  const p: Vec3 = [0, 0, 0];
  for (let t = 0; t + 2 < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    // Reject triangles far from the decal (by their nearest vertex).
    let near = false;
    for (const v of [a, b, c]) {
      if (Math.hypot(P[v * 3] - ox, P[v * 3 + 1] - oy, P[v * 3 + 2] - oz) <= reach + 0.5) near = true;
    }
    if (!near) continue;
    // Facing: vertex normals when present (winding isn't reliable), else the face normal either way round.
    let facing: number;
    if (N) {
      const n: Vec3 = [N[a * 3] + N[b * 3] + N[c * 3], N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1], N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2]];
      facing = dot(normalize(n), f.normal);
    } else {
      const e1: Vec3 = [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]];
      const e2: Vec3 = [P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]];
      facing = Math.abs(dot(normalize(cross(e1, e2)), f.normal));
    }
    if (facing < 0.2) continue;

    // Texel-space triangle (D3D UVs: origin top-left).
    const x0 = T[a * 2] * W, y0 = T[a * 2 + 1] * H;
    const x1 = T[b * 2] * W, y1 = T[b * 2 + 1] * H;
    const x2 = T[c * 2] * W, y2 = T[c * 2 + 1] * H;
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-9) continue;
    // Reach 0.75 texel past each edge so neighbouring islands don't leave seams.
    const pad = 0.75;
    const minX = Math.floor(Math.min(x0, x1, x2) - pad), maxX = Math.ceil(Math.max(x0, x1, x2) + pad);
    const minY = Math.floor(Math.min(y0, y1, y2) - pad), maxY = Math.ceil(Math.max(y0, y1, y2) + pad);
    if ((maxX - minX) * (maxY - minY) > W * H * 4) continue; // degenerate UVs
    const l0 = Math.hypot(x2 - x1, y2 - y1), l1 = Math.hypot(x0 - x2, y0 - y2), l2 = Math.hypot(x1 - x0, y1 - y0);
    const sign = area > 0 ? 1 : -1;
    for (let y = minY; y < maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x < maxX; x++) {
        const px = x + 0.5;
        // Edge functions → barycentrics; distances (in texels) to each edge.
        const e0 = ((x2 - x1) * (py - y1) - (y2 - y1) * (px - x1)) * sign;
        const e1 = ((x0 - x2) * (py - y2) - (y0 - y2) * (px - x2)) * sign;
        const e2 = ((x1 - x0) * (py - y0) - (y1 - y0) * (px - x0)) * sign;
        if (e0 < -pad * l0 || e1 < -pad * l1 || e2 < -pad * l2) continue;
        const sum = Math.abs(area);
        let w0 = e0 / sum, w1 = e1 / sum, w2 = e2 / sum;
        if (w0 < 0 || w1 < 0 || w2 < 0) {
          w0 = Math.max(0, w0);
          w1 = Math.max(0, w1);
          w2 = Math.max(0, w2);
          const s = w0 + w1 + w2 || 1;
          w0 /= s;
          w1 /= s;
          w2 /= s;
        }
        const tx = ((x % W) + W) % W, ty = ((y % H) + H) % H;
        const ti = ty * W + tx;
        if (written[ti]) continue;
        p[0] = w0 * P[a * 3] + w1 * P[b * 3] + w2 * P[c * 3];
        p[1] = w0 * P[a * 3 + 1] + w1 * P[b * 3 + 1] + w2 * P[c * 3 + 1];
        p[2] = w0 * P[a * 3 + 2] + w1 * P[b * 3 + 2] + w2 * P[c * 3 + 2];
        const { u, v, dist } = decalCoords(f, p);
        if (u < 0 || u > 1 || v < 0 || v > 1 || Math.abs(dist) > decal.depth) continue;
        written[ti] = 1;
        covered++;
        blend(out, ti * 4, img, flip ? 1 - u : u, v, decal.opacity);
      }
    }
  }
  return covered;
}

/** Bilinear sample of `img` at (u, v), composited "over" the texel at `o`. */
function blend(out: Uint8Array | Uint8ClampedArray, o: number, img: RgbaImage, u: number, v: number, opacity: number): void {
  const fx = Math.min(img.width - 1, Math.max(0, u * img.width - 0.5));
  const fy = Math.min(img.height - 1, Math.max(0, v * img.height - 0.5));
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const jx = Math.min(img.width - 1, ix + 1), jy = Math.min(img.height - 1, iy + 1);
  const ax = fx - ix, ay = fy - iy;
  const d = img.data;
  const s = [0, 0, 0, 0];
  // Weight colour by alpha so transparent texels don't bleed their colour.
  for (const [px, py, w] of [
    [ix, iy, (1 - ax) * (1 - ay)],
    [jx, iy, ax * (1 - ay)],
    [ix, jy, (1 - ax) * ay],
    [jx, jy, ax * ay],
  ] as const) {
    const i = (py * img.width + px) * 4;
    const al = (d[i + 3] / 255) * w;
    s[0] += d[i] * al;
    s[1] += d[i + 1] * al;
    s[2] += d[i + 2] * al;
    s[3] += al;
  }
  if (s[3] <= 0) return;
  const sa = s[3] * opacity;
  const da = out[o + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  for (let k = 0; k < 3; k++) {
    const sc = s[k] / s[3];
    out[o + k] = Math.round((sc * sa + out[o + k] * da * (1 - sa)) / oa);
  }
  out[o + 3] = Math.round(oa * 255);
}

// ---------------------------------------------------------------------------
// carvariations.meta
// ---------------------------------------------------------------------------

/** A change to a vehicle's liveries, for its carvariations.meta. */
export type LiveryChange = { added: number } | { removed: number };

/**
 * Keeps the per-colour livery lists of `model` in a carvariations.meta in step
 * with its liveries. Each list says which liveries a car spawned with that
 * colour combination may get (scripts can still set any livery); an empty or
 * self-closed list is left alone.
 *
 * - After adding (the new count): shorter lists are padded with "not allowed",
 *   or with "allowed" when every entry already is, so colour-to-livery pairings
 *   stay as they were.
 * - After removing livery n (1-based): its entry is dropped so later ones keep
 *   their livery, and a "not allowed" goes on the end to keep the list's length.
 *
 * `emptied` counts colour combinations that allowed a livery before and none
 * after. Returns undefined when the model isn't in the file.
 */
export function updateVariationLiveries(xml: string, model: string, change: LiveryChange): { text: string; changed: number; emptied: number } | undefined {
  const items = [...xml.matchAll(/<Item>\s*<modelName>\s*([^<\s]+)\s*<\/modelName>[\s\S]*?(?=<Item>\s*<modelName>|<\/variationData>|$)/gi)];
  const item = items.find((m) => m[1].toLowerCase() === model.toLowerCase());
  if (!item || item.index === undefined) return undefined;
  let changed = 0;
  let emptied = 0;
  const block = item[0].replace(/(<liveries>)([\s\S]*?)(<\/liveries>)/gi, (whole, open: string, body: string, close: string) => {
    const entries = [...body.matchAll(/<Item\s+value="(true|false)"\s*\/>/gi)].map((m) => m[1].toLowerCase());
    if (!entries.length) return whole;
    const fill = entries.every((v) => v === 'true') ? 'true' : 'false';
    let next = entries;
    if ('added' in change && entries.length < change.added) next = [...entries, ...Array<string>(change.added - entries.length).fill(fill)];
    if ('removed' in change && entries.length >= change.removed) next = [...entries.filter((_, i) => i !== change.removed - 1), fill];
    if (next.join() === entries.join()) return whole;
    changed++;
    if (entries.includes('true') && !next.includes('true')) emptied++;
    const indent = /\n([ \t]*)<Item/.exec(body)?.[1] ?? '            ';
    const closeIndent = /\n([ \t]*)$/.exec(body)?.[1] ?? '';
    const eol = body.includes('\r\n') ? '\r\n' : '\n'; // keep the file's line endings
    return `${open}${eol}${next.map((v) => `${indent}<Item value="${v}" />`).join(eol)}${eol}${closeIndent}${close}`;
  });
  return { text: xml.slice(0, item.index) + block + xml.slice(item.index + item[0].length), changed, emptied };
}
