import { HashNames, joaat } from './hash';
import { EnumInfo, MetaObject, StructInfo } from './meta';
import { MetaSchema, MetaWriter } from './metaWrite';
import { PED_VARIATION_SCHEMA } from './pedVariationSchema';
import { BASE_HAIRS, BASE_MASKS, DlcEntries } from './maskHairAlternates';
import { rbfArray, rbfElement, rbfUint, writeRbf } from './rbf';
import { META_NAMES } from './mapShared';
import type { PedSlot, PedVariationData } from '../shared/model';

/**
 * Addon clothing packs (FiveM): a project of drawables (models + texture
 * variations + flags) for the freemode peds, and the build that turns it into
 * a streamable resource — renamed stream files, the ped variation .ymt, shop
 * meta, alternate variations and fxmanifest.lua — in the layout addon
 * clothing tools use.
 */

export type Gender = 'male' | 'female';
export type DrawableKind = 'component' | 'prop';

/** Component slots in component-id order. */
export const COMPONENT_SLOTS = [
  { key: 'head', label: 'Head' },
  { key: 'berd', label: 'Masks' },
  { key: 'hair', label: 'Hair' },
  { key: 'uppr', label: 'Torso' },
  { key: 'lowr', label: 'Legs' },
  { key: 'hand', label: 'Bags & parachutes' },
  { key: 'feet', label: 'Shoes' },
  { key: 'teef', label: 'Accessories' },
  { key: 'accs', label: 'Undershirts' },
  { key: 'task', label: 'Body armour' },
  { key: 'decl', label: 'Decals' },
  { key: 'jbib', label: 'Tops' },
] as const;

/** Prop slots in anchor-id order (eAnchorPoints). */
export const PROP_SLOTS = [
  { key: 'p_head', label: 'Hats' },
  { key: 'p_eyes', label: 'Glasses' },
  { key: 'p_ears', label: 'Ears' },
  { key: 'p_mouth', label: 'Mouth' },
  { key: 'p_lhand', label: 'Left hand' },
  { key: 'p_rhand', label: 'Right hand' },
  { key: 'p_lwrist', label: 'Watches' },
  { key: 'p_rwrist', label: 'Bracelets' },
  { key: 'p_hip', label: 'Hip' },
  { key: 'p_lfoot', label: 'Left foot' },
  { key: 'p_rfoot', label: 'Right foot' },
  { key: 'p_ph_l_hand', label: 'Left hand (ph)' },
  { key: 'p_ph_r_hand', label: 'Right hand (ph)' },
] as const;

export const PED_NAMES: Record<Gender, string> = { male: 'mp_m_freemode_01', female: 'mp_f_freemode_01' };

/** Most drawables one slot can hold in one collection (numbers 000–255); bigger slots are split across collections. */
export const MAX_DRAWABLES_PER_SLOT = 256;
/** Texture variations are lettered a–z. */
export const MAX_TEXTURES = 26;

export interface PackDrawable {
  id: string;
  gender: Gender;
  kind: DrawableKind;
  /** Slot key, e.g. `jbib` or `p_head`. */
  slot: string;
  /** Model (.ydd), relative to the project file. */
  model: string;
  /** Texture variations (.ytd) in order (a, b, c…), relative to the project file. */
  textures: string[];
  /** Display name. */
  name?: string;
  /** Components: the model shows skin (files `_r` / textures `_whi`, skin texture id). */
  hasSkin?: boolean;
  /** Cloth physics (.yld), relative to the project file. */
  cloth?: string;
  /** Hair: switch to the alternate when wearing base-game masks (default on). */
  maskAlternate?: boolean;
  /** Masks: hide hair (hairs switch to their alternate when this mask is worn). */
  hidesHair?: boolean;
  /** First-person alternate model (.ydd), streamed as `<name>_1.ydd`. */
  firstPerson?: string;
  /** Audio id (default "none"), e.g. `shoe_high_heels`, `cloth_upper_leather`. */
  audio?: string;
  /** Drawable/prop flags bitmask (DRAWABLE_FLAGS). */
  flags?: number;
  /** Shoes: high heels, with the heel amount (typically 1.0). */
  highHeels?: number;
  /** Hats: squash the hair underneath by this amount (typically 0.5). */
  hairScale?: number;
  /** Props: render flag. */
  renderFlag?: '' | 'PRF_ALPHA' | 'PRF_DECAL' | 'PRF_CUTOUT';
  /** A placeholder that keeps a drawable number taken (streams an empty model). */
  reserved?: boolean;
  /** Free-text group for organising the list (e.g. "Police", "Winter"). */
  group?: string;
  /** Tags for filtering. */
  tags?: string[];
  /** Embedded textures replaced at build time: texture name → replacement .dds, relative to the project file. */
  embedded?: Record<string, string>;
  /** Leave this drawable's textures as they are when the build optimises textures. */
  noOptimize?: boolean;
}

