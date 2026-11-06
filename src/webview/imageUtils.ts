import { DdsImage, parseDds } from '../formats/dds';
import { decodeToRgba, formatCode } from '../formats/textures';
import { decodeBc7 } from './bc7';

/** A decoded image file. `dds` is set for .dds files (their raw data and mips). */
export interface LoadedImage {
  canvas: HTMLCanvasElement;
  dds?: DdsImage;
}

/** Decodes an image file (PNG/JPG/WebP/BMP/GIF/DDS) into a canvas at its own size. */
export async function decodeImage(name: string, data: Uint8Array): Promise<LoadedImage> {
  if (/\.dds$/i.test(name)) {
    const dds = parseDds(data);
    const rgba = ddsTopRgba(dds);
    if (!rgba) throw new Error('This DDS format needs GPU support that is not available (BC7).');
    return { canvas: rgbaCanvas(rgba, dds.width, dds.height), dds };
  }
  const bitmap = await createImageBitmap(new Blob([data.slice()]), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { canvas };
}

/** RGBA pixels of a DDS's top mip (BC7 is decoded on the GPU; null if unsupported). */
export function ddsTopRgba(dds: DdsImage): Uint8Array | null {
  if (dds.format === 'BC7') return decodeBc7(dds.data, dds.width, dds.height);
  const code = formatCode(dds.format);
  return code === undefined ? null : decodeToRgba(code, dds.data, dds.width, dds.height);
}

export function rgbaCanvas(rgba: Uint8Array, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
  return c;
}

export function canvasToRgba(c: HTMLCanvasElement): Uint8Array {
  return new Uint8Array(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data.buffer);
}

/** High-quality resize: halve repeatedly for big reductions, then a final smooth scale. */
export function resizeCanvas(src: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
  let cur = src;
  while (cur.width / 2 >= w && cur.height / 2 >= h && cur.width > 1 && cur.height > 1) {
    cur = drawScaled(cur, Math.max(w, Math.floor(cur.width / 2)), Math.max(h, Math.floor(cur.height / 2)));
  }
  return cur.width === w && cur.height === h ? cur : drawScaled(cur, w, h);
}

function drawScaled(src: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return c;
}

/**
 * Encodes RGBA pixels as an 8-bit PNG, byte for byte (no trip through a
 * canvas, whose premultiplied storage shifts the colour of see-through
 * pixels), tagged sRGB so image apps read the colours as they were made.
 */
export async function rgbaToPng(rgba: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  const stride = w * 4;
  const raw = new Uint8Array((stride + 1) * h);
  const cand = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride)];
  for (let y = 0; y < h; y++) {
    const row = rgba.subarray(y * stride, (y + 1) * stride);
    const up = y ? rgba.subarray((y - 1) * stride, y * stride) : undefined;
    // Filters 1–4 (Sub, Up, Average, Paeth); 0 (None) is the row itself. Keep the smallest by sum of |bytes|.
    let best = row;
    let bestType = 0;
    let bestCost = rowCost(row);
    for (let f = 1; f <= 4; f++) {
      const out = cand[f - 1];
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? row[i - 4] : 0;
        const b = up ? up[i] : 0;
        const c = up && i >= 4 ? up[i - 4] : 0;
        const pred = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
        out[i] = (row[i] - pred) & 255;
      }
      const cost = rowCost(out);
      if (cost < bestCost) {
        bestCost = cost;
        best = out;
        bestType = f;
      }
    }
    const o = y * (stride + 1);
    raw[o] = bestType;
    raw.set(best, o + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, deflate, adaptive filtering, no interlace
  const idat = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('sRGB', new Uint8Array([0])), // perceptual
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    png.set(p, at);
    at += p.length;
  }
  return png;
}

function rowCost(r: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < r.length; i++) s += r[i] < 128 ? r[i] : 256 - r[i];
  return s;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

let crcTable: Uint32Array | undefined;

function chunk(type: string, data: Uint8Array): Uint8Array {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  const out = new Uint8Array(data.length + 12);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < 8 + data.length; i++) crc = crcTable[(crc ^ out[i]) & 255] ^ (crc >>> 8);
  dv.setUint32(8 + data.length, (crc ^ 0xffffffff) >>> 0);
  return out;
}

/** Nearest power of two (for "snap to power of two" resizing). */
export function nearestPowerOfTwo(n: number): number {
  return Math.pow(2, Math.round(Math.log2(Math.max(1, n))));
}
