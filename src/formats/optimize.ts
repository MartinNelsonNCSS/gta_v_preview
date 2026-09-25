import { ResourceReader } from './reader';
import { readRsc7, readHeader, ResourceError } from './rsc7';
import { decodeToRgba, formatCode, textureDataSize } from './textures';
import { downsample, EncodableFormat, encodeMipChain, isEncodable, mipLevelsFor } from './bcEncode';
import { packSegment } from './resourceBuilder';
import { dictionaryTextures, rawTexture, rebuildYtd, TextureChange } from './textureEdit';
import type { TextureInfo } from './scan';

/**
 * Batch texture optimisation for .ytd files: cap sizes, add missing mipmaps,
 * compress uncompressed textures. Planning is pure (usable in the webview for
 * live estimates); applying rebuilds each .ytd once so its memory shrinks.
 */

export interface OptimizeOptions {
  /** Largest allowed dimension (textures above it are halved until they fit). 0 = no cap. */
  maxSize: number;
  /** Generate mipmaps for textures that have none. */
  addMips: boolean;
  /** Convert 32-bit uncompressed textures to DXT1/DXT5. */
  compress: boolean;
}

export interface TexturePlan {
  name: string;
  width: number;
  height: number;
  format: string;
  levels: number;
  /** New data size in bytes. */
  size: number;
  /** Human-readable summary, e.g. "4096→2048, add mips". */
  reasons: string[];
  /** Why it can't be done, if it can't. */
  blocked?: string;
}

const UNCOMPRESSED_32 = new Set(['A8R8G8B8', 'X8R8G8B8', 'A8B8G8R8']);

/** What should change for one texture under `options` (undefined if nothing). */
export function planTexture(t: TextureInfo, options: OptimizeOptions): TexturePlan | undefined {
  let width = t.width;
  let height = t.height;
  let format = t.format;
  let levels = t.levels;
  const reasons: string[] = [];

  let halvings = 0;
  if (options.maxSize > 0) {
    while (Math.max(width, height) > options.maxSize && Math.min(width, height) > 4) {
      width = Math.max(1, width >> 1);
      height = Math.max(1, height >> 1);
      halvings++;
    }
    if (halvings) reasons.push(`${t.width}×${t.height} → ${width}×${height}`);
  }
  if (options.compress && UNCOMPRESSED_32.has(t.format) && width % 4 === 0 && height % 4 === 0) {
    // DXT5 keeps alpha; X8R8G8B8 has none. Whether an A8 texture actually uses alpha is decided when applying.
    format = t.format === 'X8R8G8B8' ? 'DXT1' : 'DXT5';
    reasons.push(`${t.format} → ${format}`);
  }
  if (options.addMips && t.levels === 1 && Math.max(width, height) > 4 && isEncodable(format)) {
    levels = mipLevelsFor(format as EncodableFormat, width, height);
    if (levels > 1) reasons.push(`add ${levels - 1} mips`);
  } else if (halvings) {
    levels = Math.max(1, t.levels - halvings);
  }
  if (!reasons.length) return undefined;

  const size = textureDataSize(formatCode(format) ?? -1, width, height, levels) ?? 0;
  const plan: TexturePlan = { name: t.name, width, height, format, levels, size, reasons };
  // Re-encoding is needed unless we're only dropping mips we already have.
  const reencode = format !== t.format || levels > t.levels - halvings;
  if (reencode && (t.format === 'BC7' || !formatCode(t.format) || !isEncodable(format))) {
    plan.blocked = `${t.format} can't be re-encoded here`;
  }
  return plan;
}

/** Physical (graphics) memory a .ytd would need with these texture data sizes. */
export function estimateGraphicsSize(sizes: number[]): number {
  return packSegment(sizes).size;
}

export interface OptimizeResult {
  file: Uint8Array;
  before: { system: number; graphics: number };
  after: { system: number; graphics: number };
  changed: string[];
  skipped: { name: string; reason: string }[];
}

/** Applies plans to a .ytd, rebuilding it once. */
export function optimizeYtd(file: Uint8Array, plans: TexturePlan[]): OptimizeResult {
  const before = readHeader(file);
  const r = new ResourceReader(readRsc7(file));
  const byName = new Map(dictionaryTextures(r, 0x50000000).map((loc) => [loc.name.toLowerCase(), loc]));
  const changes = new Map<string, TextureChange>();
  const skipped: OptimizeResult['skipped'] = [];

  for (const plan of plans) {
    const loc = byName.get(plan.name.toLowerCase());
    if (!loc) {
      skipped.push({ name: plan.name, reason: 'not found' });
      continue;
    }
    if (plan.blocked) {
      skipped.push({ name: plan.name, reason: plan.blocked });
      continue;
    }
    try {
      const t = rawTexture(r, loc);
      const raw = r.bytes(t.dataPtr, t.size);
      // How many top mips are dropped to reach the planned size.
      let k = 0;
      while ((t.width >> k) > plan.width && k < 16) k++;
      if (plan.format === t.formatName && plan.levels <= t.levels - k && t.width >> k === plan.width && t.height >> k === plan.height) {
        // Lossless: reuse the existing lower mips.
        const skip = textureDataSize(t.format, t.width, t.height, k)!;
        const keep = textureDataSize(t.format, plan.width, plan.height, plan.levels)!;
        changes.set(loc.name.toLowerCase(), { width: plan.width, height: plan.height, levels: plan.levels, format: t.formatName, data: raw.slice(skip, skip + keep) });
        continue;
      }
      // Re-encode from the best existing level at or above the target size.
      let level = Math.max(0, Math.min(k, t.levels - 1));
      while (level > 0 && (t.width >> level < plan.width || t.height >> level < plan.height)) level--;
      const offset = textureDataSize(t.format, t.width, t.height, level)!;
      let w = Math.max(1, t.width >> level);
      let hgt = Math.max(1, t.height >> level);
      let rgba = decodeToRgba(t.format, raw.subarray(offset, offset + textureDataSize(t.format, w, hgt, 1)!), w, hgt);
      while (w > plan.width || hgt > plan.height) {
        const half = downsample(rgba, w, hgt);
        rgba = half.data;
        w = half.w;
        hgt = half.h;
      }
      let format = plan.format as EncodableFormat;
      if (UNCOMPRESSED_32.has(t.formatName) && format === 'DXT5' && !hasAlpha(rgba)) format = 'DXT1';
      changes.set(loc.name.toLowerCase(), { width: w, height: hgt, levels: plan.levels, format, data: encodeMipChain(format, rgba, w, hgt, plan.levels) });
    } catch (err) {
      skipped.push({ name: plan.name, reason: (err as Error).message });
    }
  }
  if (!changes.size) throw new ResourceError('Nothing could be optimised in this file.');
  const out = rebuildYtd(file, r, changes);
  const after = readHeader(out);
  return {
    file: out,
    before: { system: before.systemSize, graphics: before.graphicsSize },
    after: { system: after.systemSize, graphics: after.graphicsSize },
    changed: [...changes.keys()],
    skipped,
  };
}

function hasAlpha(rgba: Uint8Array): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 250) return true;
  return false;
}
