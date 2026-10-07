import { ResourceReader } from './reader';
import { readRsc7 } from './rsc7';
import { joaat } from './hash';
import type { AnimationInfo, AnimTrack, ClipDictionaryData, ClipInfo } from '../shared/model';

/**
 * Clip dictionaries (.ycd): named clips that play time ranges of animations.
 * An animation stores per-bone tracks (track 0 = position, 1 = rotation,
 * 5/6 = mover position/rotation, others = facial/UV/etc.) split into
 * sequences of up to `sequenceFrameLimit` frames, each compressed with a mix
 * of channel types (static, raw, quantized, indirect-quantized, linear-delta).
 */

const ROOT = 0x50000000;

export type { AnimTrack, AnimationInfo, ClipInfo, ClipDictionaryData };

/** Parses a .ycd file. */
export function parseYcd(file: Uint8Array): ClipDictionaryData {
  const r = new ResourceReader(readRsc7(file));
  const animations: AnimationInfo[] = [];
  const animIndex = new Map<number, number>();

  const readAnim = (ptr: number, hash: number): number => {
    if (animIndex.has(ptr)) return animIndex.get(ptr)!;
    const a = readAnimation(r, ptr, hash);
    animations.push(a);
    animIndex.set(ptr, animations.length - 1);
    return animations.length - 1;
  };

  // Animation hash map.
  const animMap = r.ptr(ROOT + 0x18);
  if (r.isValid(animMap)) {
    for (const entry of hashMapEntries(r, r.ptr(animMap + 0x18), r.u16(animMap + 0x20))) {
      const animPtr = r.ptr(entry + 0x08);
      if (r.isValid(animPtr)) readAnim(animPtr, r.u32(entry));
    }
  }

  // Clip hash map.
  const clips: ClipInfo[] = [];
  for (const entry of hashMapEntries(r, r.ptr(ROOT + 0x28), r.u16(ROOT + 0x30))) {
    const clipPtr = r.ptr(entry + 0x08);
    if (!r.isValid(clipPtr)) continue;
    const type = r.u32(clipPtr + 0x10);
    const name = (r.string(r.ptr(clipPtr + 0x18)) ?? `clip_${r.u32(entry).toString(16)}`).replace(/^pack:\//i, '').replace(/\.clip$/i, '');
    let animation = -1;
    let start = 0;
    let end = 0;
    let rate = 1;
    if (type === 1) {
      const animPtr = r.ptr(clipPtr + 0x50);
      if (r.isValid(animPtr)) animation = readAnim(animPtr, 0);
      start = r.f32(clipPtr + 0x58);
      end = r.f32(clipPtr + 0x5c);
      rate = r.f32(clipPtr + 0x60);
    } else if (type === 2) {
      // Animation list: preview the first animation.
      const listPtr = r.ptr(clipPtr + 0x50);
      const count = r.u16(clipPtr + 0x58);
      end = r.f32(clipPtr + 0x60);
      if (r.isValid(listPtr) && count) {
        const animPtr = r.ptr(listPtr + 0x10);
        if (r.isValid(animPtr)) animation = readAnim(animPtr, 0);
        start = r.f32(listPtr);
        end = r.f32(listPtr + 4) || end;
        rate = r.f32(listPtr + 8) || 1;
      }
    }
    clips.push({ name, animation, start, end, rate, tags: safe(() => readTags(r, r.ptr(clipPtr + 0x38)), []), properties: safe(() => readProperties(r, r.ptr(clipPtr + 0x40)), []) });
  }
  clips.sort((a, b) => a.name.localeCompare(b.name));
  return { clips, animations };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Entries of a RAGE hash map: an array of bucket pointers, each a linked list (next at +0x10). */
function hashMapEntries(r: ResourceReader, buckets: number, capacity: number): number[] {
  const out: number[] = [];
  if (!r.isValid(buckets)) return out;
  for (let i = 0; i < capacity; i++) {
    let e = r.ptr(buckets + i * 8);
    for (let guard = 0; r.isValid(e) && guard < 10000; guard++) {
      out.push(e);
      e = r.ptr(e + 0x10);
    }
  }
  return out;
}

/** Common clip tag / property names (hashed case-sensitively in clips). */
const CLIP_NAMES = new Map<number, string>();
for (const n of [
  'AudioEvent', 'Foot', 'Flip', 'MoveEvent', 'Object', 'VisemeEvent', 'Blocking', 'BlendOutWithDuration', 'Interruptible',
  'WalkInterruptible', 'Facial', 'SectionTransition', 'Door', 'Camera', 'CameraShake', 'Event', 'Ik', 'IkControl',
  'ArmsIk', 'LegsIk', 'LookIk', 'PadShake', 'Particle', 'Prop', 'Sound', 'Weapon', 'WeaponDrop', 'WeaponGrip',
  'Melee', 'MeleeCollision', 'MeleeContact', 'MeleeFacialAnim', 'MeleeHoming', 'MeleeInvulnerability', 'CriticalFrame',
  'FirstPersonCamera', 'FirstPersonCameraInput', 'ApplyForce', 'BlockTransition', 'Look', 'Dialogue', 'MoverFixup',
  'Mover', 'Phase', 'Index', 'Visemes', 'Notes', 'RootMotion', 'BoneId', 'Heel', 'Right', 'Left', 'Track',
  'FPS_Frame', 'Compressionfile_DO_NOT_RESOURCE', 'SourceDataFile_DO_NOT_RESOURCE', 'UsedAsDofTracker_DO_NOT_RESOURCE',
  'DelayedBlendIn', 'BlendIn', 'BlendOut', 'GestureControl', 'ClipBlendWeight', 'AlternateDrawable', 'CutsceneEnterExit',
  'FacialAnimationNames', 'ExitPoint', 'HandIk', 'ObjectVfx', 'Smash', 'TagSyncBlendOut',
]) {
  CLIP_NAMES.set(joaat(n, false), n);
  CLIP_NAMES.set(joaat(n), n);
}
const clipName = (hash: number) => CLIP_NAMES.get(hash) ?? `hash_${hash.toString(16).padStart(8, '0')}`;

function readTags(r: ResourceReader, ptr: number): ClipInfo['tags'] {
  // Tag list: pointer array at +0x00, count at +0x08. A tag is a property (name hash at +0x18) plus start/end phase.
  if (!r.isValid(ptr)) return [];
  const out: ClipInfo['tags'] = [];
  for (const t of r.ptrArray(r.ptr(ptr), Math.min(r.u16(ptr + 0x08), 256))) {
    if (r.isValid(t)) out.push({ name: clipName(r.u32(t + 0x18)), start: r.f32(t + 0x40), end: r.f32(t + 0x44) });
  }
  return out;
}

function readProperties(r: ResourceReader, ptr: number): string[] {
  // Property map: bucket array at +0x00, capacity at +0x08.
  if (!r.isValid(ptr)) return [];
  return hashMapEntries(r, r.ptr(ptr), r.u16(ptr + 0x08)).map((e) => clipName(r.u32(e)));
}

// ---------------------------------------------------------------------------
// Animations
// ---------------------------------------------------------------------------

function readAnimation(r: ResourceReader, ptr: number, hash: number): AnimationInfo {
  const frames = r.u16(ptr + 0x14);
  const limit = Math.max(1, r.u16(ptr + 0x16));
  const duration = r.f32(ptr + 0x18);
  const seqList = r.list(ptr + 0x40);
  const boneList = r.list(ptr + 0x50);
  const bones: { boneId: number; track: number }[] = [];
  for (let i = 0; i < boneList.count; i++) bones.push({ boneId: r.u16(boneList.items + i * 4), track: r.u8(boneList.items + i * 4 + 3) });

  // Decode every sequence block, then stitch per-bone values across blocks.
  const blocks = r.ptrArray(seqList.items, seqList.count).map((p) => {
    try {
      return decodeSequence(r, p);
    } catch {
      return { channels: [], numFrames: 0 } as DecodedBlock;
    }
  });
  const tracks: AnimTrack[] = bones.map((b, i) => {
    const sample = blocks.find((blk) => blk.channels[i])?.channels[i];
    const components = sample ? componentsOf(sample, b.track) : b.track === 1 || b.track === 6 ? 4 : 3;
    const values = new Float32Array(Math.max(1, frames) * components);
    for (let f = 0; f < Math.max(1, frames); f++) {
      const blk = blocks[Math.min(blocks.length - 1, Math.floor(f / limit))];
      const local = f % limit;
      const v = blk ? evaluate(blk.channels[i], local, components) : undefined;
      if (v) values.set(v, f * components);
      else if (components === 4) values[f * 4 + 3] = 1;
    }
    return { boneId: b.boneId, track: b.track, components, values };
  });
  return { hash, frames, duration, tracks };
}

// -- channel decoding ----------------------------------------------------------------

const enum CT {
  StaticQuaternion = 0,
  StaticVector3 = 1,
  StaticFloat = 2,
  RawFloat = 3,
  QuantizeFloat = 4,
  IndirectQuantizeFloat = 5,
  LinearFloat = 6,
  CachedQuaternion1 = 7,
  CachedQuaternion2 = 8,
}

interface Channel {
  type: CT;
  /** Per-frame values (for animated float channels) or a constant. */
  values?: Float32Array;
  constant?: number[];
  /** For cached quaternions: which component is reconstructed. */
  quatIndex?: number;
}

/** Channels per bone (sequence) index, each list indexed by channel slot. */
interface DecodedBlock {
  channels: (Channel | undefined)[][];
  numFrames: number;
}

class BitReader {
  bit = 0;
  constructor(private readonly data: Uint8Array) {}
  get(start: number, length: number): number {
    let result = 0;
    for (let i = 0; i < length; i++) {
      const pos = start + i;
      const byte = this.data[pos >> 3] ?? 0;
      if ((byte >> (pos & 7)) & 1) result += 2 ** i;
    }
    return result;
  }
  read(length: number): number {
    const v = this.get(this.bit, length);
    this.bit += length;
    return v;
  }
}

function decodeSequence(r: ResourceReader, ptr: number): DecodedBlock {
  const dataLength = r.u32(ptr + 0x04);
  const frameOffset = r.u32(ptr + 0x0c);
  const numFrames = r.u16(ptr + 0x16);
  const frameLength = r.u16(ptr + 0x18);
  const chunkSize = r.u8(ptr + 0x1e) || 255;
  const data = r.bytes(ptr + 0x20, dataLength);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const bits = new BitReader(data);

  let position = 0; // channel parameter stream
  const readI32 = () => ((position += 4), dv.getInt32(position - 4, true));
  const readF32 = () => ((position += 4), dv.getFloat32(position - 4, true));
  let listOffset = frameOffset + frameLength * numFrames; // 9 channel counts
  let dataBitsOffset = listOffset + 9 * 2; // per-channel (sequence, index) words

  type Pending = { channel: Channel; seq: number; index: number; frameBits: number; read?: (frameBit: () => number, f: number) => void };
  const byType: Pending[][] = [];
  for (let type = 0; type < 9; type++) {
    const count = dv.getUint16(listOffset, true);
    listOffset += 2;
    const list: Pending[] = [];
    for (let c = 0; c < count; c++) {
      const word = dv.getUint16(dataBitsOffset, true);
      dataBitsOffset += 2;
      let seq = word >> 2;
      let index = word & 3;
      const channel: Channel = { type };
      const p: Pending = { channel, seq, index, frameBits: 0 };
      switch (type) {
        case CT.StaticQuaternion: {
          const x = readF32(), y = readF32(), z = readF32();
          channel.constant = [x, y, z, Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z))];
          break;
        }
        case CT.StaticVector3:
          channel.constant = [readF32(), readF32(), readF32()];
          break;
        case CT.StaticFloat:
          channel.constant = [readF32()];
          break;
        case CT.RawFloat: {
          const values = (channel.values = new Float32Array(numFrames));
          const tmp = new DataView(new ArrayBuffer(4));
          p.frameBits = 32;
          p.read = (frameBit, f) => {
            tmp.setUint32(0, frameBit(), true);
            values[f] = tmp.getFloat32(0, true);
          };
          break;
        }
        case CT.QuantizeFloat: {
          const valueBits = readI32();
          const quantum = readF32();
          const offset = readF32();
          const values = (channel.values = new Float32Array(numFrames));
          p.frameBits = valueBits;
          p.read = (frameBit, f) => (values[f] = frameBit() * quantum + offset);
          break;
        }
        case CT.IndirectQuantizeFloat: {
          const frameBits = readI32();
          const valueBits = readI32();
          const numInts = readI32();
          const quantum = readF32();
          const offset = readF32();
          const count = Math.min(Math.floor((numInts * 32) / Math.max(1, valueBits)), 2 ** frameBits - 1);
          bits.bit = position * 8;
          const table = Array.from({ length: count }, () => bits.read(valueBits) * quantum + offset);
          position += numInts * 4;
          const values = (channel.values = new Float32Array(numFrames));
          p.frameBits = frameBits;
          p.read = (frameBit, f) => (values[f] = table[frameBit()] ?? offset);
          break;
        }
        case CT.LinearFloat:
          channel.values = decodeLinear(dv, bits, () => position, (v) => (position = v), numFrames, chunkSize, data.length * 8);
          break;
        case CT.CachedQuaternion1:
        case CT.CachedQuaternion2:
          channel.quatIndex = index;
          index = type === CT.CachedQuaternion1 ? 3 : 4;
          p.index = index;
          break;
      }
      list.push(p);
    }
    if (count % 4) dataBitsOffset += (4 - (count % 4)) * 2;
    byType.push(list);
  }

  // Per-frame bit-packed data, channels in type order.
  for (let f = 0; f < numFrames; f++) {
    let bit = (frameOffset + frameLength * f) * 8;
    for (const list of byType) {
      for (const p of list) {
        if (!p.read) continue;
        const n = p.frameBits;
        p.read(() => {
          const v = bits.get(bit, n);
          bit += n;
          return v;
        }, f);
      }
    }
  }

  const channels: (Channel | undefined)[][] = [];
  for (const list of byType) {
    for (const p of list) {
      (channels[p.seq] ??= [])[p.index] = p.channel;
    }
  }
  return { channels, numFrames };
}

