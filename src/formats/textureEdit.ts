import { deflateSync } from 'fflate';
import { ResourceReader } from './reader';
import { readRsc7, ResourceError } from './rsc7';
import { decodeToRgba, formatCode, readTexture, textureDataSize } from './textures';
import { encodeMipChain, isBlockFormat, isEncodable, maxMipLevels, mipLevelsFor } from './bcEncode';
import { packSegment } from './resourceBuilder';
import { fragmentDrawables } from './yft';
import { buildDds, parseDds } from './dds';
import { joaat } from './hash';
import { textureNameProblem } from './textureNames';

export { textureNameProblem };
import type { TextureData } from '../shared/model';

/**
 * Reading and rewriting individual textures inside resource files. Replacing
 * keeps the texture's size, format and mip count, so only its pixel bytes
 * change and the resource layout stays valid.
 */

export type TextureFileKind = 'ytd' | 'ydr' | 'ydd' | 'yft';

const ROOT = 0x50000000;

export interface TextureLocation {
  name: string;
  ptr: number;
}

/** The embedded texture dictionary of a drawable, if any. */
function drawableTxd(r: ResourceReader, drawablePtr: number): number | undefined {
  if (!r.isValid(drawablePtr)) return undefined;
  const shaderGroup = r.ptr(drawablePtr + 0x10);
  if (!r.isValid(shaderGroup)) return undefined;
  const txd = r.ptr(shaderGroup + 0x08);
  return r.isValid(txd) ? txd : undefined;
}

export function dictionaryTextures(r: ResourceReader, txd: number | undefined): TextureLocation[] {
  if (txd === undefined) return [];
  const list = r.list(txd + 0x30);
  return r.ptrArray(list.items, list.count).map((ptr) => ({ ptr, name: r.string(r.ptr(ptr + 0x28)) ?? '' }));
}

/** Every texture with pixel data in a file of the given kind. */
export function locateTextures(r: ResourceReader, kind: TextureFileKind): TextureLocation[] {
  switch (kind) {
    case 'ytd':
      return dictionaryTextures(r, ROOT);
    case 'ydr':
      return dictionaryTextures(r, drawableTxd(r, ROOT));
    case 'ydd': {
      const list = r.list(ROOT + 0x30);
      return r.ptrArray(list.items, list.count).flatMap((d) => dictionaryTextures(r, drawableTxd(r, d)));
    }
    case 'yft':
      return fragmentDrawables(r).flatMap((d) => dictionaryTextures(r, drawableTxd(r, d.ptr)));
  }
}

function findTexture(r: ResourceReader, kind: TextureFileKind, name: string): TextureLocation {
  const key = name.toLowerCase();
  const found = locateTextures(r, kind).find((t) => t.name.toLowerCase() === key);
  if (!found) throw new ResourceError(`Texture "${name}" was not found in this file.`);
  return found;
}

export interface RawTexture {
  name: string;
  width: number;
  height: number;
  format: number;
  formatName: string;
  levels: number;
  dataPtr: number;
  size: number;
}

export function rawTexture(r: ResourceReader, loc: TextureLocation): RawTexture {
  const width = r.u16(loc.ptr + 0x50);
  const height = r.u16(loc.ptr + 0x52);
  const format = r.u32(loc.ptr + 0x58);
  const levels = Math.max(1, r.u8(loc.ptr + 0x5d));
  const dataPtr = r.ptr(loc.ptr + 0x70);
  const size = textureDataSize(format, width, height, levels);
  const formatName = readTexture(r, loc.ptr, { maxSize: 1 }).format;
  if (size === undefined) throw new ResourceError(`Texture "${loc.name}" uses an unsupported format (${formatName}).`);
  if (!r.isValid(dataPtr)) throw new ResourceError(`Texture "${loc.name}" has no pixel data in this file.`);
  return { name: loc.name, width, height, format, formatName, levels, dataPtr, size };
}

/** Decodes a texture at full resolution (BC7 stays compressed, for GPU decoding). */
export function readFullTexture(file: Uint8Array, kind: TextureFileKind, name: string): TextureData {
  const r = new ResourceReader(readRsc7(file));
  return readTexture(r, findTexture(r, kind, name).ptr, { maxSize: 1 << 16 });
}

