import { arr, num, readMeta, str } from './mapShared';
import type { MetaObject } from './meta';
import type { PedDrawable, PedVariationData, YmtData } from '../shared/model';

/** Ped component slots, in availComp order, with the names FiveM tools use. */
export const PED_COMPONENTS = [
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
];

/** Prop anchors (eAnchorPoints order) and their file-name keys. */
const ANCHORS: Record<string, { key: string; label: string }> = {
  ANCHOR_HEAD: { key: 'head', label: 'Hats' },
  ANCHOR_EYES: { key: 'eyes', label: 'Glasses' },
  ANCHOR_EARS: { key: 'ears', label: 'Ears' },
  ANCHOR_MOUTH: { key: 'mouth', label: 'Mouth' },
  ANCHOR_LEFT_HAND: { key: 'lhand', label: 'Left hand' },
  ANCHOR_RIGHT_HAND: { key: 'rhand', label: 'Right hand' },
  ANCHOR_LEFT_WRIST: { key: 'lwrist', label: 'Watches' },
  ANCHOR_RIGHT_WRIST: { key: 'rwrist', label: 'Bracelets' },
  ANCHOR_HIP: { key: 'hip', label: 'Hip' },
  ANCHOR_LEFT_FOOT: { key: 'lfoot', label: 'Left foot' },
  ANCHOR_RIGHT_FOOT: { key: 'rfoot', label: 'Right foot' },
  ANCHOR_PH_L_HAND: { key: 'ph_lhand', label: 'Left hand (ph)' },
  ANCHOR_PH_R_HAND: { key: 'ph_rhand', label: 'Right hand (ph)' },
};
const ANCHOR_ORDER = Object.keys(ANCHORS);

/** CPVTextureData.texId → the race suffix used in texture file names. */
const RACES = ['uni', 'whi', 'bla', 'chi', 'lat', 'ara', 'bal', 'jam', 'kor', 'ita', 'pak'];

const pad3 = (n: number) => String(n).padStart(3, '0');
const letter = (i: number) => String.fromCharCode(97 + i);

export interface YmtOptions {
  knownNames?: Iterable<string>;
}

/** Parses an RSC7 .ymt. Ped variation files get a structured summary. */
export function parseYmt(file: Uint8Array, opts: YmtOptions = {}): YmtData {
  const { root, doc } = readMeta(file, undefined, opts.knownNames);
  return {
    name: doc.name ?? '',
    rootType: root._type,
    pedVariation: root._type === 'CPedVariationInfo' ? toPedVariation(root) : undefined,
    raw: root,
  };
}

function toPedVariation(root: MetaObject): PedVariationData {
  const avail = Array.isArray(root.availComp) ? (root.availComp as number[]) : [];
  const compData = arr(root.aComponentData3);
  const components = PED_COMPONENTS.flatMap((c, slot) => {
    const data = compData[avail[slot]];
    if (avail[slot] === undefined || avail[slot] === 255 || !data) return [];
    const drawables: PedDrawable[] = arr(data.aDrawblData3).map((d, i) => {
      const texData = arr(d.aTexData);
      const raceSpecific = texData.some((t) => num(t.texId) !== 0);
      return {
        index: i,
        file: `${c.key}_${pad3(i)}_${raceSpecific ? 'r' : 'u'}`,
        textures: texData.map((t, ti) => {
          const race = RACES[num(t.texId)] ?? 'uni';
          return { letter: letter(ti), file: `${c.key}_diff_${pad3(i)}_${letter(ti)}_${race}` };
        }),
        cloth: !!(d.clothData as MetaObject | undefined)?.ownsCloth,
        alternatives: num(d.numAlternatives),
      };
    });
    return [{ slot, key: c.key, label: c.label, drawables }];
  });

  // Props: one entry per (anchor, prop id) in aPropMetaData.
  const propInfo = root.propInfo as MetaObject | undefined;
  const byAnchor = new Map<string, PedDrawable[]>();
  for (const meta of arr(propInfo?.aPropMetaData)) {
    const anchorName = typeof meta.anchorId === 'string' ? meta.anchorId : ANCHOR_ORDER[num(meta.anchorId)] ?? `anchor_${meta.anchorId}`;
    const anchor = ANCHORS[anchorName]?.key ?? anchorName.toLowerCase();
    const id = num(meta.propId);
    const list = byAnchor.get(anchorName) ?? [];
    list.push({
      index: id,
      file: `p_${anchor}_${pad3(id)}`,
      textures: arr(meta.texData).map((_, ti) => ({ letter: letter(ti), file: `p_${anchor}_diff_${pad3(id)}_${letter(ti)}` })),
      cloth: false,
      alternatives: 0,
    });
    byAnchor.set(anchorName, list);
  }
  const props = [...byAnchor.entries()]
    .sort((a, b) => ANCHOR_ORDER.indexOf(a[0]) - ANCHOR_ORDER.indexOf(b[0]))
    .map(([anchorName, drawables]) => ({
      slot: ANCHOR_ORDER.indexOf(anchorName),
      key: `p_${ANCHORS[anchorName]?.key ?? anchorName.toLowerCase()}`,
      label: ANCHORS[anchorName]?.label ?? anchorName,
      drawables: drawables.sort((a, b) => a.index - b.index),
    }));

  return {
    dlcName: str(root.dlcName),
    hasLowLods: !!root.bHasLowLODs,
    components,
    props,
    selectionSets: arr(root.aSelectionSets).length,
  };
}
