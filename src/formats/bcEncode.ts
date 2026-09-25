/**
 * Block-compression encoders (BC1–BC5) and mipmap generation, used when
 * writing replacement textures back into GTA resources.
 *
 * Colour blocks use a principal-axis range fit: the block's colours are
 * projected onto their main direction of variance, the extremes become the
 * endpoints, and each pixel takes the nearest palette entry. It's simple,
 * fast, and close to what common offline tools produce for game textures.
 */

export type EncodableFormat = 'DXT1' | 'DXT3' | 'DXT5' | 'BC4' | 'BC5' | 'A8R8G8B8' | 'X8R8G8B8' | 'A8B8G8R8' | 'A8' | 'L8';

export function isEncodable(format: string): format is EncodableFormat {
  return ['DXT1', 'DXT3', 'DXT5', 'BC4', 'BC5', 'A8R8G8B8', 'X8R8G8B8', 'A8B8G8R8', 'A8', 'L8'].includes(format);
}

/** Formats that can be written, with a short description for the UI. */
export const ENCODABLE_FORMATS: { format: EncodableFormat; label: string }[] = [
  { format: 'DXT1', label: 'DXT1 / BC1 — colour, 1-bit alpha (smallest)' },
  { format: 'DXT3', label: 'DXT3 / BC2 — colour, sharp 4-bit alpha' },
  { format: 'DXT5', label: 'DXT5 / BC3 — colour, smooth alpha' },
  { format: 'BC4', label: 'BC4 (ATI1) — single channel (red)' },
  { format: 'BC5', label: 'BC5 (ATI2) — two channels (red, green)' },
  { format: 'A8R8G8B8', label: 'A8R8G8B8 — uncompressed with alpha' },
  { format: 'A8B8G8R8', label: 'A8B8G8R8 — uncompressed with alpha (RGBA order)' },
  { format: 'X8R8G8B8', label: 'X8R8G8B8 — uncompressed, no alpha' },
  { format: 'L8', label: 'L8 — uncompressed greyscale' },
  { format: 'A8', label: 'A8 — uncompressed alpha only' },
];

/** Number of mips to generate: down to 4px for block formats, 1px otherwise. */
export function mipLevelsFor(format: EncodableFormat, width: number, height: number): number {
  const min = Math.min(width, height);
  const blocks = !/^(A8R8G8B8|X8R8G8B8|A8B8G8R8|A8|L8)$/.test(format);
  return Math.max(1, Math.min(13, Math.floor(Math.log2(blocks ? min / 4 : min)) + 1));
}

/** The most mip levels a w×h texture can have (down to 1×1). */
export function maxMipLevels(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

/** Total bytes of a full mip chain generated for `format` at w×h. */
export function mipChainSize(format: EncodableFormat, w: number, h: number, levels = mipLevelsFor(format, w, h)): number {
  let size = 0;
  for (let i = 0; i < levels; i++, w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) size += encodedSize(format, w, h);
  return size;
}

/** Whether a format stores data in 4×4 blocks (so sizes must be multiples of 4). */
export function isBlockFormat(format: string): boolean {
  return !/^(A8R8G8B8|X8R8G8B8|A8B8G8R8|A8|L8|R5G6B5|A1R5G5B5)$/.test(format);
}

/** Byte size of one mip level in `format`. */
export function encodedSize(format: EncodableFormat, w: number, h: number): number {
  const blocks = Math.max(1, (w + 3) >> 2) * Math.max(1, (h + 3) >> 2);
  switch (format) {
    case 'DXT1':
    case 'BC4':
      return blocks * 8;
    case 'DXT3':
    case 'DXT5':
    case 'BC5':
      return blocks * 16;
    case 'A8':
    case 'L8':
      return w * h;
    default:
      return w * h * 4;
  }
}

/** Encodes one RGBA level (w*h*4 bytes) into `format`. */
export function encodeLevel(format: EncodableFormat, rgba: Uint8Array, w: number, h: number): Uint8Array {
  switch (format) {
    case 'DXT1':
      return encodeBlocks(rgba, w, h, 8, (px, out, o) => encodeColorBlock(px, out, o, true));
    case 'DXT3':
      return encodeBlocks(rgba, w, h, 16, (px, out, o) => {
        for (let i = 0; i < 8; i++) {
          const a0 = Math.round(px[(i * 2) * 4 + 3] / 17);
          const a1 = Math.round(px[(i * 2 + 1) * 4 + 3] / 17);
          out[o + i] = a0 | (a1 << 4);
        }
        encodeColorBlock(px, out, o + 8, false);
      });
    case 'DXT5':
      return encodeBlocks(rgba, w, h, 16, (px, out, o) => {
        encodeChannelBlock(px, 3, out, o);
        encodeColorBlock(px, out, o + 8, false);
      });
    case 'BC4':
      return encodeBlocks(rgba, w, h, 8, (px, out, o) => encodeChannelBlock(px, 0, out, o));
    case 'BC5':
      return encodeBlocks(rgba, w, h, 16, (px, out, o) => {
        encodeChannelBlock(px, 0, out, o);
        encodeChannelBlock(px, 1, out, o + 8);
      });
    case 'A8R8G8B8':
    case 'X8R8G8B8': {
      const out = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        out[i * 4] = rgba[i * 4 + 2];
        out[i * 4 + 1] = rgba[i * 4 + 1];
        out[i * 4 + 2] = rgba[i * 4];
        out[i * 4 + 3] = format === 'X8R8G8B8' ? 255 : rgba[i * 4 + 3];
      }
      return out;
    }
    case 'A8B8G8R8':
      return rgba.slice(0, w * h * 4);
    case 'A8': {
      const out = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) out[i] = rgba[i * 4 + 3];
      return out;
    }
    case 'L8': {
      const out = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) out[i] = Math.round(0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]);
      return out;
    }
  }
}

