/*
 * Mod-kit liveries: liveries made as separate models (VMT_LIVERY_MOD parts in
 * a carcols.meta kit) rather than `_sign_N` textures. The game shows the
 * livery model's own texture (on a vehicle_paint shader's DiffuseSampler2)
 * when the mod is fitted with SET_VEHICLE_MOD(vehicle, 48, index).
 *
 * Everything here works on the meta files' text, so edits keep the file's
 * formatting, comments and line endings.
 */

export interface LiveryMod {
  modelName: string;
  label: string;
  /** Position among the kit's livery mods: the index for SET_VEHICLE_MOD(…, 48, index). */
  index: number;
  /** Character range of the mod's <Item> block in the file. */
  start: number;
  end: number;
}

export interface ModKit {
  kitName: string;
  id?: number;
  liveries: LiveryMod[];
  /** Range of the kit's <visibleMods> contents (for inserting). */
  visibleMods?: { start: number; end: number };
}

interface Block {
  start: number;
  end: number;
}

/** Top-level <Item> blocks between `from` and `to` (nested Items are skipped over). */
function itemBlocks(xml: string, from: number, to: number): Block[] {
  const re = /<(\/?)Item\b[^>]*?(\/?)>/g;
  re.lastIndex = from;
  const out: Block[] = [];
  let depth = 0;
  let start = -1;
  for (let m = re.exec(xml); m && m.index < to; m = re.exec(xml)) {
    if (m[2]) {
      if (depth === 0) out.push({ start: m.index, end: m.index + m[0].length });
      continue;
    }
    if (!m[1]) {
      if (depth === 0) start = m.index;
      depth++;
    } else {
      depth--;
      if (depth === 0 && start >= 0) out.push({ start, end: m.index + m[0].length });
      if (depth < 0) depth = 0;
    }
  }
  return out;
}

/** Range of the contents of the first <tag>…</tag> at or after `from` (before `to`). */
function section(xml: string, tag: string, from: number, to: number): Block | undefined {
  const open = new RegExp(`<${tag}\\b[^>]*?(/?)>`, 'g');
  open.lastIndex = from;
  const m = open.exec(xml);
  if (!m || m.index >= to || m[1]) return undefined;
  const close = xml.indexOf(`</${tag}>`, m.index + m[0].length);
  if (close < 0 || close > to) return undefined;
  return { start: m.index + m[0].length, end: close };
}

const field = (block: string, tag: string) => new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`).exec(block)?.[1];

/** The mod kits in a carcols.meta, with their livery mods. */
export function parseKits(xml: string): ModKit[] {
  const kits = section(xml, 'Kits', 0, xml.length);
  if (!kits) return [];
  return itemBlocks(xml, kits.start, kits.end).flatMap((b): ModKit[] => {
    const text = xml.slice(b.start, b.end);
    const kitName = field(text, 'kitName');
    if (!kitName) return [];
    const id = /<id\s+value="(\d+)"/.exec(text)?.[1];
    const visibleMods = section(xml, 'visibleMods', b.start, b.end);
    const liveries: LiveryMod[] = [];
    if (visibleMods) {
      for (const m of itemBlocks(xml, visibleMods.start, visibleMods.end)) {
        const mod = xml.slice(m.start, m.end);
        if (field(mod, 'type') !== 'VMT_LIVERY_MOD') continue;
        liveries.push({ modelName: field(mod, 'modelName') ?? '', label: field(mod, 'modShopLabel') ?? '', index: liveries.length, start: m.start, end: m.end });
      }
    }
    return [{ kitName, ...(id ? { id: Number(id) } : {}), liveries, ...(visibleMods ? { visibleMods } : {}) }];
  });
}

/** Kit names a vehicle uses, from its carvariations.meta entry. */
export function vehicleKits(carvariations: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const items = [...carvariations.matchAll(/<Item>\s*<modelName>\s*([^<\s]+)\s*<\/modelName>[\s\S]*?(?=<Item>\s*<modelName>|<\/variationData>|$)/gi)];
  for (const m of items) {
    const kits = /<kits>([\s\S]*?)<\/kits>/i.exec(m[0])?.[1] ?? '';
    const names = [...kits.matchAll(/<Item>\s*([^<\s]+)\s*<\/Item>/g)].map((k) => k[1]);
    if (names.length) out.set(m[1], names);
  }
  return out;
}

/** Problems with a model / label name for a new livery, or undefined if fine. */
export function liveryNameProblem(name: string): string | undefined {
  if (!name) return 'Enter a name.';
  if (!/^[a-z0-9_]+$/i.test(name)) return 'Use only letters, digits and underscores.';
  if (name.length > 63) return 'Keep it under 64 characters.';
  return undefined;
}

/**
 * Adds a livery mod to kit `kitName`: a copy of the kit's last livery mod
 * (so bone, camera and other settings match the vehicle's own liveries) with
 * a new model name and label, placed after it. Returns the new text and the
 * mod's index, or an error.
 */
export function addLiveryMod(xml: string, kitName: string, modelName: string, label: string): { text: string; index: number } | { error: string } {
  const kit = parseKits(xml).find((k) => k.kitName.toLowerCase() === kitName.toLowerCase());
  if (!kit) return { error: `Kit ${kitName} isn't in this file.` };
  if (kit.liveries.some((l) => l.modelName.toLowerCase() === modelName.toLowerCase())) return { error: `${kitName} already has a livery called ${modelName}.` };
  const last = kit.liveries[kit.liveries.length - 1];
  const eol = xml.includes('\r\n') ? '\r\n' : '\n';
  let block: string;
  let at: number;
  let indent: string;
  if (last) {
    block = xml.slice(last.start, last.end);
    at = last.end;
    indent = /([ \t]*)$/.exec(xml.slice(0, last.start))?.[1] ?? '        ';
  } else {
    if (!kit.visibleMods) return { error: `${kitName} has no <visibleMods> section to add the livery to.` };
    indent = '        ';
    block = [
      '<Item>',
      `  <modelName>${modelName}</modelName>`,
      `  <modShopLabel>${label}</modShopLabel>`,
      '  <linkedModels />',
      '  <turnOffBones />',
      '  <type>VMT_LIVERY_MOD</type>',
      '  <bone>chassis</bone>',
      '  <collisionBone>chassis</collisionBone>',
      '  <cameraPos>VMCP_DEFAULT</cameraPos>',
      '  <audioApply value="1.000000" />',
      '  <weight value="20" />',
      '  <turnOffExtra value="false" />',
      '  <disableBonnetCamera value="false" />',
      '  <allowBonnetSlide value="true" />',
      '</Item>',
    ].join(`${eol}${indent}`);
    at = kit.visibleMods.end - (/[ \t]*$/.exec(xml.slice(kit.visibleMods.start, kit.visibleMods.end))?.[0].length ?? 0);
    const text = `${xml.slice(0, at)}${indent}${block}${eol}${xml.slice(at)}`;
    return { text, index: 0 };
  }
  block = block
    .replace(/(<modelName>)[^<]*(<\/modelName>)/, `$1${modelName}$2`)
    .replace(/(<modShopLabel>)[^<]*(<\/modShopLabel>)/, `$1${label}$2`);
  return { text: `${xml.slice(0, at)}${eol}${indent}${block}${xml.slice(at)}`, index: kit.liveries.length };
}

