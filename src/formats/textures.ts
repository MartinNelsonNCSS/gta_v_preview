import { ResourceReader } from './reader';
import type { TextureData } from '../shared/model';

/** D3D texture formats used by GTA V (FourCC or D3DFORMAT enum values). */
const FMT = {
  DXT1: 0x31545844,
  DXT3: 0x33545844,
  DXT5: 0x35545844,
  ATI1: 0x31495441, // BC4
  ATI2: 0x32495441, // BC5
  BC7: 0x20374342,
  A8R8G8B8: 21,
  X8R8G8B8: 22,
  R5G6B5: 23,
  A1R5G5B5: 25,
  A8: 28,
  A8B8G8R8: 32,
  L8: 50,
} as const;

interface FormatInfo {
  name: string;
  /** Bytes per 4x4 block for block-compressed formats. */
  blockBytes?: number;
  /** Bytes per pixel for uncompressed formats. */
  pixelBytes?: number;
}

const FORMATS: Record<number, FormatInfo> = {
  [FMT.DXT1]: { name: 'DXT1', blockBytes: 8 },
  [FMT.DXT3]: { name: 'DXT3', blockBytes: 16 },
  [FMT.DXT5]: { name: 'DXT5', blockBytes: 16 },
  [FMT.ATI1]: { name: 'BC4', blockBytes: 8 },
  [FMT.ATI2]: { name: 'BC5', blockBytes: 16 },
  [FMT.BC7]: { name: 'BC7', blockBytes: 16 },
  [FMT.A8R8G8B8]: { name: 'A8R8G8B8', pixelBytes: 4 },
  [FMT.X8R8G8B8]: { name: 'X8R8G8B8', pixelBytes: 4 },
  [FMT.R5G6B5]: { name: 'R5G6B5', pixelBytes: 2 },
  [FMT.A1R5G5B5]: { name: 'A1R5G5B5', pixelBytes: 2 },
  [FMT.A8]: { name: 'A8', pixelBytes: 1 },
  [FMT.A8B8G8R8]: { name: 'A8B8G8R8', pixelBytes: 4 },
  [FMT.L8]: { name: 'L8', pixelBytes: 1 },
};

/** Total bytes of `levels` mips of a `format` texture, or undefined for unknown formats. */
export function textureDataSize(format: number, width: number, height: number, levels: number): number | undefined {
  const info = FORMATS[format];
  if (!info) return undefined;
  let size = 0;
  for (let i = 0, w = width, h = height; i < levels; i++, w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) size += levelSize(info, w, h);
  return size;
}

/** D3D format code for a format name as reported in TextureData.format. */
export function formatCode(name: string): number | undefined {
  for (const [code, info] of Object.entries(FORMATS)) if (info.name === name) return Number(code);
  return undefined;
}

function levelSize(info: FormatInfo, w: number, h: number): number {
  if (info.blockBytes) return Math.max(1, (w + 3) >> 2) * Math.max(1, (h + 3) >> 2) * info.blockBytes;
  return w * h * (info.pixelBytes ?? 4);
}

export interface TextureDecodeOptions {
  /** Largest dimension to decode; smaller mips are chosen for big textures. */
  maxSize: number;
}

/**
 * Reads a grcTexture at `ptr`. When the texture has pixel data (i.e. it is
 * embedded, not an external reference), the smallest mip level that still
 * satisfies `maxSize` is decoded to RGBA (or left compressed for BC7).
 */
export function readTexture(r: ResourceReader, ptr: number, opts: TextureDecodeOptions): TextureData {
  const name = r.string(r.ptr(ptr + 0x28)) ?? '(unnamed)';
  const width = r.u16(ptr + 0x50);
  const height = r.u16(ptr + 0x52);
  const format = r.u32(ptr + 0x58);
  const levels = Math.max(1, r.u8(ptr + 0x5d));
  const dataPtr = r.ptr(ptr + 0x70);
  const info = FORMATS[format];
  const tex: TextureData = {
    name,
    width,
    height,
    format: info?.name ?? `0x${format.toString(16)}`,
    levels,
  };
  if (!info || !r.isValid(dataPtr) || width === 0 || height === 0) return tex;

  // Pick a mip level no larger than maxSize.
  let level = 0;
  let offset = 0;
  let w = width;
  let h = height;
  while (level < levels - 1 && Math.max(w, h) > opts.maxSize) {
    offset += levelSize(info, w, h);
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
    level++;
  }
  const size = levelSize(info, w, h);
  let src: Uint8Array;
  try {
    src = r.bytes(dataPtr + offset, size);
  } catch {
    return tex;
  }
  if (format === FMT.BC7) {
    // Decoded on the GPU by the webview (the format is too involved to be worth a CPU decoder).
    tex.pixels = { width: w, height: h, encoding: 'bc7', data: src.slice() };
  } else {
    tex.pixels = { width: w, height: h, encoding: 'rgba', data: decodeToRgba(format, src, w, h) };
  }
  return tex;
}

