import * as THREE from 'three';
import type { AnimationInfo, AnimTrack, BoneData, ClipInfo, DrawableData, LodLevel } from '../shared/model';
import { PED_BONES } from '../formats/pedSkeleton';
import { buildDrawable, RenderOptions, TextureStore } from './scene';

export const TRACK_NAMES: Record<number, string> = {
  0: 'Position',
  1: 'Rotation',
  2: 'Scale',
  5: 'Mover position',
  6: 'Mover rotation',
  7: 'Camera position',
  8: 'Camera rotation',
};

export const trackName = (track: number) => TRACK_NAMES[track] ?? `Track ${track}`;

/** Bone transforms of one animation frame (only the animated parts). */
export interface Pose {
  position: Map<number, THREE.Vector3>;
  rotation: Map<number, THREE.Quaternion>;
  moverPosition?: THREE.Vector3;
  moverRotation?: THREE.Quaternion;
}

/** Length of a clip in seconds of animation time. */
export function clipLength(clip: ClipInfo, anim: AnimationInfo): number {
  const end = clip.end > clip.start ? clip.end : anim.duration;
  return Math.max(0, Math.min(end, anim.duration + 1 / 30) - clip.start);
}

/** Samples an animation `time` seconds into a clip, interpolating between frames. */
export function samplePose(anim: AnimationInfo, clip: ClipInfo, time: number): Pose {
  const animTime = clip.start + time;
  const last = Math.max(0, anim.frames - 1);
  const f = anim.duration > 0 ? Math.min(last, Math.max(0, (animTime / anim.duration) * last)) : 0;
  const f0 = Math.floor(f);
  const f1 = Math.min(last, f0 + 1);
  const k = f - f0;
  const pose: Pose = { position: new Map(), rotation: new Map() };
  for (const t of anim.tracks) {
    if (t.components === 3 && (t.track === 0 || t.track === 5)) {
      const v = vec(t, f0).lerp(vec(t, f1), k);
      if (t.track === 0) pose.position.set(t.boneId, v);
      else if (t.boneId === 0) pose.moverPosition = v;
    } else if (t.components === 4 && (t.track === 1 || t.track === 6)) {
      const q = quat(t, f0).slerp(quat(t, f1), k);
      if (t.track === 1) pose.rotation.set(t.boneId, q);
      else if (t.boneId === 0) pose.moverRotation = q;
    }
  }
  return pose;
}

const vec = (t: AnimTrack, f: number) => new THREE.Vector3(t.values[f * 3], t.values[f * 3 + 1], t.values[f * 3 + 2]);
const quat = (t: AnimTrack, f: number) => new THREE.Quaternion(t.values[f * 4], t.values[f * 4 + 1], t.values[f * 4 + 2], t.values[f * 4 + 3]).normalize();

/** Something that can show a pose. */
export interface Rig {
  readonly object: THREE.Object3D;
  /** Bone tags this rig can move. */
  readonly tags: Set<number>;
  apply(pose: Pose, rootMotion: boolean): void;
  setBonesVisible?(v: boolean): void;
}

// ---------------------------------------------------------------------------
// Built-in ped skeleton, drawn as a stick figure
// ---------------------------------------------------------------------------

const LIMB = 0x4f8fdb;
const LEFT = 0x5cb85c;
const RIGHT = 0xd9534f;
const JOINT = 0xe8e8e8;

/** A stick-figure ped built from the standard skeleton. */
export class PedRig implements Rig {
  readonly object = new THREE.Group();
  readonly tags = new Set(PED_BONES.map((b) => b.tag));
  private readonly nodes = new Map<number, THREE.Object3D>();
  /** Segment meshes from each bone's parent joint to the bone's joint. */
  private readonly segments: { mesh: THREE.Mesh; node: THREE.Object3D; radius: number }[] = [];
  private readonly mover = new THREE.Group();

  constructor() {
    this.object.add(this.mover);
    const cylinder = new THREE.CylinderGeometry(1, 0.7, 1, 10, 1);
    cylinder.translate(0, 0.5, 0); // from the parent joint (y = 0) to the child joint (y = 1)
    const sphere = new THREE.SphereGeometry(1, 14, 10);
    const materials = new Map<number, THREE.Material>();
    const material = (color: number) => {
      let m = materials.get(color);
      if (!m) materials.set(color, (m = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05 })));
      return m;
    };

    for (const b of PED_BONES) {
      const node = new THREE.Object3D();
      node.name = b.name;
      node.position.fromArray(b.offset);
      node.quaternion.fromArray(b.rotation).normalize();
      node.userData.rest = { position: node.position.clone(), quaternion: node.quaternion.clone() };
      this.nodes.set(b.tag, node);
      const parent = this.nodes.get(b.parent);
      (parent ?? this.mover).add(node);

      const finger = /Finger/.test(b.name);
      const side = /_L_/.test(b.name) ? LEFT : /_R_/.test(b.name) ? RIGHT : LIMB;
      const radius = finger ? 0.007 : /Toe|Hand|Neck/.test(b.name) ? 0.022 : /Spine|Pelvis/.test(b.name) ? 0.05 : 0.035;
      if (parent && b.parent !== 0) {
        // The segment lives in the parent's space and spans to this bone's origin.
        const mesh = new THREE.Mesh(cylinder, material(finger ? JOINT : side));
        parent.add(mesh);
        this.segments.push({ mesh, node, radius });
      }
      const joint = new THREE.Mesh(sphere, material(JOINT));
      joint.scale.setScalar(finger ? 0.008 : radius * 0.9);
      node.add(joint);
    }
    // Head and a hint of the toes' direction.
    const head = this.nodes.get(31086);
    if (head) {
      const skull = new THREE.Mesh(sphere, material(LIMB));
      skull.scale.set(0.11, 0.085, 0.08);
      skull.position.set(0.08, 0.02, 0);
      head.add(skull);
      const nose = new THREE.Mesh(sphere, material(JOINT));
      nose.scale.setScalar(0.02);
      nose.position.set(0.08, 0.1, 0);
      head.add(nose);
    }
    this.updateSegments();
  }

  apply(pose: Pose, rootMotion: boolean): void {
    for (const [tag, node] of this.nodes) {
      const rest = node.userData.rest as { position: THREE.Vector3; quaternion: THREE.Quaternion };
      // Position tracks (when a clip has them) override the default bone offsets.
      node.position.copy(pose.position.get(tag) ?? rest.position);
      node.quaternion.copy(pose.rotation.get(tag) ?? rest.quaternion);
    }
    this.mover.position.copy(rootMotion && pose.moverPosition ? pose.moverPosition : new THREE.Vector3());
    this.mover.quaternion.copy(rootMotion && pose.moverRotation ? pose.moverRotation : new THREE.Quaternion());
    this.updateSegments();
  }

  private updateSegments(): void {
    const up = new THREE.Vector3(0, 1, 0);
    for (const s of this.segments) {
      const d = s.node.position;
      const len = d.length();
      s.mesh.visible = len > 1e-4;
      if (!s.mesh.visible) continue;
      s.mesh.quaternion.setFromUnitVectors(up, d.clone().divideScalar(len));
      s.mesh.scale.set(s.radius, len, s.radius);
    }
  }
}