/** Texture optimisation applied to copies of the files while building. */
export interface BuildOptimize {
  /** Largest texture dimension; bigger textures are halved until they fit (0 = no cap). */
  maxSize: number;
  addMips: boolean;
  compress: boolean;
  /** Also optimise textures embedded in models. */
  embedded: boolean;
}

/** A base ped part shown under the clothes in the outfit preview. */
export interface BodyPart {
  model: string;
  texture?: string;
}

/** Flags for components (CComponentInfo.flags) and props (propFlags). */
export const DRAWABLE_FLAGS = [
  ['BULKY', 1],
  ['JOB', 2],
  ['SUNNY', 4],
  ['WET', 8],
  ['COLD', 16],
  ['NOT_IN_CAR', 32],
  ['BIKE_ONLY', 64],
  ['NOT_INDOORS', 128],
  ['FIRE_RETARDENT', 256],
  ['ARMOURED', 512],
  ['LIGHTLY_ARMOURED', 1024],
  ['HIGH_DETAIL', 2048],
  ['DEFAULT_HELMET', 4096],
  ['RANDOM_HELMET', 8192],
  ['SCRIPT_HELMET', 16384],
  ['FLIGHT_HELMET', 32768],
  ['HIDE_IN_FIRST_PERSON', 65536],
  ['USE_PHYSICS_HAT_2', 131072],
] as const;

export const RENDER_FLAGS = ['', 'PRF_ALPHA', 'PRF_DECAL', 'PRF_CUTOUT'] as const;

/** Audio ids offered per component slot (the game's clothing/footstep sounds). */
export const AUDIO_IDS: Record<string, string[]> = {
  berd: ['none', 'cloth_scuba'],
  uppr: ['none', 'cloth_default', 'cloth_upper_bare', 'cloth_upper_sweater', 'cloth_upper_shirt_tee', 'cloth_upper_shirt_cotton_lite', 'cloth_upper_shirt_cotton_heavy', 'cloth_upper_jacket_cotton', 'cloth_upper_jacket_puffy', 'cloth_upper_jacket_leather', 'cloth_upper_jacket_suit', 'cloth_upper_bikini_top', 'cloth_upper_spacesuit', 'cloth_upper_alien', 'cloth_upper_coat_scientist', 'cloth_upper_cop_vest_helmet'],
  lowr: ['none', 'cloth_default', 'cloth_lower_cotton', 'cloth_lower_leather', 'cloth_lower_shorts', 'cloth_lower_pants_leather', 'cloth_lower_pants_denim', 'cloth_lower_pants_suit', 'cloth_lower_pants_tight', 'cloth_lower_skirt_short', 'cloth_lower_skirt_long', 'cloth_lower_waterproof', 'cloth_lower_bare', 'cloth_lower_ballistic_armour', 'cloth_lower_extreme', 'cloth_lower_swat', 'cloth_lower_fireman', 'cloth_lower_fireman_lower'],
  hand: ['none', 'cloth_rappel_parachute', 'cloth_heavy_bag'],
  feet: ['none', 'footsteps_generic', 'shoe_barefoot', 'shoe_heels', 'shoe_normal_heels', 'shoe_high_heels', 'shoe_heavy_boots', 'shoe_rubber_boots', 'shoe_rubber', 'shoe_flip_flops', 'shoe_dress_shoes', 'shoe_trainers', 'shoe_scuba_flippers', 'shoe_cowboy_boots', 'shoe_clown_shoes', 'shoe_gold_shoes', 'shoe_silent'],
  accs: ['none', 'cloth_default', 'cloth_upper_shirt_tee', 'cloth_upper_cotton', 'cloth_upper_shirt_cotton_lite', 'cloth_upper_jacket_puffy', 'cloth_upper_jacket_suit', 'cloth_upper_ballistic_armour', 'cloth_upper_bikini_top', 'cloth_upper_cop_vest', 'cloth_scuba', 'cloth_cop_belt', 'cloth_gas_mask'],
  task: ['none', 'cloth_ballistic', 'cloth_backpack', 'cloth_tool_belt'],
  jbib: ['none', 'cloth_default', 'cloth_upper_bare', 'cloth_upper_leather', 'cloth_upper_sweater', 'cloth_upper_cotton', 'cloth_upper_shirt_tee', 'cloth_upper_shirt_cotton_lite', 'cloth_upper_shirt_cotton_heavy', 'cloth_upper_shirt_leather', 'cloth_upper_jacket_cotton', 'cloth_upper_jacket_puffy', 'cloth_upper_jacket_leather', 'cloth_upper_jacket_suit', 'cloth_upper_bikini_top', 'cloth_upper_waterproof', 'cloth_upper_ballistic_armour', 'cloth_upper_spacesuit', 'cloth_upper_swat', 'cloth_upper_fireman', 'cloth_upper_kifflom', 'cloth_upper_alien'],
};