/** Halves an RGBA image with a box filter (clamping at odd edges). */
export function downsample(rgba: Uint8Array, w: number, h: number): { data: Uint8Array; w: number; h: number } {
  const nw = Math.max(1, w >> 1);
  const nh = Math.max(1, h >> 1);
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const y0 = Math.min(h - 1, y * 2);
    const y1 = Math.min(h - 1, y * 2 + 1);
    for (let x = 0; x < nw; x++) {
      const x0 = Math.min(w - 1, x * 2);
      const x1 = Math.min(w - 1, x * 2 + 1);
      for (let c = 0; c < 4; c++) {
        const s = rgba[(y0 * w + x0) * 4 + c] + rgba[(y0 * w + x1) * 4 + c] + rgba[(y1 * w + x0) * 4 + c] + rgba[(y1 * w + x1) * 4 + c];
        out[(y * nw + x) * 4 + c] = (s + 2) >> 2;
      }
    }
  }
  return { data: out, w: nw, h: nh };
}

/** Encodes `levels` mips (starting from the full-size RGBA image) back to back. */
export function encodeMipChain(format: EncodableFormat, rgba: Uint8Array, w: number, h: number, levels: number): Uint8Array {
  const parts: Uint8Array[] = [];
  let level = { data: rgba, w, h };
  for (let i = 0; i < levels; i++) {
    parts.push(encodeLevel(format, level.data, level.w, level.h));
    if (i < levels - 1) level = downsample(level.data, level.w, level.h);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block helpers
// ---------------------------------------------------------------------------

type BlockEncoder = (px: Uint8Array, out: Uint8Array, offset: number) => void;

function encodeBlocks(rgba: Uint8Array, w: number, h: number, blockBytes: number, fn: BlockEncoder): Uint8Array {
  const bw = Math.max(1, (w + 3) >> 2);
  const bh = Math.max(1, (h + 3) >> 2);
  const out = new Uint8Array(bw * bh * blockBytes);
  const px = new Uint8Array(64);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      // Gather the 4x4 block, clamping at the image edges.
      for (let py = 0; py < 4; py++) {
        const y = Math.min(h - 1, by * 4 + py);
        for (let pxi = 0; pxi < 4; pxi++) {
          const x = Math.min(w - 1, bx * 4 + pxi);
          const s = (y * w + x) * 4;
          const d = (py * 4 + pxi) * 4;
          px[d] = rgba[s];
          px[d + 1] = rgba[s + 1];
          px[d + 2] = rgba[s + 2];
          px[d + 3] = rgba[s + 3];
        }
      }
      fn(px, out, (by * bw + bx) * blockBytes);
    }
  }
  return out;
}

