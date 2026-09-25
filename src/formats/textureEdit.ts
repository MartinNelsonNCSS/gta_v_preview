import { deflateSync } from 'fflate';
import { ResourceReader } from './reader';
import { readRsc7, ResourceError } from './rsc7';
import { formatCode, readTexture, textureDataSize } from './textures';
import { encodeMipChain, isEncodable } from './bcEncode';
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
 * Returns a copy of `file` with texture `name` replaced by `rgba`, which must
 * be the texture's exact size. The image is encoded to the texture's existing
 * format with a full mip chain.
 */
export function replaceTexture(file: Uint8Array, kind: TextureFileKind, name: string, rgba: Uint8Array, width: number, height: number): Uint8Array {
  const res = readRsc7(file);
  const r = new ResourceReader(res);
  const t = rawTexture(r, findTexture(r, kind, name));
  if (!isEncodable(t.formatName)) {
    throw new ResourceError(`Replacing ${t.formatName} textures isn't supported yet (${t.name}).`);
  }
  if (width !== t.width || height !== t.height || rgba.length !== width * height * 4) {
    throw new ResourceError(`Replacement image must be ${t.width}×${t.height} (got ${width}×${height}).`);
  }
  const encoded = encodeMipChain(t.formatName, rgba, width, height, t.levels);
  if (encoded.length !== t.size) throw new ResourceError('Encoded size mismatch; the texture was not replaced.');
  // res.system/res.graphics are views of one decompressed buffer; write in place.
  r.bytes(t.dataPtr, t.size).set(encoded);

  const payload = new Uint8Array(res.system.length + res.graphics.length);
  payload.set(res.system, 0);
  payload.set(res.graphics, res.system.length);
  const compressed = deflateSync(payload, { level: 6 });
  const out = new Uint8Array(16 + compressed.length);
  out.set(file.subarray(0, 16), 0); // Same header: sizes and flags are unchanged.
  out.set(compressed, 16);
  return out;
}

/** Whether a texture of this format can be written back. */
export function canReplaceFormat(format: string): boolean {
  return isEncodable(format) && formatCode(format) !== undefined;
}
