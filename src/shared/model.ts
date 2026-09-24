/**
 * Plain-data scene description produced by the parsers (extension host) and
 * consumed by the renderer (webview). Everything here must survive
 * postMessage, so only plain objects and typed arrays are allowed.
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // x, y, z, w

export interface TexturePixels {
  width: number;
  height: number;
  /** 'rgba' is ready to upload; 'bc7' is raw BC7 blocks the webview decodes on the GPU. */
  encoding: 'rgba' | 'bc7';
  data: Uint8Array;
}

export interface TextureData {
  name: string;
  width: number;
  height: number;
  format: string;
  levels: number;
  /** Missing when the texture is only a reference to an external dictionary. */
  pixels?: TexturePixels;
}

export interface ShaderTextureRef {
  /** Shader parameter name, e.g. "DiffuseSampler". */
  param: string;
  texture: string;
}

export interface ShaderData {
  name: string;
  file: string;
  renderBucket: number;
  textures: ShaderTextureRef[];
  /** Lower-cased name of the main colour texture, if any. */
  diffuse?: string;
  normal?: string;
}

export interface MeshData {
  shaderIndex: number;
  positions: Float32Array;
  normals?: Float32Array;
  uvs?: Float32Array;
  /** RGBA, 4 bytes per vertex. */
  colors?: Uint8Array;
  indices: Uint16Array | Uint32Array;
}

export interface ModelData {
  /** Index of the bone this model is attached to (non-skinned models only). */
  boneIndex: number;
  skinned: boolean;
  renderMask: number;
  meshes: MeshData[];
}

export type LodLevel = 'high' | 'med' | 'low' | 'vlow';
export const LOD_LEVELS: LodLevel[] = ['high', 'med', 'low', 'vlow'];

export interface BoneData {
  name: string;
  tag: number;
  parent: number;
  /** Bone-to-model-space transform, column-major 4x4. */
  world: number[];
}

export interface DrawableData {
  name: string;
  /** Hash key of this drawable inside a .ydd. */
  nameHash?: number;
  bbMin: Vec3;
  bbMax: Vec3;
  center: Vec3;
  radius: number;
  lodDistances: Record<LodLevel, number>;
  lods: Record<LodLevel, ModelData[]>;
  shaders: ShaderData[];
  bones: BoneData[];
  /** Textures embedded in this drawable's shader group. */
  textures: TextureData[];
  /** Whether any shader references a texture not embedded in the file. */
  hasExternalTextures: boolean;
}

// ---------------------------------------------------------------------------
// .ytyp
// ---------------------------------------------------------------------------

export interface EntityData {
  archetype: string;
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
  lodDist: number;
  flags: number;
  room?: string;
  entitySet?: string;
}

export interface RoomData {
  name: string;
  bbMin: Vec3;
  bbMax: Vec3;
  timecycle: string;
  entityIndices: number[];
}

export interface PortalData {
  roomFrom: number;
  roomTo: number;
  corners: Vec3[];
  flags: number;
}

export interface ArchetypeData {
  type: 'CBaseArchetypeDef' | 'CTimeArchetypeDef' | 'CMloArchetypeDef' | string;
  name: string;
  assetName: string;
  textureDictionary: string;
  drawableDictionary: string;
  physicsDictionary: string;
  clipDictionary: string;
  assetType: string;
  lodDist: number;
  flags: number;
  specialAttribute: number;
  bbMin: Vec3;
  bbMax: Vec3;
  bsCentre: Vec3;
  bsRadius: number;
  timeFlags?: number;
  mlo?: {
    entities: EntityData[];
    rooms: RoomData[];
    portals: PortalData[];
    entitySets: { name: string; entityCount: number }[];
  };
}

export interface YtypData {
  name: string;
  archetypes: ArchetypeData[];
  dependencies: string[];
  /** Generic tree of the whole meta document, for the raw view. */
  raw: unknown;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type ViewKind = 'drawable' | 'dictionary' | 'ytyp' | 'ytd';

export interface ArchetypeRequest {
  /** Archetype name (may be an unresolved `hash_XXXXXXXX`). */
  name: string;
  /** Drawable dictionary (.ydd) that holds the model, if any. */
  dictionary?: string;
}

export type HostToWebview =
  | { type: 'drawables'; file: string; kind: 'drawable' | 'dictionary'; drawables: DrawableData[] }
  | { type: 'ytyp'; file: string; ytyp: YtypData }
  | { type: 'ytd'; file: string; textures: TextureData[] }
  | { type: 'textures'; requestId: number; textures: TextureData[]; source: string; searched: number; done: boolean }
  | {
      type: 'archetypeModels';
      requestId: number;
      /** Keyed by the requested archetype name; null when no model file was found. */
      models: Record<string, DrawableData | null>;
      done: boolean;
    }
  | { type: 'error'; message: string }
  | { type: 'status'; message: string };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'findTextures'; requestId: number; names: string[]; hints: string[]; maxSize?: number }
  | { type: 'loadArchetypes'; requestId: number; archetypes: ArchetypeRequest[]; maxTextureSize?: number }
  | { type: 'openAsset'; name: string; ext: 'ydr' | 'ydd' | 'ytd' };
