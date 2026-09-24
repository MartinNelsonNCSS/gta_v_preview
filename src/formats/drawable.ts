import { ResourceReader } from './reader';
import { readRsc7 } from './rsc7';
import { HashNames, SHADER_FILE_NAMES, SHADER_NAMES, SHADER_PARAM_NAMES } from './hash';
import { readTextureDictionary, TextureDecodeOptions } from './textures';
import { readBounds } from './bounds';
import type {
  BoneData,
  DrawableData,
  LodLevel,
  MeshData,
  ModelData,
  ShaderData,
  TextureData,
  Vec3,
} from '../shared/model';

const ROOT = 0x50000000;

const shaderNames = new HashNames([...SHADER_NAMES, ...SHADER_FILE_NAMES]);
const paramNames = new HashNames(SHADER_PARAM_NAMES);

export interface DrawableOptions extends TextureDecodeOptions {}

/** Parses a .ydr file. */
export function parseYdr(file: Uint8Array, opts: DrawableOptions): DrawableData {
  const r = new ResourceReader(readRsc7(file));
  return readDrawable(r, ROOT, opts);
}

/** Parses a .ydd file (a dictionary of drawables keyed by name hash). */
export function parseYdd(file: Uint8Array, opts: DrawableOptions): DrawableData[] {
  const r = new ResourceReader(readRsc7(file));
  const hashes = r.list(ROOT + 0x20);
  const drawables = r.list(ROOT + 0x30);
  const out: DrawableData[] = [];
  const ptrs = r.ptrArray(drawables.items, drawables.count);
  ptrs.forEach((p, i) => {
    const d = readDrawable(r, p, opts);
    if (i < hashes.count) {
      d.nameHash = r.u32(hashes.items + i * 4);
      if (!d.name) d.name = `hash_${d.nameHash.toString(16).toUpperCase().padStart(8, '0')}`;
    }
    out.push(d);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Drawable
// ---------------------------------------------------------------------------

/** Reads a rmcDrawable (gtaDrawable) at `ptr`. */
export function readDrawable(r: ResourceReader, ptr: number, opts: DrawableOptions): DrawableData {
  const shaderGroupPtr = r.ptr(ptr + 0x10);
  const skeletonPtr = r.ptr(ptr + 0x18);

  let textures: TextureData[] = [];
  let shaders: ShaderData[] = [];
  if (r.isValid(shaderGroupPtr)) {
    const txdPtr = r.ptr(shaderGroupPtr + 0x08);
    if (r.isValid(txdPtr)) textures = readTextureDictionary(r, txdPtr, opts);
    shaders = readShaders(r, shaderGroupPtr);
  }
  const embedded = new Set(textures.map((t) => t.name.toLowerCase()));
  const hasExternalTextures = shaders.some((s) => s.textures.some((t) => !embedded.has(t.texture.toLowerCase())));

  const lodPtrs: Record<LodLevel, number> = {
    high: r.ptr(ptr + 0x50),
    med: r.ptr(ptr + 0x58),
    low: r.ptr(ptr + 0x60),
    vlow: r.ptr(ptr + 0x68),
  };
  const lods = {} as Record<LodLevel, ModelData[]>;
  for (const [lod, p] of Object.entries(lodPtrs) as [LodLevel, number][]) {
    lods[lod] = r.isValid(p) ? readModelList(r, p) : [];
  }

  let bones: BoneData[] = [];
  if (r.isValid(skeletonPtr)) {
    try {
      bones = readSkeleton(r, skeletonPtr);
    } catch {
      bones = [];
    }
  }

  // The name and collision pointers live in gtaDrawable, the derived type used by .ydr/.ydd.
  let name = '';
  let bounds: DrawableData['bounds'];
  try {
    name = r.string(r.ptr(ptr + 0xa8)) ?? '';
    const boundsPtr = r.ptr(ptr + 0xc8);
    if (r.isValid(boundsPtr)) bounds = readBounds(r, boundsPtr);
  } catch {
    // Missing or unreadable collision is not fatal.
  }

  return {
    name: name.replace(/\.#d[rd]$/i, ''),
    center: r.vec3(ptr + 0x20),
    radius: r.f32(ptr + 0x2c),
    bbMin: r.vec3(ptr + 0x30),
    bbMax: r.vec3(ptr + 0x40),
    lodDistances: {
      high: r.f32(ptr + 0x70),
      med: r.f32(ptr + 0x74),
      low: r.f32(ptr + 0x78),
      vlow: r.f32(ptr + 0x7c),
    },
    lods,
    shaders,
    bones,
    textures,
    hasExternalTextures,
    bounds: bounds && (bounds.triangles || bounds.primitives.length) ? bounds : undefined,
  };
}

function readModelList(r: ResourceReader, listPtr: number): ModelData[] {
  const list = r.list(listPtr);
  return r.ptrArray(list.items, list.count).map((p) => readModel(r, p));
}

function readModel(r: ResourceReader, ptr: number): ModelData {
  const geomsPtr = r.ptr(ptr + 0x08);
  const geomCount = r.u16(ptr + 0x10);
  const shaderMapPtr = r.ptr(ptr + 0x20);
  const skeletonBinding = r.u32(ptr + 0x28);
  const renderMask = r.u16(ptr + 0x2c);
  const meshes: MeshData[] = [];
  r.ptrArray(geomsPtr, geomCount).forEach((g, i) => {
    const shaderIndex = r.isValid(shaderMapPtr) ? r.u16(shaderMapPtr + i * 2) : 0;
    const mesh = readGeometry(r, g, shaderIndex);
    if (mesh) meshes.push(mesh);
  });
  return {
    boneIndex: (skeletonBinding >>> 24) & 0xff,
    skinned: ((skeletonBinding >>> 8) & 0xff) !== 0,
    renderMask,
    meshes,
  };
}

// ---------------------------------------------------------------------------
// Geometry / vertex decoding
// ---------------------------------------------------------------------------

const enum Sem {
  Position = 0,
  BlendWeights = 1,
  BlendIndices = 2,
  Normal = 3,
  Colour0 = 4,
  Colour1 = 5,
  TexCoord0 = 6,
}

const enum CT {
  Nothing = 0,
  Half2 = 1,
  Float = 2,
  Half4 = 3,
  FloatUnk = 4,
  Float2 = 5,
  Float3 = 6,
  Float4 = 7,
  UByte4 = 8,
  Colour = 9,
  RGBA8SNorm = 10,
}

const COMPONENT_SIZES = [0, 4, 4, 8, 2, 8, 12, 16, 4, 4, 4, 0, 0, 0, 0, 0];

function readGeometry(r: ResourceReader, ptr: number, shaderIndex: number): MeshData | undefined {
  const vbPtr = r.ptr(ptr + 0x18);
  const ibPtr = r.ptr(ptr + 0x38);
  if (!r.isValid(vbPtr) || !r.isValid(ibPtr)) return undefined;

  const stride = r.u16(vbPtr + 0x08);
  let dataPtr = r.ptr(vbPtr + 0x10);
  if (!r.isValid(dataPtr)) dataPtr = r.ptr(vbPtr + 0x20);
  const vertexCount = r.u32(vbPtr + 0x18);
  const declPtr = r.ptr(vbPtr + 0x30);
  if (!r.isValid(dataPtr) || !r.isValid(declPtr) || vertexCount === 0) return undefined;

  const flags = r.u32(declPtr);
  const typesLo = r.u32(declPtr + 0x08);
  const typesHi = r.u32(declPtr + 0x0c);
  const typeOf = (sem: number) => (sem < 8 ? (typesLo >>> (sem * 4)) & 0xf : (typesHi >>> ((sem - 8) * 4)) & 0xf);

  const offsets: number[] = new Array(16).fill(-1);
  let off = 0;
  for (let i = 0; i < 16; i++) {
    if (flags & (1 << i)) {
      offsets[i] = off;
      off += COMPONENT_SIZES[typeOf(i)];
    }
  }

  const bytes = r.bytes(dataPtr, vertexCount * stride);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const positions = new Float32Array(vertexCount * 3);
  readComponent(view, stride, vertexCount, offsets[Sem.Position], typeOf(Sem.Position), 3, positions);

  let normals: Float32Array | undefined;
  if (offsets[Sem.Normal] >= 0) {
    normals = new Float32Array(vertexCount * 3);
    readComponent(view, stride, vertexCount, offsets[Sem.Normal], typeOf(Sem.Normal), 3, normals);
  }
  let uvs: Float32Array | undefined;
  if (offsets[Sem.TexCoord0] >= 0) {
    uvs = new Float32Array(vertexCount * 2);
    readComponent(view, stride, vertexCount, offsets[Sem.TexCoord0], typeOf(Sem.TexCoord0), 2, uvs);
  }
  let colors: Uint8Array | undefined;
  if (offsets[Sem.Colour0] >= 0 && typeOf(Sem.Colour0) === CT.Colour) {
    colors = new Uint8Array(vertexCount * 4);
    const o = offsets[Sem.Colour0];
    for (let v = 0; v < vertexCount; v++) {
      // Stored as BGRA.
      const b = v * stride + o;
      colors[v * 4] = view.getUint8(b + 2);
      colors[v * 4 + 1] = view.getUint8(b + 1);
      colors[v * 4 + 2] = view.getUint8(b);
      colors[v * 4 + 3] = view.getUint8(b + 3);
    }
  }

  const indexCount = r.u32(ibPtr + 0x08);
  const indexPtr = r.ptr(ibPtr + 0x10);
  const idxBytes = r.bytes(indexPtr, indexCount * 2);
  const indices = new Uint16Array(indexCount);
  const idxView = new DataView(idxBytes.buffer, idxBytes.byteOffset, idxBytes.byteLength);
  for (let i = 0; i < indexCount; i++) indices[i] = idxView.getUint16(i * 2, true);

  return { shaderIndex, positions, normals, uvs, colors, indices };
}

function readComponent(
  view: DataView,
  stride: number,
  count: number,
  offset: number,
  type: number,
  dims: number,
  out: Float32Array
) {
  if (offset < 0) return;
  for (let v = 0; v < count; v++) {
    const b = v * stride + offset;
    for (let d = 0; d < dims; d++) {
      let value = 0;
      switch (type) {
        case CT.Float:
        case CT.Float2:
        case CT.Float3:
        case CT.Float4: {
          const n = type === CT.Float ? 1 : type - CT.Float2 + 2;
          value = d < n ? view.getFloat32(b + d * 4, true) : 0;
          break;
        }
        case CT.Half2:
        case CT.Half4: {
          const n = type === CT.Half2 ? 2 : 4;
          value = d < n ? halfToFloat(view.getUint16(b + d * 2, true)) : 0;
          break;
        }
        case CT.RGBA8SNorm:
          value = Math.max(-1, view.getInt8(b + d) / 127);
          break;
        case CT.Colour:
        case CT.UByte4:
          value = (view.getUint8(b + d) / 255) * 2 - 1;
          break;
      }
      out[v * dims + d] = value;
    }
  }
}

function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const DIFFUSE_PARAMS = ['diffusesampler', 'diffusetexsampler', 'diffusesampler2', 'texturesampler_layer0', 'diffusetexturesampler', 'platebgsampler'];
const NORMAL_PARAMS = ['bumpsampler', 'normalsampler', 'bumpsampler_layer0', 'platebgbumpsampler'];

function readShaders(r: ResourceReader, shaderGroupPtr: number): ShaderData[] {
  const shadersPtr = r.ptr(shaderGroupPtr + 0x10);
  const count = r.u16(shaderGroupPtr + 0x18);
  return r.ptrArray(shadersPtr, count).map((p) => readShader(r, p));
}

function readShader(r: ResourceReader, ptr: number): ShaderData {
  const paramsPtr = r.ptr(ptr + 0x00);
  const nameHash = r.u32(ptr + 0x08);
  const paramCount = r.u8(ptr + 0x10);
  const renderBucket = r.u8(ptr + 0x11);
  const fileHash = r.u32(ptr + 0x18);

  const shader: ShaderData = {
    name: shaderNames.get(nameHash),
    file: shaderNames.get(fileHash),
    renderBucket,
    textures: [],
  };
  if (!r.isValid(paramsPtr) || paramCount === 0) return shader;

  // Parameter headers (16 bytes each), then inline vector data, then name hashes.
  const params: { type: number; data: number }[] = [];
  let dataSize = 0;
  for (let i = 0; i < paramCount; i++) {
    const p = paramsPtr + i * 16;
    const type = r.u8(p);
    params.push({ type, data: r.ptr(p + 8) });
    dataSize += type === 0 ? 0 : 16 * type;
  }
  const hashesPtr = paramsPtr + paramCount * 16 + dataSize;
  params.forEach((param, i) => {
    if (param.type !== 0 || !r.isValid(param.data)) return;
    const texName = r.string(r.ptr(param.data + 0x28));
    if (!texName) return;
    const paramName = paramNames.get(r.u32(hashesPtr + i * 4));
    shader.textures.push({ param: paramName, texture: texName });
    const key = paramName.toLowerCase();
    if (!shader.diffuse && DIFFUSE_PARAMS.includes(key)) shader.diffuse = texName.toLowerCase();
    if (!shader.normal && NORMAL_PARAMS.includes(key)) shader.normal = texName.toLowerCase();
  });
  // Fall back to the first texture that isn't obviously a normal/spec map.
  if (!shader.diffuse) {
    const guess = shader.textures.find((t) => !/_(n|s|nm|spec|normal|bump)$/i.test(t.texture));
    if (guess) shader.diffuse = guess.texture.toLowerCase();
  }
  return shader;
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function readSkeleton(r: ResourceReader, ptr: number): BoneData[] {
  const bonesPtr = r.ptr(ptr + 0x20);
  const count = r.u16(ptr + 0x5e);
  if (!r.isValid(bonesPtr) || count === 0 || count > 1024) return [];
  const bones: BoneData[] = [];
  for (let i = 0; i < count; i++) {
    const b = bonesPtr + i * 0x50;
    const [qx, qy, qz, qw] = r.vec4(b);
    const t = r.vec3(b + 0x10);
    const s = r.vec3(b + 0x20);
    const parent = r.i16(b + 0x32);
    const name = r.string(r.ptr(b + 0x38)) ?? `bone_${i}`;
    const tag = r.u16(b + 0x44);
    const local = composeTRS(t, [qx, qy, qz, qw], s);
    const world = parent >= 0 && parent < bones.length ? mul4(bones[parent].world, local) : local;
    bones.push({ name, tag, parent, world });
  }
  return bones;
}

function composeTRS(t: Vec3, q: [number, number, number, number], s: Vec3): number[] {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s.map((v) => (Number.isFinite(v) && v !== 0 ? v : 1));
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}

function mul4(a: number[], b: number[]): number[] {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let rr = 0; rr < 4; rr++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + rr] * b[c * 4 + k];
      out[c * 4 + rr] = sum;
    }
  }
  return out;
}