/** Paths of the bundled placeholder files used for reserved drawables. */
export const RESERVED_MODEL = '@reserved/reservedDrawable.ydd';
export const RESERVED_TEXTURE = '@reserved/reservedTexture.ytd';

export interface ClothPack {
  version: 1;
  /** Collection name, e.g. `my_clothes` → `mp_m_freemode_01_my_clothes`. */
  name: string;
  drawables: PackDrawable[];
  /** Build output folder, relative to the project file. */
  output?: string;
  /** Drawables per gender and slot in one collection before splitting (1–256, default 256). */
  maxPerSlot?: number;
  /** Optimise textures while building (sources are left untouched). */
  optimize?: BuildOptimize;
  /** Base ped models for the outfit preview, per gender. */
  body?: Partial<Record<Gender, BodyPart[]>>;
}

export const slotInfo = (kind: DrawableKind, slot: string) =>
  kind === 'prop' ? PROP_SLOTS.findIndex((s) => s.key === slot) : COMPONENT_SLOTS.findIndex((s) => s.key === slot);

export const slotLabel = (kind: DrawableKind, slot: string) =>
  (kind === 'prop' ? PROP_SLOTS : COMPONENT_SLOTS).find((s) => s.key === slot)?.label ?? slot;

export function packNameProblem(name: string): string | undefined {
  if (!name) return 'Enter a name.';
  if (!/^[a-z0-9_]+$/.test(name)) return 'Use lower-case letters, digits and "_".';
  if (name.length > 40) return 'Keep the name under 40 characters.';
  return undefined;
}

export function newPack(name: string): ClothPack {
  return { version: 1, name, drawables: [], output: `build/${name}` };
}

/** Parses and normalises a project file, filling defaults. */
export function readPack(text: string): ClothPack {
  const raw = JSON.parse(text) as Partial<ClothPack>;
  return {
    version: 1,
    name: String(raw.name ?? 'my_clothes'),
    output: raw.output,
    maxPerSlot: raw.maxPerSlot,
    optimize: raw.optimize,
    body: raw.body,
    drawables: (raw.drawables ?? []).map((d, i) => ({
      ...d,
      id: d.id || `d${i}_${Math.random().toString(36).slice(2, 8)}`,
      gender: d.gender === 'female' ? 'female' : 'male',
      kind: d.kind === 'prop' ? 'prop' : 'component',
      textures: Array.isArray(d.textures) ? d.textures : [],
    })),
  };
}

export function writePack(pack: ClothPack): string {
  return `${JSON.stringify(pack, null, 2)}\n`;
}

export const newId = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ---------------------------------------------------------------------------
// Guessing slots from file names
// ---------------------------------------------------------------------------

const SLOT_PATTERN = new RegExp(`(?:^|[\\^_/\\\\-])(${[...PROP_SLOTS.map((s) => s.key), ...COMPONENT_SLOTS.map((s) => s.key)].join('|')})_(?:diff_)?(\\d{3})`, 'i');

/** Slot, kind, gender and skin guessed from a model path (`.../mp_f_freemode_01_x^jbib_003_r.ydd`). */
export function guessFromPath(path: string): { kind?: DrawableKind; slot?: string; gender?: Gender; hasSkin?: boolean; number?: number } {
  const name = path.split(/[\\/]/).pop() ?? path;
  const m = SLOT_PATTERN.exec(name);
  const slot = m?.[1].toLowerCase();
  const lower = path.toLowerCase();
  const gender: Gender | undefined = /mp_f_|[\\/[]female[\\/\]]|_f_freemode/.test(lower) ? 'female' : /mp_m_|[\\/[]male[\\/\]]|_m_freemode/.test(lower) ? 'male' : undefined;
  return {
    slot,
    kind: slot ? (slot.startsWith('p_') ? 'prop' : 'component') : undefined,
    gender,
    hasSkin: /_r\.ydd$/i.test(name) || undefined,
    number: m ? Number(m[2]) : undefined,
  };
}

