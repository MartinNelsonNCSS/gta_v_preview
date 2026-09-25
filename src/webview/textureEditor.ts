import type { TextureData } from '../shared/model';
import { buildDds } from '../formats/dds';
import { decodeToRgba, formatCode, textureDataSize } from '../formats/textures';
import { ENCODABLE_FORMATS, encodeLevel, encodeMipChain, isBlockFormat, isEncodable, maxMipLevels, mipLevelsFor } from '../formats/bcEncode';
import { decodeBc7 } from './bc7';
import { canvasToRgba, ddsTopRgba, decodeImage, LoadedImage, resizeCanvas, rgbaCanvas, rgbaToPng } from './imageUtils';
import { h, hostRequest, newRequestId } from './ui';

/**
 * Texture replacement, conversion and export. Changes are first shown as a
 * preview (nothing written); "Save to file" then sends the result to the
 * extension host, which writes it into the texture's file.
 *
 * Settings are size, format and mip count. The source is either a picked
 * image or the texture's own pixels. A picked .dds whose format and size match
 * the settings is stored as-is (its own mips, no re-encoding).
 */

/** Previews are shown at most this size; the full-size data is kept for saving. */
const PREVIEW_SIZE = 2048;
/** Largest texture dimension offered when growing a texture. */
const MAX_SIZE = 8192;

/** A texture shown in the viewer that can be previewed/replaced/exported. */
export interface EditTarget {
  /** The texture as loaded from its file (must carry `origin` for save/export). */
  original: TextureData;
  /** Shows a preview in the caller's views; undefined restores the original. */
  setPreview(preview: TextureData | undefined): void;
}

interface Settings {
  width: number;
  height: number;
  format: string;
  levels: number;
}

interface PendingEdit extends Settings {
  source: LoadedImage;
  /** File name of the picked image, or 'original' when converting the texture itself. */
  from: string;
  /** Pixels at the target size, to be encoded (unset when `raw` is used). */
  rgba?: Uint8Array;
  /** DDS data stored as-is (all `levels` mips). */
  raw?: Uint8Array;
  preview: TextureData;
}

/** Changes not yet saved, keyed by origin + texture name (survive closing the viewer). */
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

/** Bytes of `levels` mips of a w×h `format` texture. */
export function dataSize(format: string, w: number, h: number, levels: number): number | undefined {
  const code = formatCode(format);
  return code === undefined ? undefined : textureDataSize(code, w, h, levels);
}

export const kb = (n: number) => `${Math.max(1, Math.round(n / 1024)).toLocaleString()} KB`;

/** Whether a DDS's own data can be stored for these settings. */
function rawUsable(source: LoadedImage | undefined, s: Settings): boolean {
  const d = source?.dds;
  return !!d && d.format === s.format && d.width === s.width && d.height === s.height && s.levels <= d.levels;
}

/**
 * Builds the action bar (Replace / Size / Format / Mips / Save / Revert / Export)
 * for a texture. `show` is called with the texture to display whenever it changes.
 */