/** Removes livery mod `modelName` from kit `kitName` (with its line). */
export function removeLiveryMod(xml: string, kitName: string, modelName: string): string | undefined {
  const kit = parseKits(xml).find((k) => k.kitName.toLowerCase() === kitName.toLowerCase());
  const mod = kit?.liveries.find((l) => l.modelName.toLowerCase() === modelName.toLowerCase());
  if (!mod) return undefined;
  const lineStart = xml.lastIndexOf('\n', mod.start - 1) + 1;
  const before = xml.slice(lineStart, mod.start);
  const start = /^[ \t]*$/.test(before) ? lineStart : mod.start;
  let end = mod.end;
  const rest = /^[ \t]*\r?\n/.exec(xml.slice(end));
  if (rest && start === lineStart) end += rest[0].length;
  return xml.slice(0, start) + xml.slice(end);
}

/** Lua for a client script naming liveries in game (AddTextEntry), merged into an existing one. */
export function labelScript(existing: string | undefined, entries: { key: string; text: string }[]): string {
  const quote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  let text = existing ?? '-- Names shown in game (mod shop, menus) for the liveries in this resource.\n-- Made with GTA V Asset Preview.\n\n';
  for (const { key, text: label } of entries) {
    const line = `AddTextEntry(${quote(key)}, ${quote(label)})`;
    const re = new RegExp(`^[ \\t]*AddTextEntry\\(\\s*['"]${key}['"].*$`, 'm');
    if (re.test(text)) text = text.replace(re, line);
    else text = `${text.replace(/\s*$/, '')}\n${line}\n`;
  }
  return text;
}

/** fxmanifest.lua for a new livery resource. */
export function liveryManifest(description: string): string {
  return [
    "fx_version 'cerulean'",
    "game 'gta5'",
    '',
    `description '${description.replace(/'/g, "\\'")}'`,
    '',
    '-- Livery models are streamed from stream/; their names are set in liveries.lua.',
    "client_script 'liveries.lua'",
    '',
  ].join('\n');
}

/**
 * Suggests a model name for a new livery: the vehicle's own livery naming
 * (e.g. onx_poldom_liv_lspd1 → onx_poldom_liv_custom1), not clashing with `taken`.
 */
export function suggestLiveryName(kit: ModKit, vehicle: string, taken: Set<string>): string {
  const names = kit.liveries.map((l) => l.modelName.toLowerCase());
  const prefix = names.length ? (/^(.*_liv_?)/.exec(names[0])?.[1] ?? `${vehicle}_liv_`) : `${vehicle}_liv_`;
  for (let n = 1; ; n++) {
    const name = `${prefix}custom${n}`;
    if (!names.includes(name) && !taken.has(name)) return name;
  }
}