/** The texture's original compressed data as a .dds file (all mips). */
export function exportDds(file: Uint8Array, kind: TextureFileKind, name: string): Uint8Array {
  const r = new ResourceReader(readRsc7(file));
  const t = rawTexture(r, findTexture(r, kind, name));
  return buildDds(t.formatName, t.width, t.height, t.levels, r.bytes(t.dataPtr, t.size));
}

/** A replacement for a texture: either RGBA pixels to encode, or data already in `format`. */
export interface ReplacementImage {
  width: number;
  height: number;
  /** Target format (default: the texture's current format). */
  format?: string;
  /** Mip levels to store (default: the texture's own count if size/format are unchanged, else a full chain). */
  levels?: number;
  /** Top-level RGBA pixels (width×height×4) to encode. */
  rgba?: Uint8Array;
  /** Already-encoded data for all `levels` mips (e.g. from a .dds); used as-is. */
  encoded?: Uint8Array;
}

/**
 * Returns a copy of `file` with texture `name` replaced.
 *
 * - Same size, format and mip count: data is rewritten in place.
 * - Anything whose data fits in the texture's existing space: written in place
 *   in any file type (smaller sizes, more compact formats, fewer mips).
 * - Anything bigger: only for .ytd, which is rebuilt with a new page layout.
 */
export function replaceTexture(file: Uint8Array, kind: TextureFileKind, name: string, image: ReplacementImage): Uint8Array {
  const res = readRsc7(file);
  const r = new ResourceReader(res);
  const loc = findTexture(r, kind, name);
  const t = rawTexture(r, loc);
  const { width, height } = image;
  const target = image.format ?? t.formatName;
  const unchanged = target === t.formatName && width === t.width && height === t.height;
  const { levels, data } = encodeImage(t.name, { ...image, format: target, levels: image.levels ?? (unchanged ? t.levels : undefined) });

  if (unchanged && levels === t.levels) {
    r.bytes(t.dataPtr, t.size).set(data);
    return repack(file, res);
  }
  if (data.length <= t.size) {
    // Fits in the texture's existing data block: write in place, leaving the rest unused.
    r.bytes(t.dataPtr, data.length).set(data);
    writeTextureHeader(r.bytes(loc.ptr, 0x90), target, width, height, levels, t.dataPtr);
    return repack(file, res);
  }
  if (kind !== 'ytd') {
    throw new ResourceError(
      `${width}×${height} ${target} with ${levels} mips needs ${sizes(data.length, t.size)[0]}, but this texture only has ${sizes(data.length, t.size)[1]} inside the .${kind}. ` +
        'Choose a smaller size, a more compact format or fewer mips, or move the texture to a .ytd.'
    );
  }
  return rebuildYtd(file, r, new Map([[t.name.toLowerCase(), { width, height, levels, format: target, data }]]));
}

/**
 * Validates an image for storing as a texture and returns its data in the
 * target format (encoding RGBA when needed). Default mips: a full chain for
 * encodable formats, otherwise one level.
 */
export function encodeImage(name: string, image: ReplacementImage & { format: string }): { levels: number; data: Uint8Array } {
  const { width, height, format } = image;
  const code = formatCode(format);
  if (code === undefined) throw new ResourceError(`Unknown texture format ${format}.`);
  if (!width || !height) throw new ResourceError(`Texture "${name}" has no size.`);
  if (isBlockFormat(format) && (width % 4 || height % 4)) {
    throw new ResourceError(`${format} textures need a width and height that are multiples of 4 ("${name}" is ${width}×${height}).`);
  }
  const levels = image.levels ?? (isEncodable(format) ? mipLevelsFor(format, width, height) : 1);
  if (levels < 1 || levels > maxMipLevels(width, height)) throw new ResourceError(`A ${width}×${height} texture can have 1–${maxMipLevels(width, height)} mip levels (got ${levels}).`);
  const expected = textureDataSize(code, width, height, levels)!;
  if (image.encoded) {
    if (image.encoded.length < expected) throw new ResourceError(`The supplied ${format} data is too short for ${width}×${height} with ${levels} mips.`);
    return { levels, data: image.encoded.subarray(0, expected) };
  }
  if (!isEncodable(format)) throw new ResourceError(`Encoding ${format} isn't supported; choose another format, or use a ${format} .dds (${name}).`);
  if (!image.rgba || image.rgba.length !== width * height * 4) throw new ResourceError('Image data does not match its size.');
  return { levels, data: encodeMipChain(format, image.rgba, width, height, levels) };
}

