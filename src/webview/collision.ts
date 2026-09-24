import * as THREE from 'three';
import type { BoundsData, CollisionPrimitive, Vec3 } from '../shared/model';

/** Stable, well-spread colour per collision material index. */
export function materialColor(index: number): THREE.Color {
  // Golden-angle hues, with lightness/saturation steps so neighbours in hue still differ.
  return new THREE.Color().setHSL(((index * 137.508) % 360) / 360, 0.45 + 0.2 * (index % 2), 0.42 + 0.14 * (index % 3));
}

export interface CollisionOptions {
  wireframe: boolean;
  triangles: boolean;
  primitives: boolean;
  /** Draw semi-transparent so the model underneath stays visible. */
  overlay?: boolean;
  hiddenMaterials?: Set<number>;
}

/** What was hit when picking a collision object. */
export interface CollisionHit {
  kind: string;
  material: number;
}

type Lookup = (hit: THREE.Intersection) => CollisionHit | undefined;

/**
 * Builds a three.js group for collision bounds. Triangles are one mesh with
 * per-face material colours; primitives use instancing where possible.
 * Each child has `userData.lookup` to identify what a raycast hit.
 */
export function buildCollision(b: BoundsData, opts: CollisionOptions): THREE.Group {
  const group = new THREE.Group();
  const hidden = opts.hiddenMaterials ?? new Set<number>();
  const material = (vertexColors: boolean) =>
    new THREE.MeshLambertMaterial({
      vertexColors,
      side: THREE.DoubleSide,
      wireframe: opts.wireframe,
      transparent: !!opts.overlay,
      opacity: opts.overlay ? 0.45 : 1,
      depthWrite: !opts.overlay,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });

  if (opts.triangles && b.triangles) {
    // Keep only visible triangles, remembering where each came from.
    const keep: number[] = [];
    for (let i = 0; i < b.triangles; i++) if (!hidden.has(b.triangleMaterials[i])) keep.push(i);
    if (keep.length) {
      const pos = new Float32Array(keep.length * 9);
      const col = new Float32Array(keep.length * 9);
      keep.forEach((t, i) => {
        pos.set(b.positions.subarray(t * 9, t * 9 + 9), i * 9);
        const c = materialColor(b.triangleMaterials[t]);
        for (let v = 0; v < 3; v++) col.set([c.r, c.g, c.b], i * 9 + v * 3);
      });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, material(true));
      const lookup: Lookup = (hit) =>
        hit.faceIndex === undefined || hit.faceIndex === null ? undefined : { kind: 'triangle', material: b.triangleMaterials[keep[hit.faceIndex]] };
      mesh.userData.lookup = lookup;
      group.add(mesh);
    }
  }

  if (opts.primitives) {
    const prims = b.primitives.filter((p) => !hidden.has(p.material));
    addInstanced(group, prims, 'sphere', new THREE.SphereGeometry(1, 16, 12), material, sphereMatrix);
    addInstanced(group, prims, 'box', new THREE.BoxGeometry(2, 2, 2), material, boxMatrix);
    addInstanced(group, prims, 'cylinder', new THREE.CylinderGeometry(1, 1, 1, 16), material, cylinderMatrix);
    // Capsule shape depends on its radius/length ratio, so each gets its own geometry.
    for (const p of prims) {
      if (p.kind !== 'capsule') continue;
      const len = dist(p.a, p.b);
      const m = material(false);
      m.color.copy(materialColor(p.material));
      const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(p.radius, len, 4, 12), m);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(alongSegment(p.a, p.b, 1, 1));
      const lookup: Lookup = () => ({ kind: 'capsule', material: p.material });
      mesh.userData.lookup = lookup;
      group.add(mesh);
    }
  }
  return group;
}

function addInstanced(
  group: THREE.Group,
  all: CollisionPrimitive[],
  kind: CollisionPrimitive['kind'],
  geometry: THREE.BufferGeometry,
  material: (vc: boolean) => THREE.Material,
  matrixFor: (p: CollisionPrimitive) => THREE.Matrix4
) {
  const prims = all.filter((p) => p.kind === kind);
  if (!prims.length) {
    geometry.dispose();
    return;
  }
  const mesh = new THREE.InstancedMesh(geometry, material(false), prims.length);
  prims.forEach((p, i) => {
    mesh.setMatrixAt(i, matrixFor(p));
    mesh.setColorAt(i, materialColor(p.material));
  });
  mesh.computeBoundingSphere();
  mesh.computeBoundingBox();
  const lookup: Lookup = (hit) => (hit.instanceId === undefined ? undefined : { kind, material: prims[hit.instanceId].material });
  mesh.userData.lookup = lookup;
  group.add(mesh);
}

const v3 = (v: Vec3) => new THREE.Vector3(v[0], v[1], v[2]);
const dist = (a: Vec3, b: Vec3) => v3(a).distanceTo(v3(b));

function sphereMatrix(p: CollisionPrimitive): THREE.Matrix4 {
  const s = p.kind === 'sphere' ? p.radius : 1;
  return new THREE.Matrix4().makeScale(s, s, s).setPosition(v3((p as { center: Vec3 }).center));
}

function boxMatrix(p: CollisionPrimitive): THREE.Matrix4 {
  if (p.kind !== 'box') return new THREE.Matrix4();
  return new THREE.Matrix4().makeBasis(v3(p.axes[0]), v3(p.axes[1]), v3(p.axes[2])).setPosition(v3(p.center));
}

function cylinderMatrix(p: CollisionPrimitive): THREE.Matrix4 {
  if (p.kind !== 'cylinder') return new THREE.Matrix4();
  return alongSegment(p.a, p.b, p.radius, dist(p.a, p.b));
}

/** Transform placing a Y-aligned unit shape between `a` and `b`. */
function alongSegment(a: Vec3, b: Vec3, radius: number, length: number): THREE.Matrix4 {
  const va = v3(a);
  const vb = v3(b);
  const dir = vb.clone().sub(va);
  const q = dir.lengthSq() > 1e-12 ? new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()) : new THREE.Quaternion();
  return new THREE.Matrix4().compose(va.add(vb).multiplyScalar(0.5), q, new THREE.Vector3(radius, length, radius));
}
