import { ResourceReader } from './reader';
import { readRsc7, readRsc7SystemOnly } from './rsc7';
import { readTexture, readTextureDictionary, TextureDecodeOptions } from './textures';
import type { TextureData } from '../shared/model';

/** Parses a .ytd texture dictionary. */
export function parseYtd(file: Uint8Array, opts: TextureDecodeOptions): TextureData[] {
  const r = new ResourceReader(readRsc7(file));
  return readTextureDictionary(r, 0x50000000, opts);
}

/** Lists texture names in a .ytd without decoding any pixels. */
export function listYtdTextureNames(file: Uint8Array): string[] {
  const r = new ResourceReader(readRsc7SystemOnly(file));
  const list = r.list(0x50000000 + 0x30);
  return r.ptrArray(list.items, list.count).map((p) => r.string(r.ptr(p + 0x28)) ?? '');
}

/** Decodes only the textures whose (lower-case) names are in `wanted`. */
export function readYtdTextures(file: Uint8Array, wanted: Set<string>, opts: TextureDecodeOptions): TextureData[] {
  const r = new ResourceReader(readRsc7(file));
  const list = r.list(0x50000000 + 0x30);
  const out: TextureData[] = [];
  for (const p of r.ptrArray(list.items, list.count)) {
    const name = (r.string(r.ptr(p + 0x28)) ?? '').toLowerCase();
    if (wanted.has(name)) out.push(readTexture(r, p, opts));
  }
  return out;
}