/** Of `candidates` (.ytd paths), the texture variations that belong to a model, sorted by letter. */
export function texturesForModel(model: string, candidates: string[]): string[] {
  const base = model.split(/[\\/]/).pop()!.replace(/\.ydd$/i, '');
  const m = /^(.*?)(p_\w+?|\w{4})_(\d{3})(?:_[ur])?$/i.exec(base);
  if (!m) return [];
  const [, prefix, slot, num] = m;
  const re = new RegExp(`^${escapeRe(prefix)}${escapeRe(slot)}_diff_${num}_([a-z])(?:_[a-z]{3})?\\.ytd$`, 'i');
  return candidates
    .map((c) => ({ c, m: re.exec(c.split(/[\\/]/).pop() ?? '') }))
    .filter((x) => x.m)
    .sort((a, b) => a.m![1].localeCompare(b.m![1]))
    .map((x) => x.c);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/** One output file: either copied from a pack file, or generated. */
export interface BuildFile {
  /** Path inside the output folder. */
  path: string;
  /** Source path (relative to the project file) to copy. */
  from?: string;
  data?: Uint8Array;
  /** Changes applied to the copy: texture optimisation and embedded texture replacements. */
  process?: { optimize?: BuildOptimize; embedded?: Record<string, string> };
}

export interface BuildPlan {
  files: BuildFile[];
  /** Collection names produced (more than one when slots had to be split). */
  collections: string[];
  warnings: string[];
}

const pad3 = (n: number) => String(n).padStart(3, '0');
const letter = (i: number) => String.fromCharCode(97 + i);

/**
 * Groups drawables into collections of at most MAX_DRAWABLES_PER_SLOT per gender and slot.
 * With more than one collection they are numbered `<name>_01`, `<name>_02`…
 */
export const slotLimit = (pack: ClothPack) => Math.max(1, Math.min(MAX_DRAWABLES_PER_SLOT, Math.floor(pack.maxPerSlot ?? MAX_DRAWABLES_PER_SLOT)));

function collections(pack: ClothPack): { name: string; drawables: PackDrawable[] }[] {
  const limit = slotLimit(pack);
  const index = new Map<string, number>();
  const groups: PackDrawable[][] = [];
  for (const d of pack.drawables) {
    const key = `${d.gender}/${d.kind}/${d.slot}`;
    const n = index.get(key) ?? 0;
    index.set(key, n + 1);
    const c = Math.floor(n / limit);
    while (groups.length <= c) groups.push([]);
    groups[c].push(d);
  }
  if (!groups.length) return [{ name: pack.name, drawables: [] }];
  return groups.map((drawables, i) => ({ name: groups.length > 1 ? `${pack.name}_${String(i + 1).padStart(2, '0')}` : pack.name, drawables }));
}

/** Plans every output file of a FiveM resource for the pack. */
export function planBuild(pack: ClothPack): BuildPlan {
  const files: BuildFile[] = [];
  const warnings: string[] = [];
  const metaFiles: string[] = [];
  const firstPerson: string[] = [];
  const switches: Record<Gender, string[]> = { male: [], female: [] };
  const cols = collections(pack);
  if (cols.length > 1) warnings.push(`Some slots have more than ${slotLimit(pack)} drawables, so the pack is split into ${cols.length} collections.`);

  for (const col of cols) {
    // A component slot is listed for both peds when either uses it.
    const usedSlots = new Set(col.drawables.filter((d) => d.kind === 'component').map((d) => d.slot));
    for (const gender of ['male', 'female'] as Gender[]) {
      const own = col.drawables.filter((d) => d.gender === gender);
      if (!own.length) continue;
      const ped = PED_NAMES[gender];
      const g = `[${gender}]`;
      const compPrefix = `${ped}_${col.name}`;
      const propPrefix = `${ped}_p_${col.name}`;
      const numbered = numberDrawables(own);
      for (const { d, n } of numbered) {
        if (d.textures.length > MAX_TEXTURES) warnings.push(`${describe(d)} has ${d.textures.length} textures; only the first ${MAX_TEXTURES} are used.`);
        const textures = d.reserved ? [RESERVED_TEXTURE] : d.textures.slice(0, MAX_TEXTURES);
        const model = d.reserved ? RESERVED_MODEL : d.model;
        const prefix = d.kind === 'component' ? compPrefix : propPrefix;
        const name = drawableName(d, n);
        const base = `stream/${g}/${d.slot}/${prefix}^`;
        const optimize = d.reserved || d.noOptimize ? undefined : pack.optimize;
        const embedded = d.reserved || !d.embedded || !Object.keys(d.embedded).length ? undefined : d.embedded;
        files.push({ path: `${base}${name}.ydd`, from: model, ...(optimize?.embedded || embedded ? { process: { optimize: optimize?.embedded ? optimize : undefined, embedded } } : {}) });
        textures.forEach((t, i) => files.push({ path: `${base}${textureName(d, n, i)}.ytd`, from: t, ...(optimize ? { process: { optimize } } : {}) }));
        if (d.cloth && d.kind === 'component' && !d.reserved) files.push({ path: `${base}${name}.yld`, from: d.cloth });
        if (d.firstPerson && !d.reserved) {
          files.push({ path: `${base}${name}_1.ydd`, from: d.firstPerson });
          firstPerson.push(`${prefix}/${name}`);
        }
      }
      files.push({ path: `stream/${compPrefix}.ymt`, data: buildYmt(col.name, numbered, usedSlots) });
      const creature = buildCreatureMetadata(numbered);
      if (creature) files.push({ path: `stream/mp_creaturemetadata_${gender === 'male' ? 'm' : 'f'}_${col.name}.ymt`, data: creature });
      const meta = `${compPrefix}.meta`;
      files.push({ path: meta, data: text(shopMeta(gender, col.name)) });
      metaFiles.push(meta);
      switches[gender].push(...alternateSwitches(gender, col.name, numbered));
    }
  }
  const fpMeta = firstPerson.length ? `first_person_alternates_${pack.name}.meta` : undefined;
  if (fpMeta) files.push({ path: fpMeta, data: text(firstPersonXml(firstPerson)) });
  const altMeta = switches.male.length || switches.female.length ? `pedalternativevariations_${pack.name}.meta` : undefined;
  if (altMeta) files.push({ path: altMeta, data: text(alternatesXml(switches)) });
  files.push({ path: 'fxmanifest.lua', data: text(fxmanifest(metaFiles, fpMeta, altMeta)) });
  return { files, collections: cols.map((c) => c.name), warnings };
}

/** Stream name of a drawable: `jbib_003_u` / `jbib_003_r` / `p_head_003`. */
function drawableName(d: PackDrawable, n: number): string {
  return d.kind === 'component' ? `${d.slot}_${pad3(n)}_${d.hasSkin ? 'r' : 'u'}` : `${d.slot}_${pad3(n)}`;
}

/** Stream name of a texture variation: `jbib_diff_003_a_uni` / `p_head_diff_003_a`. */
function textureName(d: PackDrawable, n: number, i: number): string {
  return d.kind === 'component' ? `${d.slot}_diff_${pad3(n)}_${letter(i)}_${d.hasSkin ? 'whi' : 'uni'}` : `${d.slot}_diff_${pad3(n)}_${letter(i)}`;
}

const describe = (d: PackDrawable) => `${d.gender} ${d.slot}${d.name ? ` "${d.name}"` : ''}`;
const text = (s: string) => new TextEncoder().encode(s);

/** Drawables with their number within their slot (pack order). */
function numberDrawables(drawables: PackDrawable[]): { d: PackDrawable; n: number }[] {
  const next = new Map<string, number>();
  return drawables.map((d) => {
    const key = `${d.kind}/${d.slot}`;
    const n = next.get(key) ?? 0;
    next.set(key, n + 1);
    return { d, n };
  });
}

// -- .ymt ------------------------------------------------------------------------

const fromHex = (s: string) => new Uint8Array(s.match(/../g)!.map((b) => parseInt(b, 16)));

/** The embedded ped variation schema as writer input. */
function pedVariationSchema(): MetaSchema {
  const structs: StructInfo[] = PED_VARIATION_SCHEMA.structs.map(([infoHex, entriesHex]) => {
    const info = fromHex(infoHex);
    const entries = entriesHex ? fromHex(entriesHex) : new Uint8Array();
    const v = new DataView(info.buffer);
    const e = new DataView(entries.buffer);
    return {
      name: v.getUint32(0, true),
      key: v.getUint32(4, true),
      size: v.getInt32(0x18, true),
      entries: Array.from({ length: entries.length / 16 }, (_, j) => ({
        name: e.getUint32(j * 16, true),
        offset: e.getInt32(j * 16 + 4, true),
        type: entries[j * 16 + 8],
        refIndex: e.getInt16(j * 16 + 10, true),
        refKey: e.getUint32(j * 16 + 12, true),
      })),
      raw: { info, entries },
    };
  });
  const enums: EnumInfo[] = PED_VARIATION_SCHEMA.enums.map(([infoHex, entriesHex]) => {
    const info = fromHex(infoHex);
    const entries = entriesHex ? fromHex(entriesHex) : new Uint8Array();
    const v = new DataView(info.buffer);
    const e = new DataView(entries.buffer);
    const values = new Map<number, number>();
    for (let j = 0; j < entries.length / 8; j++) values.set(e.getInt32(j * 8 + 4, true), e.getUint32(j * 8, true));
    return { name: v.getUint32(0, true), key: v.getUint32(4, true), values, raw: { info, entries } };
  });
  return { structs, enums, rootHeader: fromHex(PED_VARIATION_SCHEMA.rootHeader), fileHeader: fromHex(PED_VARIATION_SCHEMA.fileHeader) };
}

const obj = (type: string, fields: Record<string, unknown>): MetaObject => ({ _type: type, ...fields });

/** Builds the CPedVariationInfo .ymt for one ped's drawables in one collection. */
export function buildYmt(collection: string, numbered: { d: PackDrawable; n: number }[], usedSlots?: Set<string>): Uint8Array {
  const components = numbered.filter((x) => x.d.kind === 'component');
  const props = numbered.filter((x) => x.d.kind === 'prop');

  // Component data, in component-id order; availComp maps component id → index (255 = none).
  const availComp: number[] = [];
  const componentData: MetaObject[] = [];
  const compInfos: MetaObject[] = [];
  COMPONENT_SLOTS.forEach((slot, compId) => {
    const own = components.filter((x) => x.d.slot === slot.key);
    // A slot gets an entry when the collection uses it for either ped (so it can be empty here).
    if (!own.length && !usedSlots?.has(slot.key)) {
      availComp.push(255);
      return;
    }
    availComp.push(componentData.length);
    componentData.push(
      obj('CPVComponentData', {
        numAvailTex: own.reduce((sum, x) => sum + textureCount(x.d).length, 0),
        aDrawblData3: own.map(({ d }) =>
          obj('CPVDrawblData', {
            propMask: d.hasSkin ? 17 : 1,
            numAlternatives: d.firstPerson && !d.reserved ? 1 : 0,
            aTexData: textureCount(d).map(() => obj('CPVTextureData', { texId: d.hasSkin ? 1 : 0, distribution: 255 })),
            clothData: obj('CPVDrawblData__CPVClothComponentData', { ownsCloth: !!d.cloth && !d.reserved }),
          })
        ),
      })
    );
    for (const { d, n } of own) {
      compInfos.push(
        obj('CComponentInfo', {
          pedXml_audioID: d.audio || 'none',
          pedXml_audioID2: 'none',
          // Expression 4 is the high-heel amount.
          pedXml_expressionMods: [0, 0, 0, 0, d.highHeels ?? 0],
          flags: d.flags ?? 0,
          inclusions: 0,
          exclusions: 0,
          pedXml_vfxComps: 0,
          pedXml_flags: 0,
          pedXml_compIdx: compId,
          pedXml_drawblIdx: n,
        })
      );
    }
  });

  // Props, grouped by anchor in anchor order; each anchor lists its props' texture counts.
  const propMeta: MetaObject[] = [];
  const anchors: MetaObject[] = [];
  PROP_SLOTS.forEach((slot, anchorId) => {
    const own = props.filter((x) => x.d.slot === slot.key);
    if (!own.length) return;
    anchors.push(obj('CAnchorProps', { props: own.map(({ d }) => textureCount(d).length), anchor: anchorId }));
    for (const { d, n } of own) {
      const render = RENDER_FLAGS.indexOf(d.renderFlag ?? '');
      propMeta.push(
        obj('CPedPropMetaData', {
          audioId: d.audio || 'none',
          // Expression 0 squashes the hair under hats (negative amount).
          expressionMods: [d.hairScale ? -d.hairScale : 0, 0, 0, 0, 0],
          texData: textureCount(d).map((_, i) =>
            obj('CPedPropTexData', { inclusions: 0, exclusions: 0, texId: i, inclusionId: 0, exclusionId: 0, distribution: 255 })
          ),
          // ePropRenderFlags is a flags field: PRF_ALPHA/DECAL/CUTOUT are bits 0/1/2.
          renderFlags: render > 0 ? 1 << (render - 1) : 0,
          propFlags: d.flags ?? 0,
          flags: 0,
          anchorId,
          propId: n,
          stickyness: 0,
        })
      );
    }
  });

  const root = obj('CPedVariationInfo', {
    bHasTexVariations: true,
    bHasDrawblVariations: true,
    bHasLowLODs: false,
    bIsSuperLOD: false,
    availComp,
    aComponentData3: componentData,
    aSelectionSets: [],
    compInfos,
    propInfo: obj('CPedPropInfo', { numAvailProps: propMeta.length, aPropMetaData: propMeta, aAnchors: anchors }),
    dlcName: `hash_${joaat(collection).toString(16).toUpperCase().padStart(8, '0')}`,
  });
  const names = new HashNames(META_NAMES);
  return new MetaWriter(pedVariationSchema(), names).write(root, collection);
}

/** One entry per texture variation that will be built (reserved drawables have one). */
const textureCount = (d: PackDrawable) => (d.reserved ? [RESERVED_TEXTURE] : d.textures.slice(0, MAX_TEXTURES));

// -- creature metadata (RBF) --------------------------------------------------------

/**
 * mp_creaturemetadata_<m|f>_<collection>.ymt: expression tracks that make high
 * heels (shoes) and hair scale (hats) take effect. Only written when used.
 */
function buildCreatureMetadata(numbered: { d: PackDrawable; n: number }[]): Uint8Array | undefined {
  const heels = numbered.some(({ d }) => d.highHeels);
  const hats = numbered.some(({ d }) => d.hairScale);
  if (!heels && !hats) return undefined;
  const expression = (prefix: 'pedComp' | 'pedProp', id: number, index: number, expr: number, boneId: number) =>
    rbfElement('Item', [
      rbfUint(`${prefix}ID`, id),
      rbfUint(`${prefix}VarIndex`, index),
      rbfUint(`${prefix}ExpressionIndex`, expr),
      rbfArray('tracks', 'char_array', [33]),
      rbfArray('ids', 'short_array', [boneId]),
      rbfArray('types', 'char_array', [2]),
      rbfArray('components', 'char_array', [1]),
    ]);
  const comps = heels ? numbered.filter(({ d }) => d.kind === 'component' && d.slot === 'feet').map(({ n }) => expression('pedComp', 6, n, 4, 28462)) : [];
  const props = hats
    ? [
        // Base-game files start with this entry; FiveM may crash without it.
        expression('pedProp', 0, -1, -1, 13201),
        ...numbered.filter(({ d }) => d.kind === 'prop' && d.slot === 'p_head').map(({ n }) => expression('pedProp', 0, n, 0, 13201)),
      ]
    : [];
  return writeRbf(rbfElement('CCreatureMetaData', [rbfElement('pedCompExpressions', comps), rbfElement('pedPropExpressions', props)]));
}

// -- text files ------------------------------------------------------------------

function shopMeta(gender: Gender, collection: string): string {
  const ped = PED_NAMES[gender];
  return `<?xml version="1.0" encoding="UTF-8"?>
<ShopPedApparel>
    <pedName>${ped}</pedName>
    <dlcName>${collection}</dlcName>
    <fullDlcName>${ped}_${collection}</fullDlcName>
    <eCharacter>${gender === 'male' ? 'SCR_CHAR_MULTIPLAYER' : 'SCR_CHAR_MULTIPLAYER_F'}</eCharacter>
    <creatureMetaData>mp_creaturemetadata_${gender === 'male' ? 'm' : 'f'}_${collection}</creatureMetaData>
    <pedOutfits>
    </pedOutfits>
    <pedComponents>
    </pedComponents>
    <pedProps>
    </pedProps>
</ShopPedApparel>
`;
}

const source = (dlc: string, component: number, index: number) =>
  `            <Item>\n              <dlcNameHash>${dlc}</dlcNameHash>\n              <component value="${component}" />\n              <index value="${index}" />\n            </Item>`;

function switchXml(dlc: string | undefined, index: number, sources: string[]): string {
  return `        <Item>
${dlc ? `          <dlcNameHash>${dlc}</dlcNameHash>\n` : ''}          <component value="2" />
          <index value="${index}" />
          <alt value="1" />
          <sourceAssets>
${sources.join('\n')}
          </sourceAssets>
        </Item>`;
}

const expand = (entries: DlcEntries) => entries.flatMap(([dlc, indices]) => indices.map((i) => [dlc, i] as const));

/**
 * Hair alternates for one ped in one collection: masks that hide hair switch
 * every base-game and addon hair to its alternate; addon hairs switch under
 * base-game masks.
 */
function alternateSwitches(gender: Gender, collection: string, numbered: { d: PackDrawable; n: number }[]): string[] {
  const masks = numbered.filter(({ d }) => d.kind === 'component' && d.slot === 'berd' && d.hidesHair).map(({ n }) => source(collection, 1, n));
  const hairs = numbered.filter(({ d }) => d.kind === 'component' && d.slot === 'hair');
  const out: string[] = [];
  if (masks.length) {
    for (const [dlc, index] of expand(BASE_HAIRS[gender])) out.push(switchXml(dlc || undefined, index, masks));
    for (const { n } of hairs) out.push(switchXml(collection, n, masks));
  }
  const baseMasks = expand(BASE_MASKS[gender]).map(([dlc, i]) => source(dlc, 1, i));
  for (const { d, n } of hairs) if (d.maskAlternate !== false) out.push(switchXml(collection, n, baseMasks));
  return out;
}

function alternatesXml(switches: Record<Gender, string[]>): string {
  const peds = (['male', 'female'] as Gender[])
    .filter((g) => switches[g].length)
    .map((g) => `    <Item>\n      <name>${PED_NAMES[g]}</name>\n      <switches>\n${switches[g].join('\n')}\n      </switches>\n    </Item>`);
  return `<?xml version="1.0" encoding="utf-8"?>
<CAlternateVariations>
  <peds>
${peds.join('\n')}
  </peds>
</CAlternateVariations>
`;
}

function firstPersonXml(assets: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<FirstPersonAlternateData>
    <alternates>
${assets.map((a) => `        <Item>\n            <assetName>${a}</assetName>\n            <alternate value="1" />\n        </Item>`).join('\n')}
    </alternates>
</FirstPersonAlternateData>
`;
}

function fxmanifest(metas: string[], firstPerson?: string, alternates?: string): string {
  const files = [...metas, ...(firstPerson ? [firstPerson] : []), ...(alternates ? [alternates] : [])];
  return `-- Generated by GTA V Asset Preview (VS Code)

fx_version 'cerulean'
game 'gta5'

files {
${files.map((f) => `  '${f}'`).join(',\n')}
}

${metas.map((m) => `data_file 'SHOP_PED_APPAREL_META_FILE' '${m}'`).join('\n')}
${firstPerson ? `data_file 'PED_FIRST_PERSON_ALTERNATE_DATA' '${firstPerson}'\n` : ''}${alternates ? `data_file 'ALTERNATE_VARIATIONS_FILE' '${alternates}'\n` : ''}`;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** Audio, flags, heels, hair scale and render flags per drawable, from a decoded CPedVariationInfo. */
function rawSettings(raw: unknown): Map<string, Partial<PackDrawable>> {
  const out = new Map<string, Partial<PackDrawable>>();
  const root = raw as { compInfos?: Record<string, unknown>[]; propInfo?: { aPropMetaData?: Record<string, unknown>[] } } | undefined;
  const audio = (v: unknown) => {
    const name = audioName(v);
    return name && name !== 'none' ? { audio: name } : {};
  };
  for (const c of root?.compInfos ?? []) {
    const heels = Array.isArray(c.pedXml_expressionMods) ? Number(c.pedXml_expressionMods[4]) || 0 : 0;
    out.set(`component/${c.pedXml_compIdx}/${c.pedXml_drawblIdx}`, {
      ...audio(c.pedXml_audioID),
      ...(Number(c.flags) ? { flags: Number(c.flags) } : {}),
      ...(heels ? { highHeels: heels } : {}),
    });
  }
  for (const p of root?.propInfo?.aPropMetaData ?? []) {
    const scale = Array.isArray(p.expressionMods) ? Number(p.expressionMods[0]) || 0 : 0;
    const bits = Number(p.renderFlags) || 0;
    const render = RENDER_FLAGS.find((_, i) => i > 0 && bits & (1 << (i - 1)));
    out.set(`prop/${p.anchorId}/${p.propId}`, {
      ...audio(p.audioId),
      ...(Number(p.propFlags) ? { flags: Number(p.propFlags) } : {}),
      ...(scale < 0 ? { hairScale: -scale } : {}),
      ...(render ? { renderFlag: render } : {}),
    });
  }
  return out;
}

/** An audio id from a decoded Hash value (a known name, or `hash_XXXXXXXX`). */
function audioName(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v : '';
  const m = /^hash_([0-9a-f]{8})$/i.exec(s);
  if (!m) return s || undefined;
  const hash = parseInt(m[1], 16);
  for (const list of Object.values(AUDIO_IDS)) for (const name of list) if (joaat(name) === hash) return name;
  return s;
}

/**
 * Drawables of an existing addon collection, from its parsed .ymt. `find`
 * resolves a streamed file name (e.g. `jbib_000_u.ydd`, without the collection
 * prefix) to a path relative to the project file, if the file exists.
 */
export function drawablesFromYmt(
  variation: PedVariationData,
  gender: Gender,
  find: (name: string, kind: DrawableKind) => string | undefined,
  raw?: unknown
): { drawables: PackDrawable[]; missing: string[] } {
  const drawables: PackDrawable[] = [];
  const missing: string[] = [];
  const settings = rawSettings(raw);
  const add = (kind: DrawableKind, slot: PedSlot) => {
    const key = kind === 'prop' ? `p_${slot.key.replace(/^p_/, '')}` : slot.key;
    for (const d of slot.drawables) {
      // Files sometimes use the other suffix than the .ymt implies (`_u` vs `_r`); accept either.
      const alt = kind === 'component' ? d.file.replace(/_([ur])$/i, (_, s: string) => (s.toLowerCase() === 'u' ? '_r' : '_u')) : d.file;
      const model = find(`${d.file}.ydd`, kind) ?? find(`${alt}.ydd`, kind);
      const file = model && !find(`${d.file}.ydd`, kind) ? alt : d.file;
      if (!model) {
        missing.push(`${d.file}.ydd`);
        continue;
      }
      const textures = d.textures.map((t) => find(`${t.file}.ytd`, kind)).filter((t): t is string => !!t);
      if (textures.length < d.textures.length) missing.push(...d.textures.filter((t) => !find(`${t.file}.ytd`, kind)).map((t) => `${t.file}.ytd`));
      const cloth = d.cloth ? find(`${file}.yld`, kind) : undefined;
      const firstPerson = d.alternatives > 0 ? find(`${file}_1.ydd`, kind) : undefined;
      const extra = settings.get(`${kind}/${slot.slot}/${d.index}`) ?? {};
      drawables.push({
        id: newId(),
        gender,
        kind,
        slot: key,
        model,
        textures,
        ...(kind === 'component' && /_r$/i.test(file) ? { hasSkin: true } : {}),
        ...(cloth ? { cloth } : {}),
        ...(firstPerson ? { firstPerson } : {}),
        ...extra,
      });
    }
  };
  for (const s of variation.components) add('component', s);
  for (const s of variation.props) add('prop', s);
  return { drawables, missing };
}
