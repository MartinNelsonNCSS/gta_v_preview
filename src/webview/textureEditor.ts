import type { TextureData } from '../shared/model';
import { parseDds } from '../formats/dds';
import { decodeToRgba, formatCode } from '../formats/textures';
import { decodeBc7 } from './bc7';
import { h, hostRequest, newRequestId } from './ui';

/**
 * Texture replacement and export. A replacement is first shown as a preview
 * (nothing written); "Save to file" then sends the image, resized to the
 * texture's exact size, to the extension host to encode and write.
 */

/** Formats the host can re-encode (see formats/bcEncode.ts). */
const WRITABLE = new Set(['DXT1', 'DXT3', 'DXT5', 'BC4', 'BC5', 'A8R8G8B8', 'X8R8G8B8', 'A8B8G8R8', 'A8', 'L8']);
/** Previews are shown at most this size; the full-size image is kept for saving. */
const PREVIEW_SIZE = 2048;

/** A texture shown in the viewer that can be previewed/replaced/exported. */
export interface EditTarget {
  /** The texture as loaded from its file (must carry `origin` for save/export). */
  original: TextureData;
  /** Shows a preview in the caller's views; undefined restores the original. */
  setPreview(preview: TextureData | undefined): void;
}

interface PendingEdit {
  rgba: Uint8Array;
  width: number;
  height: number;
  preview: TextureData;
  from: string;
}

/** Replacements not yet saved, keyed by origin + texture name (survive closing the viewer). */
const pending = new Map<string, PendingEdit>();
const keyOf = (t: TextureData) => `${t.origin ?? ''}|${t.name.toLowerCase()}`;

export function pendingPreview(t: TextureData): TextureData | undefined {
  return pending.get(keyOf(t))?.preview;
}

/** Display name of a texture's file, from its origin URI. */
export function originName(t: TextureData): string {
  if (!t.origin) return '';
  try {
    return decodeURIComponent(t.origin.slice(t.origin.lastIndexOf('/') + 1));
  } catch {
    return t.origin;
  }
}

/**
 * Builds the action bar (Replace / Save / Revert / Export) for a texture.
 * `show` is called with the texture to display whenever it changes.
 */
export function editActions(target: EditTarget, show: (t: TextureData) => void): HTMLElement {
  const t = target.original;
  const status = h('span', { class: 'muted edit-status' });
  const writable = WRITABLE.has(t.format) && !!t.origin;
  const replace = h('button', { class: 'chip', title: 'Preview another image on this texture (PNG, JPG, DDS...)' }, 'Replace…');
  const save = h('button', { class: 'chip active', title: `Write the replacement into ${originName(t) || 'its file'}` }, 'Save to file');
  const revert = h('button', { class: 'chip', title: 'Discard the replacement' }, 'Revert');
  const png = h('button', { class: 'chip', title: 'Export the original texture as PNG' }, 'Export PNG');
  const dds = h('button', { class: 'chip', title: 'Export the original compressed data (all mips) as DDS' }, 'Export DDS');
  if (!t.origin) {
    for (const b of [replace, png, dds]) {
      b.disabled = true;
      b.title = "This texture's source file is unknown.";
    }
  }
  const refresh = () => {
    const p = pending.get(keyOf(t));
    save.hidden = revert.hidden = !p;
    save.disabled = !writable;
    if (!writable && t.origin) save.title = `Writing ${t.format} textures isn't supported yet; you can still preview.`;
  };
  const say = (text: string) => (status.textContent = text);

  replace.onclick = async () => {
    const picked = await hostRequest({ type: 'pickImage', requestId: newRequestId() }, 'pickedImage');
    if (!picked.data || !picked.name) return;
    say('Loading image…');
    try {
      const { rgba, sourceWidth, sourceHeight } = await imageToRgba(picked.name, picked.data, t.width, t.height);
      const preview = makePreview(t, rgba);
      pending.set(keyOf(t), { rgba, width: t.width, height: t.height, preview, from: picked.name });
      target.setPreview(preview);
      show(preview);
      const resized = sourceWidth !== t.width || sourceHeight !== t.height ? ` (resized from ${sourceWidth}×${sourceHeight})` : '';
      say(`Previewing ${picked.name}${resized}. Not saved yet.`);
    } catch (err) {
      say(`Couldn't load ${picked.name}: ${(err as Error).message}`);
    }
    refresh();
  };

  revert.onclick = () => {
    pending.delete(keyOf(t));
    target.setPreview(undefined);
    show(t);
    say('Reverted.');
    refresh();
  };

  save.onclick = async () => {
    const p = pending.get(keyOf(t));
    if (!p || !t.origin) return;
    save.disabled = true;
    say('Encoding and saving…');
    const reply = await hostRequest(
      { type: 'replaceTexture', requestId: newRequestId(), origin: t.origin, name: t.name, rgba: p.rgba, width: p.width, height: p.height },
      'textureReplaced'
    );
    if (reply.ok) {
      pending.delete(keyOf(t));
      say(`Saved into ${reply.file} (backup: ${reply.file}.bak).`);
    } else {
      say(reply.cancelled ? 'Not saved.' : `Save failed: ${reply.error}`);
    }
    refresh();
  };

  png.onclick = async () => {
    if (!t.origin) return;
    say('Exporting…');
    const full = await hostRequest({ type: 'getFullTexture', requestId: newRequestId(), origin: t.origin, name: t.name }, 'fullTexture');
    const rgba = full.texture?.pixels && (full.texture.pixels.encoding === 'bc7' ? decodeBc7(full.texture.pixels.data, full.texture.pixels.width, full.texture.pixels.height) : full.texture.pixels.data);
    if (!full.texture?.pixels || !rgba) {
      say(`Export failed: ${full.error ?? 'no pixel data'}`);
      return;
    }
    const data = await rgbaToPng(rgba, full.texture.pixels.width, full.texture.pixels.height);
    const saved = await hostRequest({ type: 'saveFile', requestId: newRequestId(), suggestedName: `${t.name}.png`, data, filterName: 'PNG image', extensions: ['png'] }, 'saved');
    say(saved.path ? `Exported to ${saved.path}` : saved.error ? `Export failed: ${saved.error}` : '');
  };

  dds.onclick = async () => {
    if (!t.origin) return;
    const saved = await hostRequest({ type: 'exportDds', requestId: newRequestId(), origin: t.origin, name: t.name }, 'saved');
    say(saved.path ? `Exported to ${saved.path}` : saved.error ? `Export failed: ${saved.error}` : '');
  };

  refresh();
  const p = pending.get(keyOf(t));
  if (p) say(`Previewing ${p.from}. Not saved yet.`);
  return h('div', { class: 'edit-actions' }, replace, save, revert, h('span', { class: 'sep' }), png, dds, status);
}