/** Reads a TextureDictionary (the root of a .ytd, or embedded in a ShaderGroup). */
export function readTextureDictionary(r: ResourceReader, ptr: number, opts: TextureDecodeOptions): TextureData[] {
  const list = r.list(ptr + 0x30);
  return r.ptrArray(list.items, list.count).map((p) => readTexture(r, p, opts));
}

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

export function decodeToRgba(format: number, src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  switch (format) {
    case FMT.DXT1:
      decodeBlocks(src, out, w, h, 8, decodeDxt1Block);
      break;
    case FMT.DXT3:
      decodeBlocks(src, out, w, h, 16, decodeDxt3Block);
      break;
    case FMT.DXT5:
      decodeBlocks(src, out, w, h, 16, decodeDxt5Block);
      break;
    case FMT.ATI1:
      decodeBlocks(src, out, w, h, 8, decodeBc4Block);
      break;
    case FMT.ATI2:
      decodeBlocks(src, out, w, h, 16, decodeBc5Block);
      break;
    case FMT.A8R8G8B8:
    case FMT.X8R8G8B8:
      for (let i = 0; i < w * h; i++) {
        out[i * 4] = src[i * 4 + 2];
        out[i * 4 + 1] = src[i * 4 + 1];
        out[i * 4 + 2] = src[i * 4];
        out[i * 4 + 3] = format === FMT.X8R8G8B8 ? 255 : src[i * 4 + 3];
      }
      break;
    case FMT.A8B8G8R8:
      out.set(src.subarray(0, w * h * 4));
      break;
    case FMT.R5G6B5:
      for (let i = 0; i < w * h; i++) {
        const c = src[i * 2] | (src[i * 2 + 1] << 8);
        out[i * 4] = ((c >> 11) & 31) * 255 / 31;
        out[i * 4 + 1] = ((c >> 5) & 63) * 255 / 63;
        out[i * 4 + 2] = (c & 31) * 255 / 31;
        out[i * 4 + 3] = 255;
      }
      break;
    case FMT.A1R5G5B5:
      for (let i = 0; i < w * h; i++) {
        const c = src[i * 2] | (src[i * 2 + 1] << 8);
        out[i * 4] = ((c >> 10) & 31) * 255 / 31;
        out[i * 4 + 1] = ((c >> 5) & 31) * 255 / 31;
        out[i * 4 + 2] = (c & 31) * 255 / 31;
        out[i * 4 + 3] = c & 0x8000 ? 255 : 0;
      }
      break;
    case FMT.A8:
      for (let i = 0; i < w * h; i++) {
        out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 255;
        out[i * 4 + 3] = src[i];
      }
      break;
    case FMT.L8:
      for (let i = 0; i < w * h; i++) {
        out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = src[i];
        out[i * 4 + 3] = 255;
      }
      break;
  }
  return out;
}

type BlockDecoder = (src: Uint8Array, off: number, block: Uint8Array) => void;

function decodeBlocks(src: Uint8Array, out: Uint8Array, w: number, h: number, blockBytes: number, fn: BlockDecoder) {
  const bw = Math.max(1, (w + 3) >> 2);
  const bh = Math.max(1, (h + 3) >> 2);
  const block = new Uint8Array(64);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const off = (by * bw + bx) * blockBytes;
      if (off + blockBytes > src.length) return;
      fn(src, off, block);
      for (let py = 0; py < 4; py++) {
        const y = by * 4 + py;
        if (y >= h) break;
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px;
          if (x >= w) break;
          const d = (y * w + x) * 4;
          const s = (py * 4 + px) * 4;
          out[d] = block[s];
          out[d + 1] = block[s + 1];
          out[d + 2] = block[s + 2];
          out[d + 3] = block[s + 3];
        }
      }
    }
  }
}

const palette = new Uint8Array(16);

