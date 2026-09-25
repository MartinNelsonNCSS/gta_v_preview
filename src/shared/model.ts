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
  /** URI of the file that contains this texture (set by the extension host). */
  origin?: string;
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
  /** The diffuse texture is a decal (e.g. a vehicle livery) drawn over a base colour. */
  diffuseIsOverlay?: boolean;
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
  /** Collision embedded in the drawable, if any. */
  bounds?: BoundsData;
}

// ---------------------------------------------------------------------------
// Collision (.ybn, or embedded in drawables)
// ---------------------------------------------------------------------------

export type CollisionPrimitive =
  | { kind: 'sphere'; material: number; center: Vec3; radius: number }
  | { kind: 'box'; material: number; center: Vec3; /** Half-extent vectors. */ axes: [Vec3, Vec3, Vec3] }
  | { kind: 'capsule' | 'cylinder'; material: number; a: Vec3; b: Vec3; radius: number };

export interface BoundsData {
  bbMin: Vec3;
  bbMax: Vec3;
  triangles: number;
  /** Non-indexed triangle soup, 9 floats per triangle. */
  positions: Float32Array;
  /** Material type index per triangle. */
  triangleMaterials: Uint8Array;
  primitives: CollisionPrimitive[];
  /** Number of bounds of each kind (composite, bvh, box, ...). */
  typeCounts: Record<string, number>;
  /** Materials used, most frequent first (polygon/primitive counts). */
  materials: { index: number; name: string; count: number }[];
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
  guid?: number;
  /** e.g. LODTYPES_DEPTH_HD (ymap entities). */
  lodLevel?: string;
  parentIndex?: number;
  /** True for CMloInstanceDef: an interior placed in the world. */
  isMloInstance?: boolean;
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

export interface CarGenData {
  position: Vec3;
  orientX: number;
  orientY: number;
  perpendicularLength: number;
  model: string;
  flags: number;
  popGroup: string;
  livery: number;
}

export interface YmapData {
  name: string;
  parent: string;
  flags: number;
  contentFlags: number;
  streamingExtents: [Vec3, Vec3];
  entitiesExtents: [Vec3, Vec3];
  entities: EntityData[];
  carGenerators: CarGenData[];
  timecycleModifiers: { name: string; min: Vec3; max: Vec3 }[];
  physicsDictionaries: string[];
  boxOccluders: number;
  occludeModels: number;
  grassBatches: number;
  lodLights: number;
  block?: { name: string; exportedBy: string; owner: string; time: string };
  raw: unknown;
}

export interface PedDrawable {
  index: number;
  /** Expected model file name without prefix/extension, e.g. `jbib_004_u` or `p_head_002`. */
  file: string;
  /** Texture variations; `file` is the expected .ytd name, e.g. `jbib_diff_004_a_uni`. */
  textures: { letter: string; file: string }[];
  cloth: boolean;
  alternatives: number;
}

export interface PedSlot {
  slot: number;
  /** File-name key, e.g. `jbib` or `p_head`. */
  key: string;
  label: string;
  drawables: PedDrawable[];
}

export interface PedVariationData {
  dlcName: string;
  hasLowLods: boolean;
  components: PedSlot[];
  props: PedSlot[];
  selectionSets: number;
}

export interface YmtData {
  name: string;
  rootType: string;
  pedVariation?: PedVariationData;
  raw: unknown;
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

export type ViewKind = 'drawable' | 'dictionary' | 'fragment' | 'ytyp' | 'ytd' | 'ymap' | 'ybn' | 'ymt';

export interface ArchetypeRequest {
  /** Archetype name (may be an unresolved `hash_XXXXXXXX`). */
  name: string;
  /** Drawable dictionary (.ydd) that holds the model, if any. */
  dictionary?: string;
}

export type HostToWebview =
  | { type: 'drawables'; file: string; kind: 'drawable' | 'dictionary' | 'fragment'; drawables: DrawableData[] }
  | { type: 'ytyp'; file: string; ytyp: YtypData }
  | { type: 'ytd'; file: string; textures: TextureData[] }
  | { type: 'ymap'; file: string; ymap: YmapData }
  | { type: 'ybn'; file: string; bounds: BoundsData }
  | {
      type: 'ymt';
      file: string;
      ymt: YmtData;
      /** Lower-case base names of model/texture files in the .ymt's folder tree. */
      files: string[];
    }
  | { type: 'text'; file: string; text: string; note: string }
  | { type: 'drawableFile'; requestId: number; drawables: DrawableData[]; error?: string }
  | { type: 'textureFile'; requestId: number; textures: TextureData[]; error?: string }
  | { type: 'pickedImage'; requestId: number; name?: string; data?: Uint8Array }
  | { type: 'fullTexture'; requestId: number; texture?: TextureData; error?: string }
  | { type: 'textureReplaced'; requestId: number; ok: boolean; cancelled?: boolean; error?: string; file?: string }
  | { type: 'saved'; requestId: number; path?: string; cancelled?: boolean; error?: string }
  /** Images to convert in the DDS converter panel. */
  | { type: 'converterFiles'; files: { name: string; uri: string; data: Uint8Array }[] }
  | { type: 'converted'; requestId: number; ok: boolean; path?: string; skipped?: boolean; replaceAll?: boolean; error?: string }
  | { type: 'textures'; requestId: number; textures: TextureData[]; source: string; searched: number; done: boolean }
  | {
      type: 'archetypeModels';
      requestId: number;
      /** Keyed by the requested archetype name; null when no model file was found. */
      models: Record<string, DrawableData | null>;
      /** Archetype definitions found in nearby .ytyp files (includes MLO layouts). */
      archetypes: Record<string, ArchetypeData | null>;
      done: boolean;
    }
  | { type: 'error'; message: string }
  | { type: 'status'; message: string };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'findTextures'; requestId: number; names: string[]; hints: string[]; maxSize?: number }
  | { type: 'loadArchetypes'; requestId: number; archetypes: ArchetypeRequest[]; maxTextureSize?: number }
  | { type: 'openAsset'; name: string; ext: 'ydr' | 'ydd' | 'yft' | 'ytd' }
  /** Loads every drawable in a model file found by base name (any of .ydd/.ydr/.yft). */
  | { type: 'loadDrawableFile'; requestId: number; name: string; maxTextureSize?: number }
  /** Loads every texture in a .ytd found by base name. */
  | { type: 'loadTextureFile'; requestId: number; name: string; maxSize?: number }
  | { type: 'openAsText' }
  /** Opens a file picker for a replacement image (PNG/JPG/DDS...). */
  | { type: 'pickImage'; requestId: number }
  /** Full-resolution texture from the file at `origin`. */
  | { type: 'getFullTexture'; requestId: number; origin: string; name: string }
  /** Writes `rgba` (exactly the texture's size) into the file at `origin`, after confirmation. */
  | {
      type: 'replaceTexture';
      requestId: number;
      origin: string;
      name: string;
      width: number;
      height: number;
      format?: string;
      levels?: number;
      /** Pixels to encode, or `encoded` data (all mips) to store as-is. */
      rgba?: Uint8Array;
      encoded?: Uint8Array;
    }
  /** Saves the texture's original data as .dds (via a save dialog). */
  | { type: 'exportDds'; requestId: number; origin: string; name: string }
  /** Saves bytes produced by the webview (e.g. a PNG) via a save dialog. */
  | { type: 'saveFile'; requestId: number; suggestedName: string; data: Uint8Array; filterName: string; extensions: string[] }
  /** Writes a converted .dds next to its source image (asking before replacing unless `overwrite`). */
  | { type: 'writeConverted'; requestId: number; sourceUri: string; data: Uint8Array; overwrite: boolean; format: string };