/** Changed texture data for a .ytd rebuild. */
export interface TextureChange {
  width: number;
  height: number;
  levels: number;
  format: string;
  data: Uint8Array;
}

const kb = (n: number) => `${Math.ceil(n / 1024).toLocaleString()} KB`;
/** Two sizes for a message; exact bytes when they'd round to the same KB. */
const sizes = (a: number, b: number) => (kb(a) === kb(b) ? [`${a.toLocaleString()} bytes`, `${b.toLocaleString()} bytes`] : [kb(a), kb(b)]);

/** Bytes per pixel row (the texture "stride" field). */
function strideFor(format: string, width: number): number {
  switch (format) {
    case 'DXT1':
    case 'BC4':
      return width / 2;
    case 'A8R8G8B8':
    case 'X8R8G8B8':
    case 'A8B8G8R8':
      return width * 4;
    case 'R5G6B5':
    case 'A1R5G5B5':
      return width * 2;
    default:
      return width; // DXT3/5, BC5, BC7, A8, L8
  }
}

/** Updates size- and format-dependent fields of a 0x90-byte grcTexture. */
function writeTextureHeader(struct: Uint8Array, format: string, width: number, height: number, levels: number, dataPtr: number): void {
  const v = new DataView(struct.buffer, struct.byteOffset, struct.byteLength);
  const code = formatCode(format);
  if (code === undefined) throw new ResourceError(`Unknown texture format ${format}.`);
  v.setUint32(0x58, code, true);
  v.setUint16(0x50, width, true);
  v.setUint16(0x52, height, true);
  v.setUint16(0x56, strideFor(format, width), true);
  v.setUint8(0x5d, levels);
  v.setUint32(0x70, dataPtr >>> 0, true);
  v.setUint32(0x74, 0, true);
  // The upper usage bits describe size classes for streaming; keep only the usage type.
  v.setUint32(0x40, v.getUint32(0x40, true) & 0x1f, true);
}

/** Recompresses a resource whose layout is unchanged (same header). */
function repack(file: Uint8Array, res: { system: Uint8Array; graphics: Uint8Array }): Uint8Array {
  const payload = new Uint8Array(res.system.length + res.graphics.length);
  payload.set(res.system, 0);
  payload.set(res.graphics, res.system.length);
  return withHeader(file.subarray(0, 16), deflateSync(payload, { level: 6 }));
}

function withHeader(header: Uint8Array, compressed: Uint8Array): Uint8Array {
  const out = new Uint8Array(16 + compressed.length);
  out.set(header, 0);
  out.set(compressed, 16);
  return out;
}

/** One texture of a .ytd being written: its 0x90-byte structure (template) and data. */
interface YtdEntry {
  name: string;
  struct: Uint8Array;
  format: string;
  width: number;
  height: number;
  levels: number;
  data: Uint8Array;
  /** Size/format fields must be rewritten (new or changed data). */
  changed: boolean;
  /** Name hash stored in the file; computed from the name when absent (new or renamed). */
  hash?: number;
}

/** The textures of a .ytd as rebuild entries, in file order. */
function ytdEntries(r: ResourceReader): YtdEntry[] {
  const hashes = r.list(ROOT + 0x20);
  return dictionaryTextures(r, ROOT).map((loc, i) => {
    const t = rawTexture(r, loc);
    return {
      name: loc.name,
      struct: r.bytes(loc.ptr, 0x90).slice(),
      format: t.formatName,
      width: t.width,
      height: t.height,
      levels: t.levels,
      data: r.bytes(t.dataPtr, t.size).slice(),
      changed: false,
      hash: i < hashes.count ? r.u32(hashes.items + i * 4) : undefined,
    };
  });
}

/**
 * Rebuilds a .ytd from scratch with some textures' data replaced (keyed by
 * lower-case name). Other textures keep their exact bytes; structures are
 * copied from the original and only pointers and size fields change. The new
 * page layout fits the new data, so memory use shrinks when textures do.
 */
export function rebuildYtd(file: Uint8Array, r: ResourceReader, changes: Map<string, TextureChange>): Uint8Array {
  const entries = ytdEntries(r).map((e) => {
    const change = changes.get(e.name.toLowerCase());
    return change ? { ...e, ...change, changed: true } : e;
  });
  return writeYtd(file, r, entries);
}

/** A texture to add to a .ytd. */
export interface NewTexture extends TextureChange {
  name: string;
}