const to565 = (r: number, g: number, b: number) => ((Math.round((r * 31) / 255) << 11) | (Math.round((g * 63) / 255) << 5) | Math.round((b * 31) / 255)) >>> 0;
function from565(c: number): [number, number, number] {
  const r = (c >> 11) & 31;
  const g = (c >> 5) & 63;
  const b = c & 31;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

/**
 * Encodes the colour half of a BC1/2/3 block at out[o..o+8]. With
 * `allowAlpha` (BC1 only), blocks containing transparent pixels use the
 * 3-colour + transparent mode.
 */
function encodeColorBlock(px: Uint8Array, out: Uint8Array, o: number, allowAlpha: boolean): void {
  let transparent = false;
  if (allowAlpha) for (let i = 0; i < 16; i++) if (px[i * 4 + 3] < 128) transparent = true;

  // Mean and covariance of the (opaque) colours.
  let n = 0;
  let mr = 0, mg = 0, mb = 0;
  for (let i = 0; i < 16; i++) {
    if (transparent && px[i * 4 + 3] < 128) continue;
    mr += px[i * 4];
    mg += px[i * 4 + 1];
    mb += px[i * 4 + 2];
    n++;
  }
  if (n === 0) {
    // Fully transparent block.
    out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
    out[o + 4] = out[o + 5] = out[o + 6] = out[o + 7] = 0xff;
    return;
  }
  mr /= n;
  mg /= n;
  mb /= n;
  let crr = 0, cgg = 0, cbb = 0, crg = 0, crb = 0, cgb = 0;
  for (let i = 0; i < 16; i++) {
    if (transparent && px[i * 4 + 3] < 128) continue;
    const r = px[i * 4] - mr, g = px[i * 4 + 1] - mg, b = px[i * 4 + 2] - mb;
    crr += r * r; cgg += g * g; cbb += b * b; crg += r * g; crb += r * b; cgb += g * b;
  }
  // Principal axis by power iteration.
  let ax = 1, ay = 1, az = 1;
  for (let it = 0; it < 6; it++) {
    const nx = crr * ax + crg * ay + crb * az;
    const ny = crg * ax + cgg * ay + cgb * az;
    const nz = crb * ax + cgb * ay + cbb * az;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-6) break;
    ax = nx / len; ay = ny / len; az = nz / len;
  }
  let minT = Infinity, maxT = -Infinity;
  for (let i = 0; i < 16; i++) {
    if (transparent && px[i * 4 + 3] < 128) continue;
    const t = (px[i * 4] - mr) * ax + (px[i * 4 + 1] - mg) * ay + (px[i * 4 + 2] - mb) * az;
    if (t < minT) minT = t;
    if (t > maxT) maxT = t;
  }
  const clamp = (v: number) => Math.max(0, Math.min(255, v));
  let c0 = to565(clamp(mr + ax * maxT), clamp(mg + ay * maxT), clamp(mb + az * maxT));
  let c1 = to565(clamp(mr + ax * minT), clamp(mg + ay * minT), clamp(mb + az * minT));

  // Endpoint order selects the mode: c0 > c1 → 4 colours, otherwise 3 + transparent.
  if (transparent ? c0 > c1 : c0 < c1) [c0, c1] = [c1, c0];
  if (!transparent && c0 === c1) {
    // Solid block: force 4-colour mode (c0 > c1) where possible.
    if (c1 > 0) c1--;
    else c0++;
  }
  const e0 = from565(c0);
  const e1 = from565(c1);
  const palette: [number, number, number][] = transparent
    ? [e0, e1, mix(e0, e1, 1, 2)]
    : [e0, e1, mix(e0, e1, 1, 3), mix(e0, e1, 2, 3)];

  let bits = 0;
  for (let i = 0; i < 16; i++) {
    let idx: number;
    if (transparent && px[i * 4 + 3] < 128) {
      idx = 3;
    } else {
      idx = 0;
      let best = Infinity;
      for (let p = 0; p < palette.length; p++) {
        const dr = px[i * 4] - palette[p][0], dg = px[i * 4 + 1] - palette[p][1], db = px[i * 4 + 2] - palette[p][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < best) {
          best = d;
          idx = p;
        }
      }
    }
    bits |= idx << (i * 2);
  }
  out[o] = c0 & 0xff;
  out[o + 1] = c0 >> 8;
  out[o + 2] = c1 & 0xff;
  out[o + 3] = c1 >> 8;
  out[o + 4] = bits & 0xff;
  out[o + 5] = (bits >>> 8) & 0xff;
  out[o + 6] = (bits >>> 16) & 0xff;
  out[o + 7] = (bits >>> 24) & 0xff;
}

function mix(a: [number, number, number], b: [number, number, number], num: number, den: number): [number, number, number] {
  return [0, 1, 2].map((i) => Math.round((a[i] * (den - num) + b[i] * num) / den)) as [number, number, number];
}

/** Encodes one channel of the block as a BC4-style interpolated block (8 bytes). */
function encodeChannelBlock(px: Uint8Array, channel: number, out: Uint8Array, o: number): void {
  let lo = 255, hi = 0;
  for (let i = 0; i < 16; i++) {
    const v = px[i * 4 + channel];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  // a0 > a1 selects the 8-value interpolated palette.
  let a0 = hi, a1 = lo;
  if (a0 === a1) {
    if (a0 < 255) a0++;
    else a1--;
  }
  const palette = [a0, a1];
  for (let i = 1; i < 7; i++) palette.push(Math.floor(((7 - i) * a0 + i * a1) / 7));
  let lowBits = 0, highBits = 0;
  for (let i = 0; i < 16; i++) {
    const v = px[i * 4 + channel];
    let idx = 0, best = Infinity;
    for (let p = 0; p < 8; p++) {
      const d = Math.abs(v - palette[p]);
      if (d < best) {
        best = d;
        idx = p;
      }
    }
    if (i < 8) lowBits |= idx << (i * 3);
    else highBits |= idx << ((i - 8) * 3);
  }
  out[o] = a0;
  out[o + 1] = a1;
  out[o + 2] = lowBits & 0xff;
  out[o + 3] = (lowBits >> 8) & 0xff;
  out[o + 4] = (lowBits >> 16) & 0xff;
  out[o + 5] = highBits & 0xff;
  out[o + 6] = (highBits >> 8) & 0xff;
  out[o + 7] = (highBits >> 16) & 0xff;
}