// ---------------------------------------------------------------------------
// Real models (vehicles, props) whose parts follow their skeleton's bones
// ---------------------------------------------------------------------------

/**
 * Animates a drawable's rigid parts: each model is attached to one bone, so
 * moving the bones moves the parts (doors, roofs, prop pieces). Skinned
 * meshes stay in their bind pose.
 */
export class ModelRig implements Rig {
  readonly object = new THREE.Group();
  readonly tags: Set<number>;
  private readonly nodes: THREE.Object3D[] = [];
  private readonly parts: { group: THREE.Object3D; bone: number }[] = [];
  private readonly mover = new THREE.Group();
  private readonly inverseRootBind: THREE.Matrix4;
  private readonly skeleton = new THREE.Group();
  private readonly bones: BoneData[];

  constructor(d: DrawableData, lod: LodLevel, store: TextureStore, opts: RenderOptions) {
    this.bones = d.bones;
    this.tags = new Set(d.bones.map((b) => b.tag));
    this.object.add(this.mover);
    const content = buildDrawable(d, lod, store, opts);
    this.mover.add(content);
    d.lods[lod].forEach((m, i) => {
      const group = content.children[i];
      if (!group || m.skinned) return;
      group.matrixAutoUpdate = false;
      this.parts.push({ group, bone: m.boneIndex });
    });

    // A parallel hierarchy of bones gives each bone's animated model-space matrix.
    for (const b of d.bones) {
      const node = new THREE.Object3D();
      if (b.translation && b.rotation) {
        node.position.fromArray(b.translation);
        node.quaternion.fromArray(b.rotation).normalize();
        if (b.scale) node.scale.fromArray(b.scale.map((v) => (Number.isFinite(v) && v !== 0 ? v : 1)));
      } else {
        // Older data without rest transforms: derive from the world matrices.
        const world = new THREE.Matrix4().fromArray(b.world);
        const parentWorld = b.parent >= 0 && d.bones[b.parent] ? new THREE.Matrix4().fromArray(d.bones[b.parent].world) : new THREE.Matrix4();
        parentWorld.invert().multiply(world).decompose(node.position, node.quaternion, node.scale);
      }
      node.userData.rest = { position: node.position.clone(), quaternion: node.quaternion.clone() };
      (b.parent >= 0 ? this.nodes[b.parent] ?? this.skeleton : this.skeleton).add(node);
      this.nodes.push(node);
    }
    this.inverseRootBind = d.bones[0] ? new THREE.Matrix4().fromArray(d.bones[0].world).invert() : new THREE.Matrix4();
    this.apply({ position: new Map(), rotation: new Map() }, false);
  }

  apply(pose: Pose, rootMotion: boolean): void {
    this.bones.forEach((b, i) => {
      const node = this.nodes[i];
      const rest = node.userData.rest as { position: THREE.Vector3; quaternion: THREE.Quaternion };
      node.position.copy(pose.position.get(b.tag) ?? rest.position);
      node.quaternion.copy(pose.rotation.get(b.tag) ?? rest.quaternion);
    });
    this.skeleton.updateMatrixWorld(true);
    for (const p of this.parts) {
      const node = this.nodes[p.bone];
      if (!node) continue;
      // Parts on bone 0 are stored in model space; others relative to their bone.
      if (p.bone > 0) p.group.matrix.copy(node.matrixWorld);
      else p.group.matrix.multiplyMatrices(node.matrixWorld, this.inverseRootBind);
      p.group.matrixWorldNeedsUpdate = true;
    }
    this.mover.position.copy(rootMotion && pose.moverPosition ? pose.moverPosition : new THREE.Vector3());
    this.mover.quaternion.copy(rootMotion && pose.moverRotation ? pose.moverRotation : new THREE.Quaternion());
  }
}

/** Animated bone tags (position/rotation tracks), excluding the root. */
export function animatedBones(anim: AnimationInfo): Set<number> {
  return new Set(anim.tracks.filter((t) => (t.track === 0 || t.track === 1) && t.boneId !== 0).map((t) => t.boneId));
}
