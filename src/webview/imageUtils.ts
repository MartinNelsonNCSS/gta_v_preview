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

export async function rgbaToPng(rgba: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => rgbaCanvas(rgba, w, h).toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('PNG encoding failed.');
  return new Uint8Array(await blob.arrayBuffer());
}

/** Nearest power of two (for "snap to power of two" resizing). */
export function nearestPowerOfTwo(n: number): number {
  return Math.pow(2, Math.round(Math.log2(Math.max(1, n))));
}