function decodeLinear(
  dv: DataView,
  bits: BitReader,
  getPos: () => number,
  setPos: (v: number) => void,
  numFrames: number,
  chunkSize: number,
  streamBits: number
): Float32Array {
  let position = getPos();
  const numInts = dv.getInt32(position, true);
  const counts = dv.getInt32(position + 4, true);
  const quantum = dv.getFloat32(position + 8, true);
  const offset = dv.getFloat32(position + 12, true);
  position += 16;
  const start = position * 8;
  const offsetBits = counts & 0xff;
  const valueBits = (counts >> 8) & 0xff;
  const deltaBits = (counts >> 16) & 0xff;
  const numChunks = Math.ceil(numFrames / chunkSize);
  const deltaBase = start + numChunks * (offsetBits + valueBits);
  bits.bit = start;
  const chunkOffsets = Array.from({ length: numChunks }, () => (offsetBits ? bits.read(offsetBits) : 0));
  const chunkValues = Array.from({ length: numChunks }, () => (valueBits ? bits.read(valueBits) : 0));
  const out = new Float32Array(numFrames);
  for (let c = 0; c < numChunks; c++) {
    bits.bit = deltaBase + chunkOffsets[c];
    let value = chunkValues[c];
    let inc = 0;
    for (let j = 0; j < chunkSize; j++) {
      const frame = c * chunkSize + j;
      if (frame >= numFrames) break;
      out[frame] = value * quantum + offset;
      if (j + 1 >= chunkSize) break;
      let delta = deltaBits ? bits.read(deltaBits) : 0;
      // Unary-coded high part: count zero bits up to the next 1.
      const before = bits.bit;
      while (bits.bit < streamBits && bits.read(1) === 0) {
        /* scan */
      }
      delta |= (bits.bit - before - 1) << deltaBits;
      if (delta !== 0 && bits.read(1) === 1) delta = -delta;
      inc += delta;
      value += inc;
    }
  }
  // numInts counts the 16-byte header too.
  setPos(getPos() + numInts * 4);
  return out;
}

