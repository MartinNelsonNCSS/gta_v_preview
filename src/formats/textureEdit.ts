import { deflateSync } from 'fflate';
import { ResourceReader } from './reader';
import { readRsc7, ResourceError } from './rsc7';
import { formatCode, readTexture, textureDataSize } from './textures';
import { encodeMipChain, EncodableFormat, isEncodable } from './bcEncode';
import { packSegment } from './resourceBuilder';
import { fragmentDrawables } from './yft';
import { buildDds } from './dds';
import type { TextureData } from '../shared/model';

/**
 * Reading and rewriting individual textures inside resource files. Replacing
 * keeps the texture's size, format and mip count, so only its pixel bytes
 * change and the resource layout stays valid.
 */

export type TextureFileKind = 'ytd' | 'ydr' | 'ydd' | 'yft';

const ROOT = 0x50000000;

interface TextureLocation {
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

function dictionaryTextures(r: ResourceReader, txd: number | undefined): TextureLocation[] {
  if (txd === undefined) return [];
  const list = r.list(txd + 0x30);
  return r.ptrArray(list.items, list.count).map((ptr) => ({ ptr, name: r.string(r.ptr(ptr + 0x28)) ?? '' }));
}

/** Every texture with pixel data in a file of the given kind. */
function locateTextures(r: ResourceReader, kind: TextureFileKind): TextureLocation[] {
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

interface RawTexture {
  name: string;
  width: number;
  height: number;
  format: number;
  formatName: string;
  levels: number;
  dataPtr: number;
  size: number;
}

function rawTexture(r: ResourceReader, loc: TextureLocation): RawTexture {
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

/**
 * Returns a copy of `file` with texture `name` replaced by `rgba` (width×height).
 *
 * - Same size: pixel data is rewritten in place.
 * - Halved size(s): the top mips are dropped in place (works in any file type).
 * - Any other size: only for .ytd, which is rebuilt with a new page layout.
 *
 * The texture keeps its format; a full mip chain is generated.
 */
export function replaceTexture(file: Uint8Array, kind: TextureFileKind, name: string, rgba: Uint8Array, width: number, height: number): Uint8Array {
  const res = readRsc7(file);
  const r = new ResourceReader(res);
  const loc = findTexture(r, kind, name);
  const t = rawTexture(r, loc);
  if (!isEncodable(t.formatName)) {
    throw new ResourceError(`Writing ${t.formatName} textures isn't supported yet (${t.name}).`);
  }
  if (rgba.length !== width * height * 4) throw new ResourceError('Image data does not match its size.');

  if (width === t.width && height === t.height) {
    const encoded = encodeMipChain(t.formatName, rgba, width, height, t.levels);
    if (encoded.length !== t.size) throw new ResourceError('Encoded size mismatch; the texture was not replaced.');
    r.bytes(t.dataPtr, t.size).set(encoded);
    return repack(file, res);
  }

  // Shrinking by powers of two: the smaller mips already have room in the file.
  for (let k = 1; k < t.levels; k++) {
    if (t.width >> k !== width || t.height >> k !== height) continue;
    const levels = t.levels - k;
    const skip = textureDataSize(t.format, t.width, t.height, k)!;
    const encoded = encodeMipChain(t.formatName, rgba, width, height, levels);
    if (encoded.length !== t.size - skip) throw new ResourceError('Encoded size mismatch; the texture was not replaced.');
    r.bytes(t.dataPtr + skip, encoded.length).set(encoded);
    writeTextureHeader(r.bytes(loc.ptr, 0x90), t.formatName, width, height, levels, t.dataPtr + skip);
    return repack(file, res);
  }

  if (kind !== 'ytd') {
    throw new ResourceError(
      `Textures embedded in a .${kind} can only be kept the same size or halved (${t.width}×${t.height} → ${t.width >> 1}×${t.height >> 1}, …). Move the texture to a .ytd to use other sizes.`
    );
  }
  const blockAligned = !/^(A8R8G8B8|X8R8G8B8|A8B8G8R8|A8|L8)$/.test(t.formatName);
  if (blockAligned && (width % 4 || height % 4)) throw new ResourceError(`${t.formatName} textures need a width and height that are multiples of 4.`);
  const levels = mipLevelsFor(t.formatName as EncodableFormat, width, height);
  return rebuildYtd(file, r, t.name, { width, height, levels, data: encodeMipChain(t.formatName, rgba, width, height, levels) });
}

/** Number of mips to generate: down to 4px for block formats, 1px otherwise. */
export function mipLevelsFor(format: EncodableFormat, width: number, height: number): number {
  const min = Math.min(width, height);
  const blocks = !/^(A8R8G8B8|X8R8G8B8|A8B8G8R8|A8|L8)$/.test(format);
  return Math.max(1, Math.min(13, Math.floor(Math.log2(blocks ? min / 4 : min)) + 1));
}

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

/** Updates size-dependent fields of a 0x90-byte grcTexture. */
function writeTextureHeader(struct: Uint8Array, format: string, width: number, height: number, levels: number, dataPtr: number): void {
  const v = new DataView(struct.buffer, struct.byteOffset, struct.byteLength);
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

/**
 * Rebuilds a .ytd from scratch with one texture's data replaced. Other
 * textures keep their exact bytes; structures are copied from the original
 * and only pointers and size fields change.
 */
function rebuildYtd(
  file: Uint8Array,
  r: ResourceReader,
  replacedName: string,
  replacement: { width: number; height: number; levels: number; data: Uint8Array }
): Uint8Array {
  const hashes = r.list(ROOT + 0x20);
  const list = r.list(ROOT + 0x30);
  const entries = r.ptrArray(list.items, list.count).map((ptr, i) => {
    const loc = { ptr, name: r.string(r.ptr(ptr + 0x28)) ?? '' };
    const t = rawTexture(r, loc);
    const replaced = loc.name.toLowerCase() === replacedName.toLowerCase();
    return {
      name: loc.name,
      hash: r.u32(hashes.items + i * 4),
      struct: r.bytes(ptr, 0x90).slice(),
      format: t.formatName,
      width: replaced ? replacement.width : t.width,
      height: replaced ? replacement.height : t.height,
      levels: replaced ? replacement.levels : t.levels,
      data: replaced ? replacement.data : r.bytes(t.dataPtr, t.size).slice(),
      replaced,
    };
  });
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
    if (e.replaced) {
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

/** Which sizes a texture can be saved at, for the UI. */
export function resizeOptions(kind: TextureFileKind, width: number, height: number, levels: number): { halvings: number; anySize: boolean } {
  let halvings = 0;
  while (halvings + 1 < levels && Math.min(width >> (halvings + 1), height >> (halvings + 1)) >= 4) halvings++;
  return { halvings, anySize: kind === 'ytd' };
}

/** Whether a texture of this format can be written back. */
export function canReplaceFormat(format: string): boolean {
  return isEncodable(format) && formatCode(format) !== undefined;
}