export interface YtdEdit {
  /** Renames, applied first. */
  rename?: { from: string; to: string }[];
  /** Textures to remove (after renaming). */
  remove?: string[];
  /** Textures to add; one with an existing name replaces it. */
  add?: NewTexture[];
}

/**
 * Adds, removes and renames textures in a .ytd. The dictionary is rebuilt with
 * its entries sorted by name hash (as the game looks them up); new textures
 * copy their structure from an existing texture in the file.
 */
export function editYtd(file: Uint8Array, edit: YtdEdit): Uint8Array {
  const r = new ResourceReader(readRsc7(file));
  let entries = ytdEntries(r);
  const template = entries[0]?.struct;
  const find = (name: string) => {
    const i = entries.findIndex((e) => e.name.toLowerCase() === name.toLowerCase());
    if (i < 0) throw new ResourceError(`Texture "${name}" was not found in this dictionary.`);
    return i;
  };
  for (const { from, to } of edit.rename ?? []) {
    const problem = textureNameProblem(to);
    if (problem) throw new ResourceError(`Can't rename "${from}" to "${to}": ${problem}`);
    const i = find(from);
    if (from.toLowerCase() !== to.toLowerCase() && entries.some((e) => e.name.toLowerCase() === to.toLowerCase())) {
      throw new ResourceError(`A texture named "${to}" already exists.`);
    }
    entries[i] = { ...entries[i], name: to, hash: undefined };
  }
  for (const name of edit.remove ?? []) entries.splice(find(name), 1);
  for (const t of edit.add ?? []) {
    const problem = textureNameProblem(t.name);
    if (problem) throw new ResourceError(`Can't add "${t.name}": ${problem}`);
    entries = entries.filter((e) => e.name.toLowerCase() !== t.name.toLowerCase());
    entries.push({ name: t.name, struct: newTextureStruct(template), format: t.format, width: t.width, height: t.height, levels: t.levels, data: t.data, changed: true });
  }
  if (!entries.length) throw new ResourceError('A texture dictionary needs at least one texture.');
  return writeYtd(file, r, entries);
}

/** A grcTexture structure for a new texture: a copy of an existing one, or defaults. */
function newTextureStruct(template?: Uint8Array): Uint8Array {
  const struct = template ? template.slice() : new Uint8Array(0x90);
  const v = new DataView(struct.buffer);
  if (!template) {
    v.setUint16(0x30, 1, true); // reference count
  }
  v.setUint16(0x54, 1, true); // depth
  v.setUint32(0x40, 0, true); // usage: unspecified
  return struct;
}