export function editActions(target: EditTarget, show: (t: TextureData) => void): HTMLElement {
  const t = target.original;
  const status = h('span', { class: 'muted edit-status' });
  const sizeInfo = h('span', { class: 'muted small' });
  const inYtd = /\.ytd$/i.test(t.origin ?? '');
  const kind = (t.origin ?? '').split('.').pop()?.toLowerCase() ?? '';
  /** Space the texture's data occupies; embedded textures can't grow past it. */
  const originalSize = dataSize(t.format, t.width, t.height, t.levels) ?? Infinity;

  const replace = h('button', { class: 'chip', title: 'Preview another image on this texture (PNG, JPG, WebP, BMP, DDS)' }, 'Replace…');
  const sizeSelect = h('select', { title: 'Size to save the texture at' });
  const formatSelect = h('select', { title: 'Format to save the texture in' });
  const mipsSelect = h('select', { title: 'Number of mipmap levels to store' });
  const save = h('button', { class: 'chip active' }, 'Save to file');
  const revert = h('button', { class: 'chip', title: 'Discard the change' }, 'Revert');
  const png = h('button', { class: 'chip', title: 'Export as PNG (the preview if there is one, otherwise the original)' }, 'Export PNG');
  const dds = h('button', { class: 'chip', title: 'Export as DDS with the chosen size, format and mips (the original data if nothing is changed)' }, 'Export DDS');
  if (!t.origin) {
    for (const b of [replace, sizeSelect, formatSelect, mipsSelect, png, dds]) {
      b.disabled = true;
      b.title = "This texture's source file is unknown.";
    }
  }
  const say = (text: string) => (status.textContent = text);
  const current = () => pending.get(keyOf(t));

  // -- settings -----------------------------------------------------------------

  const settings = (): Settings => {
    const [width, height] = sizeSelect.value.split('x').map(Number);
    const format = formatSelect.value;
    let levels: number;
    if (mipsSelect.value && mipsSelect.value !== 'auto') levels = Number(mipsSelect.value);
    else if (format === t.format && width === t.width && height === t.height) levels = t.levels;
    else if (rawUsable(current()?.source, { width, height, format, levels: 1 })) levels = current()!.source.dds!.levels;
    else levels = isEncodable(format) ? mipLevelsFor(format, width, height) : 1;
    return { width, height, format, levels: Math.min(levels, maxMipLevels(width, height)) };
  };

  /** Whether these settings can be saved into the texture's file. */
  const canSave = (s: Settings, source?: LoadedImage): { ok: boolean; why?: string } => {
    if (!t.origin) return { ok: false, why: "This texture's source file is unknown." };
    if (!isEncodable(s.format) && !rawUsable(source, s)) {
      return { ok: false, why: `${s.format} can't be encoded here; choose another format, or replace with a ${s.format} .dds of this size.` };
    }
    if (isBlockFormat(s.format) && (s.width % 4 || s.height % 4)) return { ok: false, why: `${s.format} needs a width and height that are multiples of 4.` };
    const size = dataSize(s.format, s.width, s.height, s.levels);
    if (!inYtd && (size === undefined || size > originalSize)) {
      return { ok: false, why: `Doesn't fit inside the .${kind}; choose a smaller size, a more compact format or fewer mips (or use a .ytd).` };
    }
    return { ok: true };
  };

  const fillFormats = () => {
    const selected = formatSelect.value || current()?.format || t.format;
    const extra = new Set<string>();
    if (!isEncodable(t.format)) extra.add(t.format);
    const d = current()?.source.dds;
    if (d && !isEncodable(d.format)) extra.add(d.format);
    formatSelect.replaceChildren(
      ...[...extra].map((f) =>
        h('option', { value: f }, f === d?.format ? `${f} (DDS data, stored as-is)` : `${f} (current, can't be re-encoded)`)
      ),
      ...ENCODABLE_FORMATS.map((f) => h('option', { value: f.format }, f.format === t.format ? `${f.label} (current)` : f.label))
    );
    formatSelect.value = selected;
  };

  const fillSizes = () => {
    const p = current();
    const selected = sizeSelect.value || (p ? `${p.width}x${p.height}` : `${t.width}x${t.height}`);
    const options: { w: number; h: number; label: string }[] = [];
    for (const m of [4, 2]) {
      if (Math.max(t.width, t.height) * m <= MAX_SIZE) options.push({ w: t.width * m, h: t.height * m, label: `${t.width * m}×${t.height * m} (${m}×)` });
    }
    options.push({ w: t.width, h: t.height, label: `${t.width}×${t.height} (current)` });
    for (let k = 1; k < 12 && Math.min(t.width >> k, t.height >> k) >= 4; k++) {
      options.push({ w: t.width >> k, h: t.height >> k, label: `${t.width >> k}×${t.height >> k} (1/${1 << k})` });
    }
    if (p && p.from !== 'original') {
      // The picked image's own size (snapped to multiples of 4 for block formats).
      const src = p.source.canvas;
      const w = Math.min(MAX_SIZE, Math.max(4, Math.round(src.width / 4) * 4));
      const hh = Math.min(MAX_SIZE, Math.max(4, Math.round(src.height / 4) * 4));
      if (!options.some((o) => o.w === w && o.h === hh)) options.push({ w, h: hh, label: `${w}×${hh} (image size)` });
    }
    const format = formatSelect.value;
    sizeSelect.replaceChildren(
      ...options.map((o) => {
        // Disabled only if it can't fit even without mipmaps.
        const size = dataSize(format, o.w, o.h, 1);
        const tooBig = !inYtd && size !== undefined && size > originalSize;
        return h('option', { value: `${o.w}x${o.h}`, disabled: tooBig }, tooBig ? `${o.label} — too big for this .${kind}` : o.label);
      })
    );
    sizeSelect.value = selected;
    if (!sizeSelect.value || sizeSelect.selectedOptions[0]?.disabled) {
      sizeSelect.value = [...sizeSelect.options].find((o) => !o.disabled)?.value ?? `${t.width}x${t.height}`;
    }
  };

  const fillMips = () => {
    const selected = mipsSelect.value || 'auto';
    const [w, hgt] = sizeSelect.value.split('x').map(Number);
    const max = maxMipLevels(w, hgt);
    mipsSelect.value = 'auto';
    const autoLevels = settings().levels;
    mipsSelect.replaceChildren(
      h('option', { value: 'auto' }, `Auto (${autoLevels})`),
      ...Array.from({ length: max }, (_, i) => max - i).map((n) => h('option', { value: String(n) }, n === 1 ? '1 (no mipmaps)' : String(n)))
    );
    mipsSelect.value = selected === 'auto' || Number(selected) <= max ? selected : 'auto';
  };

  const refresh = () => {
    const p = current();
    const s = settings();
    save.hidden = revert.hidden = !p;
    const check = canSave(s, p?.source);
    save.disabled = !check.ok;
    save.title = check.ok ? `Write the change into ${originName(t) || 'its file'}` : check.why!;
    const size = dataSize(s.format, s.width, s.height, s.levels);
    const asIs = p?.raw ? ' · DDS data used as-is' : '';
    sizeInfo.textContent = size !== undefined ? `${s.width}×${s.height} ${s.format}, ${s.levels} mip${s.levels === 1 ? '' : 's'}: ${kb(size)}${Number.isFinite(originalSize) ? ` (was ${kb(originalSize)})` : ''}${asIs}` : '';
  };

  // -- applying changes -------------------------------------------------------------

  /** Builds the pending change for `source` with the current settings and shows it. */
  const apply = (source: LoadedImage, from: string) => {
    const s = settings();
    if (from === 'original' && s.width === t.width && s.height === t.height && s.format === t.format && s.levels === t.levels) {
      revertEdit(false);
      return;
    }
    let edit: PendingEdit;
    if (rawUsable(source, s)) {
      const d = source.dds!;
      const raw = d.allLevels.subarray(0, dataSize(s.format, s.width, s.height, s.levels));
      edit = { ...s, source, from, raw, preview: makePreview(t, ddsTopRgba(d) ?? new Uint8Array(s.width * s.height * 4), s, false) };
    } else {
      const rgba = canvasToRgba(resizeCanvas(source.canvas, s.width, s.height));
      edit = { ...s, source, from, rgba, preview: makePreview(t, rgba, s, true) };
    }
    pending.set(keyOf(t), edit);
    target.setPreview(edit.preview);
    show(edit.preview);
    const what = from === 'original' ? 'the converted texture' : from;
    const resized = source.canvas.width !== s.width || source.canvas.height !== s.height ? ` (from ${source.canvas.width}×${source.canvas.height})` : '';
    say(`Previewing ${what} at ${s.width}×${s.height} ${s.format}${resized}. Not saved yet.`);
    refresh();
  };

  const revertEdit = (resetSettings = true) => {
    pending.delete(keyOf(t));
    target.setPreview(undefined);
    show(t);
    if (resetSettings) {
      formatSelect.value = t.format;
      sizeSelect.value = `${t.width}x${t.height}`;
      mipsSelect.value = 'auto';
    }
    fillFormats();
    fillSizes();
    fillMips();
    say(resetSettings ? 'Reverted.' : '');
    refresh();
  };

  /** The texture's own full-resolution pixels (to resize/convert without a new image). */
  const loadOriginal = async (): Promise<LoadedImage | undefined> => {
    if (!t.origin) return undefined;
    say('Loading full-resolution texture…');
    const full = await hostRequest({ type: 'getFullTexture', requestId: newRequestId(), origin: t.origin, name: t.name }, 'fullTexture');
    const px = full.texture?.pixels;
    const rgba = px && (px.encoding === 'bc7' ? decodeBc7(px.data, px.width, px.height) : px.data);
    if (!px || !rgba) {
      say(`Couldn't load the texture: ${full.error ?? 'no pixel data'}`);
      return undefined;
    }
    return { canvas: rgbaCanvas(rgba, px.width, px.height) };
  };

  const onSettingsChange = async () => {
    fillSizes();
    fillMips();
    const p = current();
    if (p) return apply(p.source, p.from);
    const s = settings();
    if (s.width === t.width && s.height === t.height && s.format === t.format && s.levels === t.levels) return refresh();
    const source = await loadOriginal();
    if (source) apply(source, 'original');
  };

  replace.onclick = async () => {
    const picked = await hostRequest({ type: 'pickImage', requestId: newRequestId() }, 'pickedImage');
    if (!picked.data || !picked.name) return;
    say('Loading image…');
    try {
      const source = await decodeImage(picked.name, picked.data);
      // Temporarily register so the option lists include the image's size/format.
      pending.set(keyOf(t), { ...settings(), source, from: picked.name, preview: t });
      fillFormats();
      if (source.dds) {
        // Default to storing the DDS as-is: its format, size and mips.
        formatSelect.value = source.dds.format;
        fillSizes();
        sizeSelect.value = `${source.dds.width}x${source.dds.height}`;
        fillMips();
        mipsSelect.value = String(source.dds.levels);
      } else {
        fillSizes();
        fillMips();
      }
      apply(source, picked.name);
    } catch (err) {
      pending.delete(keyOf(t));
      say(`Couldn't load ${picked.name}: ${(err as Error).message}`);
    }
  };

  sizeSelect.onchange = formatSelect.onchange = mipsSelect.onchange = () => void onSettingsChange();
  revert.onclick = () => revertEdit();

  save.onclick = async () => {
    const p = current();
    if (!p || !t.origin) return;
    save.disabled = true;
    say('Encoding and saving…');
    const reply = await hostRequest(
      {
        type: 'replaceTexture',
        requestId: newRequestId(),
        origin: t.origin,
        name: t.name,
        width: p.width,
        height: p.height,
        format: p.format,
        levels: p.levels,
        rgba: p.rgba,
        encoded: p.raw,
      },
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
    const p = current();
    let rgba: Uint8Array | null | undefined;
    let w = t.width;
    let hgt = t.height;
    if (p) {
      rgba = p.rgba ?? (p.source.dds ? ddsTopRgba(p.source.dds) : undefined);
      w = p.width;
      hgt = p.height;
    } else {
      const full = await loadOriginal();
      if (full) {
        rgba = canvasToRgba(full.canvas);
        w = full.canvas.width;
        hgt = full.canvas.height;
      }
    }
    if (!rgba) return say('Export failed: no pixel data.');
    const data = await rgbaToPng(rgba, w, hgt);
    const saved = await hostRequest({ type: 'saveFile', requestId: newRequestId(), suggestedName: `${t.name}.png`, data, filterName: 'PNG image', extensions: ['png'] }, 'saved');
    say(saved.path ? `Exported to ${saved.path}` : saved.error ? `Export failed: ${saved.error}` : '');
  };

  dds.onclick = async () => {
    if (!t.origin) return;
    const p = current();
    if (!p) {
      // Nothing changed: export the original data exactly.
      const saved = await hostRequest({ type: 'exportDds', requestId: newRequestId(), origin: t.origin, name: t.name }, 'saved');
      return say(saved.path ? `Exported to ${saved.path}` : saved.error ? `Export failed: ${saved.error}` : '');
    }
    let data: Uint8Array;
    if (p.raw) data = p.raw;
    else if (p.rgba && isEncodable(p.format)) {
      say('Encoding…');
      data = encodeMipChain(p.format, p.rgba, p.width, p.height, p.levels);
    } else return say(`Can't export ${p.format}: it can't be encoded here.`);
    const file = buildDds(p.format, p.width, p.height, p.levels, data);
    const saved = await hostRequest({ type: 'saveFile', requestId: newRequestId(), suggestedName: `${t.name}.dds`, data: file, filterName: 'DDS texture', extensions: ['dds'] }, 'saved');
    say(saved.path ? `Exported ${p.format} (${p.levels} mips) to ${saved.path}` : saved.error ? `Export failed: ${saved.error}` : '');
  };

  // -- initial state ------------------------------------------------------------------

  const existing = current();
  formatSelect.value = existing?.format ?? t.format;
  fillFormats();
  if (existing) sizeSelect.value = `${existing.width}x${existing.height}`;
  fillSizes();
  fillMips();
  if (existing) {
    mipsSelect.value = String(existing.levels);
    say(`Previewing ${existing.from === 'original' ? 'the converted texture' : existing.from} at ${existing.width}×${existing.height} ${existing.format}. Not saved yet.`);
  }
  refresh();
  return h(
    'div',
    { class: 'edit-actions' },
    replace,
    h('label', { class: 'toggle' }, 'Size', sizeSelect),
    h('label', { class: 'toggle' }, 'Format', formatSelect),
    h('label', { class: 'toggle' }, 'Mips', mipsSelect),
    save,
    revert,
    h('span', { class: 'sep' }),
    png,
    dds,
    h('div', { class: 'edit-info' }, sizeInfo, status)
  );
}

/**
 * A display-sized texture previewing a change. With `simulate`, the pixels are
 * run through the target format's encoder and decoder so the preview shows the
 * real compression result (e.g. DXT1's 1-bit alpha, BC4's single channel).
 */
function makePreview(t: TextureData, rgba: Uint8Array, s: Settings, simulate: boolean): TextureData {
  let w = s.width;
  let hgt = s.height;
  let data = rgba;
  if (Math.max(w, hgt) > PREVIEW_SIZE) {
    const scale = PREVIEW_SIZE / Math.max(w, hgt);
    const small = resizeCanvas(rgbaCanvas(rgba, w, hgt), Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(hgt * scale)));
    w = small.width;
    hgt = small.height;
    data = canvasToRgba(small);
  }
  const code = formatCode(s.format);
  if (simulate && isEncodable(s.format) && code !== undefined) data = decodeToRgba(code, encodeLevel(s.format, data, w, hgt), w, hgt);
  return { ...t, width: s.width, height: s.height, format: s.format, levels: s.levels, pixels: { width: w, height: hgt, encoding: 'rgba', data } };
}