/** A display-sized RGBA texture for previewing a replacement. */
function makePreview(t: TextureData, rgba: Uint8Array): TextureData {
  let w = t.width;
  let hgt = t.height;
  let data = rgba;
  if (Math.max(w, hgt) > PREVIEW_SIZE) {
    const canvas = rgbaCanvas(rgba, w, hgt);
    const s = PREVIEW_SIZE / Math.max(w, hgt);
    const small = resizeCanvas(canvas, Math.max(1, Math.round(w * s)), Math.max(1, Math.round(hgt * s)));
    w = small.width;
    hgt = small.height;
    data = new Uint8Array(small.getContext('2d')!.getImageData(0, 0, w, hgt).data.buffer);
  }
  return { ...t, pixels: { width: w, height: hgt, encoding: 'rgba', data } };
}

// ---------------------------------------------------------------------------
// Image conversion
// ---------------------------------------------------------------------------

/** Decodes an image file (PNG/JPG/WebP/BMP/GIF/DDS) and resizes it to exactly w×h RGBA. */
export async function imageToRgba(name: string, data: Uint8Array, w: number, hgt: number): Promise<{ rgba: Uint8Array; sourceWidth: number; sourceHeight: number }> {
  let source: HTMLCanvasElement;
  if (/\.dds$/i.test(name)) {
    const dds = parseDds(data);
    const rgba = dds.format === 'BC7' ? decodeBc7(dds.data, dds.width, dds.height) : decodeToRgba(formatCode(dds.format)!, dds.data, dds.width, dds.height);
    if (!rgba) throw new Error('BC7 DDS files need GPU support for BC7.');
    source = rgbaCanvas(rgba, dds.width, dds.height);
  } else {
    const bitmap = await createImageBitmap(new Blob([data.slice()]), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    source = document.createElement('canvas');
    source.width = bitmap.width;
    source.height = bitmap.height;
    source.getContext('2d')!.drawImage(bitmap, 0, 0);
    bitmap.close();
  }
  const sourceWidth = source.width;
  const sourceHeight = source.height;
  const out = resizeCanvas(source, w, hgt);
  return { rgba: new Uint8Array(out.getContext('2d')!.getImageData(0, 0, w, hgt).data.buffer), sourceWidth, sourceHeight };
}

function rgbaCanvas(rgba: Uint8Array, w: number, hgt: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = hgt;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, hgt), 0, 0);
  return c;
}

/** High-quality resize: halve repeatedly for big reductions, then a final smooth scale. */
function resizeCanvas(src: HTMLCanvasElement, w: number, hgt: number): HTMLCanvasElement {
  let cur = src;
  while (cur.width / 2 >= w && cur.height / 2 >= hgt && cur.width > 1 && cur.height > 1) {
    cur = drawScaled(cur, Math.max(w, Math.floor(cur.width / 2)), Math.max(hgt, Math.floor(cur.height / 2)));
  }
  return cur.width === w && cur.height === hgt ? cur : drawScaled(cur, w, hgt);
}

function drawScaled(src: HTMLCanvasElement, w: number, hgt: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = hgt;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, hgt);
  return c;
}

async function rgbaToPng(rgba: Uint8Array, w: number, hgt: number): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => rgbaCanvas(rgba, w, hgt).toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('PNG encoding failed.');
  return new Uint8Array(await blob.arrayBuffer());
}