/** Writes a complete .ytd: entries sorted by name hash, fresh page layout. */
function writeYtd(file: Uint8Array, r: ResourceReader, unsorted: YtdEntry[]): Uint8Array {
  const entries = unsorted.map((e) => ({ ...e, hash: e.hash ?? joaat(e.name) })).sort((a, b) => a.hash - b.hash);
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].hash === entries[i - 1].hash) {
      throw new ResourceError(`"${entries[i - 1].name}" and "${entries[i].name}" have the same name hash; rename one of them.`);
    }
  }
  const n = entries.length;

  // Graphics: one block per texture (all mips).
  const gfx = packSegment(entries.map((e) => e.data.length));
  // System: dictionary (root), page info, hash array, pointer array, textures, names.
  const nameBytes = entries.map((e) => new TextEncoder().encode(`${e.name}\0`));
  const pagesInfoSize = 0x10 + 8 * (gfx.pageCount + 16); // room for up to 16 system pages
  const sysSizes = [0x40, pagesInfoSize, 4 * n, 8 * n, ...entries.map(() => 0x90), ...nameBytes.map((b) => b.length)];
  const sys = packSegment(sysSizes, true);
  if (sys.pageCount > 16) throw new ResourceError('Texture dictionary is too large to rebuild.');

  const system = new Uint8Array(sys.size);
  const graphics = new Uint8Array(gfx.size);
  const sv = new DataView(system.buffer);
  const SYS = 0x50000000;
  const GFX = 0x60000000;
  const [dictOff, pagesOff, hashOff, ptrOff] = sys.offsets;
  const structOff = (i: number) => sys.offsets[4 + i];
  const nameOff = (i: number) => sys.offsets[4 + n + i];
  const setPtr = (at: number, value: number) => {
    sv.setUint32(at, value >>> 0, true);
    sv.setUint32(at + 4, 0, true);
  };

  system.set(r.bytes(ROOT, 0x40), dictOff);
  setPtr(dictOff + 0x08, SYS + pagesOff);
  setPtr(dictOff + 0x20, SYS + hashOff);
  sv.setUint16(dictOff + 0x28, n, true);
  sv.setUint16(dictOff + 0x2a, n, true);
  setPtr(dictOff + 0x30, SYS + ptrOff);
  sv.setUint16(dictOff + 0x38, n, true);
  sv.setUint16(dictOff + 0x3a, n, true);

  system[pagesOff + 8] = sys.pageCount;
  system[pagesOff + 9] = gfx.pageCount;

  entries.forEach((e, i) => {
    sv.setUint32(hashOff + i * 4, e.hash, true);
    setPtr(ptrOff + i * 8, SYS + structOff(i));
    const struct = system.subarray(structOff(i), structOff(i) + 0x90);
    struct.set(e.struct);
    setPtr(structOff(i) + 0x28, SYS + nameOff(i));
    system.set(nameBytes[i], nameOff(i));
    graphics.set(e.data, gfx.offsets[i]);
    if (e.changed) {
      writeTextureHeader(struct, e.format, e.width, e.height, e.levels, GFX + gfx.offsets[i]);
    } else {
      setPtr(structOff(i) + 0x70, GFX + gfx.offsets[i]);
    }
  });

  const header = file.slice(0, 16);
  const hv = new DataView(header.buffer);
  hv.setUint32(8, ((hv.getUint32(8, true) & 0xf0000000) | sys.flags) >>> 0, true);
  hv.setUint32(12, ((hv.getUint32(12, true) & 0xf0000000) | gfx.flags) >>> 0, true);
  const payload = new Uint8Array(system.length + graphics.length);
  payload.set(system, 0);
  payload.set(graphics, system.length);
  return withHeader(header, deflateSync(payload, { level: 6 }));
}

/** Whether a texture of this format can be written back. */
export function canReplaceFormat(format: string): boolean {
  return isEncodable(format) && formatCode(format) !== undefined;
}

/** Bilinear resize of RGBA pixels. */
export function resizeRgba(src: Uint8Array, w: number, h: number, nw: number, nh: number): Uint8Array {
  if (w === nw && h === nh) return src;
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const fy = Math.min(h - 1, Math.max(0, ((y + 0.5) * h) / nh - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(h - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < nw; x++) {
      const fx = Math.min(w - 1, Math.max(0, ((x + 0.5) * w) / nw - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(w - 1, x0 + 1);
      const tx = fx - x0;
      for (let c = 0; c < 4; c++) {
        const a = src[(y0 * w + x0) * 4 + c] * (1 - tx) + src[(y0 * w + x1) * 4 + c] * tx;
        const b = src[(y1 * w + x0) * 4 + c] * (1 - tx) + src[(y1 * w + x1) * 4 + c] * tx;
        out[(y * nw + x) * 4 + c] = Math.round(a * (1 - ty) + b * ty);
      }
    }
  }
  return out;
}

/**
 * Replaces a texture embedded in a model with a .dds image. A DDS of the same
 * size and format is stored as-is (with its own mips); anything else is
 * resized and re-encoded to the texture's own size and format, so it always fits.
 */
export function replaceEmbeddedFromDds(file: Uint8Array, kind: Exclude<TextureFileKind, 'ytd'>, name: string, ddsFile: Uint8Array): Uint8Array {
  const r = new ResourceReader(readRsc7(file));
  const t = rawTexture(r, findTexture(r, kind, name));
  const dds = parseDds(ddsFile);
  if (dds.format === t.formatName && dds.width === t.width && dds.height === t.height) {
    const levels = Math.min(dds.levels, t.levels);
    return replaceTexture(file, kind, name, { width: t.width, height: t.height, format: t.formatName, levels, encoded: dds.allLevels });
  }
  const code = formatCode(dds.format);
  if (code === undefined) throw new ResourceError(`${dds.format} images can't be used here; save the replacement as DXT1/DXT5 or uncompressed.`);
  const rgba = resizeRgba(decodeToRgba(code, dds.data, dds.width, dds.height), dds.width, dds.height, t.width, t.height);
  const target = canReplaceFormat(t.formatName) ? t.formatName : 'DXT5';
  return replaceTexture(file, kind, name, { width: t.width, height: t.height, format: target, levels: t.levels, rgba });
}