function componentsOf(channels: (Channel | undefined)[], track: number): number {
  if (channels.some((c) => c && (c.type === CT.CachedQuaternion1 || c.type === CT.CachedQuaternion2 || c.type === CT.StaticQuaternion))) return 4;
  if (track === 1 || track === 6) return 4;
  let n = 0;
  for (const c of channels) if (c) n += c.type === CT.StaticVector3 ? 3 : 1;
  return Math.max(1, Math.min(4, n));
}

const floatAt = (c: Channel | undefined, f: number): number => (c?.values ? c.values[f % c.values.length] ?? 0 : (c?.constant?.[0] ?? 0));

/** Values of one bone track at a frame within its block. */
function evaluate(seqChannels: (Channel | undefined)[] | undefined, f: number, components: number): number[] | undefined {
  if (!seqChannels) return undefined;
  const cached = seqChannels.find((c) => c && (c.type === CT.CachedQuaternion1 || c.type === CT.CachedQuaternion2));
  // With all four components stored explicitly, the cached one is redundant.
  const explicit = [0, 1, 2, 3].every((j) => seqChannels[j] && seqChannels[j]!.type !== CT.CachedQuaternion1 && seqChannels[j]!.type !== CT.CachedQuaternion2);
  if (cached && explicit) return normalize([0, 1, 2, 3].map((j) => floatAt(seqChannels[j], f)));
  if (cached) {
    const x = floatAt(seqChannels[0], f);
    const y = floatAt(seqChannels[1], f);
    const z = floatAt(seqChannels[2], f);
    const n = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
    const q = [x, y, z];
    q.splice(cached.quatIndex ?? 3, 0, n); // insert the reconstructed component
    return normalize(q);
  }
  const out: number[] = [];
  for (const c of seqChannels) {
    if (out.length >= components) break;
    if (!c) continue;
    if (c.constant && c.constant.length > 1) out.push(...c.constant);
    else out.push(floatAt(c, f));
  }
  while (out.length < components) out.push(components === 4 && out.length === 3 ? 1 : 0);
  const v = out.slice(0, components);
  return components === 4 ? normalize(v) : v;
}

function normalize(q: number[]): number[] {
  const len = Math.hypot(...q) || 1;
  return q.map((v) => v / len);
}
