import { ResourceReader } from './reader';
import { readRsc7 } from './rsc7';
import { readBounds } from './bounds';
import type { ClothCollider, ClothData, Vec3, YldData } from '../shared/model';

/**
 * Cloth dictionaries (.yld): physics for ped clothing that moves (skirts,
 * coats, bandanas). Each character cloth has a controller with the simulated
 * mesh (vertices in ped model space, triangles, bone weights), a verlet
 * cloth with its distance constraints, and a composite bound of collision
 * shapes, one child per ped bone.
 */

const ROOT = 0x50000000;

export function parseYld(file: Uint8Array): YldData {
  const r = new ResourceReader(readRsc7(file));
  const hashes = r.list(ROOT + 0x20);
  const list = r.list(ROOT + 0x30);
  const cloths = r.ptrArray(list.items, list.count).map((ptr, i) => readCharacterCloth(r, ptr, i < hashes.count ? r.u32(hashes.items + i * 4) : 0));
  return { cloths: cloths.filter((c): c is ClothData => !!c) };
}

function readCharacterCloth(r: ResourceReader, ptr: number, hash: number): ClothData | undefined {
  if (!r.isValid(ptr)) return undefined;
  const controller = r.ptr(ptr + 0x20);
  if (!r.isValid(controller)) return undefined;
  const name = new TextDecoder().decode(r.bytes(controller + 0x58, 32)).replace(/\0.*$/s, '');

  // Controller: triangle indices, bind-pose vertices, bones of the pinned vertices.
  const idx = r.list(controller + 0x80);
  const indices = new Uint16Array(idx.count);
  for (let i = 0; i < idx.count; i++) indices[i] = r.u16(idx.items + i * 2);
  const boneList = r.list(controller + 0xe0);
  const boneTags = Array.from({ length: boneList.count }, (_, i) => r.u32(boneList.items + i * 4));

  // Verlet cloth: simulated vertices, constraints and the number of pinned vertices.
  const verlet = r.ptr(controller + 0x20);
  const vertexList = r.isValid(verlet) ? r.list(verlet + 0x80) : r.list(controller + 0x90);
  const positions = new Float32Array(vertexList.count * 3);
  for (let i = 0; i < vertexList.count; i++) positions.set(r.vec3(vertexList.items + i * 16), i * 3);
  const edges = r.isValid(verlet) ? readConstraints(r, verlet + 0x110) : new Uint16Array();
  const bendEdges = r.isValid(verlet) ? readConstraints(r, verlet + 0x100) : new Uint16Array();
  const pinned = r.isValid(verlet) ? Math.min(r.u32(verlet + 0xe8), vertexList.count) : 0;

  return {
    name,
    hash,
    positions,
    indices,
    edges,
    bendEdges,
    pinned,
    boneTags,
    colliders: readColliders(r, r.ptr(ptr + 0x28), r.list(ptr + 0x30)),
    ...extent(positions),
  };
}

/** Constraint lists: 16-byte items starting with two vertex indices. */
function readConstraints(r: ResourceReader, listPtr: number): Uint16Array {
  const l = r.list(listPtr);
  const out = new Uint16Array(l.count * 2);
  for (let i = 0; i < l.count; i++) {
    out[i * 2] = r.u16(l.items + i * 16);
    out[i * 2 + 1] = r.u16(l.items + i * 16 + 2);
  }
  return out;
}

/** The cloth's composite bound: child i follows bone `boneIds[i]`. */
function readColliders(r: ResourceReader, bound: number, boneIds: { items: number; count: number }): ClothCollider[] {
  if (!r.isValid(bound)) return [];
  const tag = (i: number) => (i < boneIds.count ? r.u32(boneIds.items + i * 4) : 0);
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (r.u8(bound + 0x10) !== 10) return [{ boneTag: tag(0), matrix: identity, bounds: readBounds(r, bound) }];
  const children = r.ptr(bound + 0x70);
  const xforms = r.ptr(bound + 0x78);
  const out: ClothCollider[] = [];
  for (let i = 0; i < r.u16(bound + 0xa0); i++) {
    const child = r.ptr(children + i * 8);
    if (!r.isValid(child)) continue;
    let matrix = identity;
    if (r.isValid(xforms)) {
      matrix = Array.from({ length: 16 }, (_, k) => r.f32(xforms + i * 64 + k * 4));
      matrix[3] = matrix[7] = matrix[11] = 0;
      matrix[15] = 1;
    }
    out.push({ boneTag: tag(i), matrix, bounds: readBounds(r, child) });
  }
  return out;
}

function extent(p: Float32Array): { bbMin: Vec3; bbMax: Vec3 } {
  const bbMin: Vec3 = [Infinity, Infinity, Infinity];
  const bbMax: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      bbMin[k] = Math.min(bbMin[k], p[i + k]);
      bbMax[k] = Math.max(bbMax[k], p[i + k]);
    }
  }
  return p.length ? { bbMin, bbMax } : { bbMin: [0, 0, 0], bbMax: [0, 0, 0] };
}
