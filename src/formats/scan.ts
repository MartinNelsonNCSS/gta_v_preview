import { ResourceReader } from './reader';
import { Rsc7Resource, readHeader, ResourceError } from './rsc7';
import { DrawableRefs, readDrawableRefs } from './drawable';
import { readTextureInfo } from './textures';
import { fragmentDrawables } from './yft';
import { parseYtyp } from './ytyp';
import { parseYmap } from './ymap';

/**
 * Compact summaries of asset files for workspace-wide checks and browsing.
 * Resource files only need their system segment (see SystemInflater), which
 * keeps scanning large texture packs cheap.
 */

export type AssetKind = 'ytd' | 'ydr' | 'ydd' | 'yft' | 'ytyp' | 'ymap' | 'ybn' | 'ymt';
export const ASSET_KINDS: AssetKind[] = ['ytd', 'ydr', 'ydd', 'yft', 'ytyp', 'ymap', 'ybn', 'ymt'];
/** Kinds whose summary only needs the system segment. */
export const SYSTEM_ONLY_KINDS: AssetKind[] = ['ytd', 'ydr', 'ydd', 'yft', 'ybn'];

export type TextureInfo = ReturnType<typeof readTextureInfo>;

export interface ArchetypeInfo {
  name: string;
  type: string;
  assetType: string;
  drawableDictionary: string;
  textureDictionary: string;
  /** Archetype names placed inside an interior (MLO) definition. */
  mloEntities?: string[];
}

export interface AssetSummary {
  kind: AssetKind;
  /** Virtual (system) and physical (graphics) memory from the RSC7 header. */
  systemSize: number;
  graphicsSize: number;
  encrypted?: boolean;
  error?: string;
  /** .ytd textures. */
  textures?: TextureInfo[];
  /** .ydr/.ydd/.yft drawables (with their embedded textures and texture references). */
  drawables?: DrawableRefs[];
  /** .ytyp archetypes. */
  archetypes?: ArchetypeInfo[];
  /** .ymap entities: archetype name → placement count. */
  entities?: { archetype: string; count: number; mloInstance: boolean }[];
}

const FXAP = 0x50415846;

export function isEncrypted(head: Uint8Array): boolean {
  return head.length >= 4 && (head[0] | (head[1] << 8) | (head[2] << 16) | (head[3] << 24)) === FXAP;
}

/** Header-only summary (sizes / encryption) for files that couldn't be read further. */
export function headerSummary(kind: AssetKind, head: Uint8Array, error?: string): AssetSummary {
  if (isEncrypted(head)) return { kind, systemSize: 0, graphicsSize: 0, encrypted: true };
  try {
    const h = readHeader(head);
    return { kind, systemSize: h.systemSize, graphicsSize: h.graphicsSize, error };
  } catch (err) {
    return { kind, systemSize: 0, graphicsSize: 0, error: error ?? (err as Error).message };
  }
}

/**
 * Summarises a resource file from its header and system segment
 * (textures, drawables and collisions).
 */
export function summarizeResource(kind: AssetKind, head: Uint8Array, res: Rsc7Resource): AssetSummary {
  const base = headerSummary(kind, head);
  if (base.encrypted || base.error) return base;
  const r = new ResourceReader(res);
  const ROOT = 0x50000000;
  try {
    switch (kind) {
      case 'ytd': {
        const list = r.list(ROOT + 0x30);
        return { ...base, textures: r.ptrArray(list.items, list.count).map((p) => readTextureInfo(r, p)) };
      }
      case 'ydr':
        return { ...base, drawables: [readDrawableRefs(r, ROOT)] };
      case 'ydd': {
        const list = r.list(ROOT + 0x30);
        return { ...base, drawables: r.ptrArray(list.items, list.count).map((p) => readDrawableRefs(r, p)) };
      }
      case 'yft':
        return {
          ...base,
          drawables: fragmentDrawables(r).map(({ ptr, name }) => ({ ...readDrawableRefs(r, ptr, 'frag'), name })),
        };
      default:
        return base;
    }
  } catch (err) {
    return { ...base, error: (err as Error).message };
  }
}

/** Summarises a meta file (.ytyp / .ymap / .ymt) from its full contents. */
export function summarizeMeta(kind: AssetKind, file: Uint8Array, knownNames: Iterable<string>): AssetSummary {
  const head = file.subarray(0, 16);
  if (file[0] === 0x3c) return { kind, systemSize: 0, graphicsSize: 0 }; // XML
  const base = headerSummary(kind, head);
  if (base.encrypted || base.error) return base;
  try {
    if (kind === 'ytyp') {
      const y = parseYtyp(file, { knownNames });
      return {
        ...base,
        archetypes: y.archetypes.map((a) => ({
          name: a.name,
          type: a.type,
          assetType: a.assetType,
          drawableDictionary: a.drawableDictionary,
          textureDictionary: a.textureDictionary,
          mloEntities: a.mlo ? [...new Set(a.mlo.entities.map((e) => e.archetype))] : undefined,
        })),
      };
    }
    if (kind === 'ymap') {
      const y = parseYmap(file, { knownNames });
      const counts = new Map<string, { count: number; mloInstance: boolean }>();
      for (const e of y.entities) {
        const c = counts.get(e.archetype) ?? { count: 0, mloInstance: !!e.isMloInstance };
        c.count++;
        counts.set(e.archetype, c);
      }
      return { ...base, entities: [...counts].map(([archetype, c]) => ({ archetype, ...c })) };
    }
    return base;
  } catch (err) {
    return { ...base, error: err instanceof ResourceError ? err.message : (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// fxmanifest.lua
// ---------------------------------------------------------------------------

export interface ManifestInfo {
  /** data_file entries: type → glob patterns (with their line numbers). */
  dataFiles: { type: string; pattern: string; line: number }[];
  thisIsAMap: boolean;
}

/** Extracts the parts of an fxmanifest.lua / __resource.lua the checks need. */
export function parseManifest(text: string): ManifestInfo {
  const dataFiles: ManifestInfo['dataFiles'] = [];
  const lines = text.split(/\r?\n/);
  // Strip Lua comments so commented-out entries don't count.
  const code = lines.map((l) => l.replace(/--.*$/, ''));
  code.forEach((line, i) => {
    const re = /data_file\s*\(?\s*['"]([A-Za-z0-9_]+)['"]\s*\)?\s*\(?\s*(\{[^}]*\}|['"][^'"]*['"])/g;
    for (let m = re.exec(line); m; m = re.exec(line)) {
      for (const p of m[2].matchAll(/['"]([^'"]+)['"]/g)) dataFiles.push({ type: m[1].toUpperCase(), pattern: p[1], line: i });
    }
  });
  return { dataFiles, thisIsAMap: /this_is_a_map\s*\(?\s*['"]yes['"]/i.test(code.join('\n')) };
}

/** FiveM-style glob (`*` within a folder, `**` across folders) → case-insensitive RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}