/** Decodes the 8-byte BC1 colour block at `off` into `block` (RGBA x16). */
function decodeColorBlock(src: Uint8Array, off: number, block: Uint8Array, allowAlpha: boolean) {
  const c0 = src[off] | (src[off + 1] << 8);
  const c1 = src[off + 2] | (src[off + 3] << 8);
  unpack565(c0, palette, 0);
  unpack565(c1, palette, 4);
  palette[3] = palette[7] = palette[11] = palette[15] = 255;
  if (c0 > c1 || !allowAlpha) {
    for (let i = 0; i < 3; i++) {
      palette[8 + i] = (2 * palette[i] + palette[4 + i]) / 3;
      palette[12 + i] = (palette[i] + 2 * palette[4 + i]) / 3;
    }
  } else {
    for (let i = 0; i < 3; i++) {
      palette[8 + i] = (palette[i] + palette[4 + i]) / 2;
      palette[12 + i] = 0;
    }
    palette[15] = 0;
  }
  const bits = src[off + 4] | (src[off + 5] << 8) | (src[off + 6] << 16) | (src[off + 7] << 24);
  for (let i = 0; i < 16; i++) {
    const idx = ((bits >>> (i * 2)) & 3) * 4;
    block[i * 4] = palette[idx];
    block[i * 4 + 1] = palette[idx + 1];
    block[i * 4 + 2] = palette[idx + 2];
    block[i * 4 + 3] = palette[idx + 3];
  }
}

function unpack565(c: number, out: Uint8Array, o: number) {
  const r = (c >> 11) & 31;
  const g = (c >> 5) & 63;
  const b = c & 31;
  out[o] = (r << 3) | (r >> 2);
  out[o + 1] = (g << 2) | (g >> 4);
  out[o + 2] = (b << 3) | (b >> 2);
}

const alphaPalette = new Uint8Array(8);

/** Decodes an 8-byte BC4-style interpolated channel block into block[channel]. */
function decodeAlphaBlock(src: Uint8Array, off: number, block: Uint8Array, channel: number) {
  const a0 = src[off];
  const a1 = src[off + 1];
  alphaPalette[0] = a0;
  alphaPalette[1] = a1;
  if (a0 > a1) {
    for (let i = 1; i < 7; i++) alphaPalette[i + 1] = ((7 - i) * a0 + i * a1) / 7;
  } else {
    for (let i = 1; i < 5; i++) alphaPalette[i + 1] = ((5 - i) * a0 + i * a1) / 5;
    alphaPalette[6] = 0;
    alphaPalette[7] = 255;
  }
  // 48 bits of 3-bit indices; split into two 24-bit halves to stay in int range.
  const lo = src[off + 2] | (src[off + 3] << 8) | (src[off + 4] << 16);
  const hi = src[off + 5] | (src[off + 6] << 8) | (src[off + 7] << 16);
  for (let i = 0; i < 8; i++) {
    block[i * 4 + channel] = alphaPalette[(lo >> (i * 3)) & 7];
    block[(i + 8) * 4 + channel] = alphaPalette[(hi >> (i * 3)) & 7];
  }
}

function decodeDxt1Block(src: Uint8Array, off: number, block: Uint8Array) {
  decodeColorBlock(src, off, block, true);
}

function decodeDxt3Block(src: Uint8Array, off: number, block: Uint8Array) {
  decodeColorBlock(src, off + 8, block, false);
  for (let i = 0; i < 8; i++) {
    const b = src[off + i];
    block[(i * 2) * 4 + 3] = (b & 0xf) * 17;
    block[(i * 2 + 1) * 4 + 3] = (b >> 4) * 17;
  }
}

function decodeDxt5Block(src: Uint8Array, off: number, block: Uint8Array) {
  decodeColorBlock(src, off + 8, block, false);
  decodeAlphaBlock(src, off, block, 3);
}

function decodeBc4Block(src: Uint8Array, off: number, block: Uint8Array) {
  decodeAlphaBlock(src, off, block, 0);
  for (let i = 0; i < 16; i++) {
    block[i * 4 + 1] = block[i * 4 + 2] = block[i * 4];
    block[i * 4 + 3] = 255;
  }
}

function decodeBc5Block(src: Uint8Array, off: number, block: Uint8Array) {
  decodeAlphaBlock(src, off, block, 0);
  decodeAlphaBlock(src, off + 8, block, 1);
  // Reconstruct Z so normal maps look like normal maps.
  for (let i = 0; i < 16; i++) {
    const x = block[i * 4] / 127.5 - 1;
    const y = block[i * 4 + 1] / 127.5 - 1;
    const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
    block[i * 4 + 2] = (z + 1) * 127.5;
    block[i * 4 + 3] = 255;
  }
}
