import { ENCODABLE_FORMATS, isBlockFormat, isEncodable, maxMipLevels, mipLevelsFor, type EncodableFormat } from '../formats/bcEncode';
import { textureNameProblem } from '../formats/textureNames';
import type { WebviewToHost } from '../shared/model';
import { canvasToRgba, decodeImage, LoadedImage, nearestPowerOfTwo, resizeCanvas } from './imageUtils';
import { h, hostRequest, newRequestId } from './ui';

/**
 * Adding, deleting and renaming textures in a .ytd. The host confirms, writes
 * (keeping a .bak) and the editor reloads the dictionary when the file changes.
 */

type AddItem = NonNullable<Extract<WebviewToHost, { type: 'editYtd' }>['add']>[number];

const isPowerOfTwo = (n: number) => n > 0 && (n & (n - 1)) === 0;

/** A file name made into a texture name ("My Logo (1).png" → "My_Logo_1"). */
export function textureNameFromFile(file: string): string {
  const stem = file.replace(/\.[^.]+$/, '');
  return stem.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'texture';
}

function hasAlpha(rgba: Uint8Array): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 255) return true;
  return false;
}

/** Asks the host to rename `name` (VS Code input box) in the .ytd at `origin`. */
export async function renameTexture(origin: string, name: string): Promise<{ ok: boolean; error?: string }> {
  return hostRequest({ type: 'renameTexture', requestId: newRequestId(), origin, name }, 'ytdEdited');
}

/** Asks the host to delete textures (after its confirmation). */
export async function deleteTextures(origin: string, names: string[]): Promise<{ ok: boolean; error?: string }> {
  return hostRequest({ type: 'editYtd', requestId: newRequestId(), origin, remove: names }, 'ytdEdited');
}

interface Row {
  file: string;
  image: LoadedImage;
  name: HTMLInputElement;
  format: HTMLSelectElement;
  problem: HTMLElement;
  el: HTMLElement;
}

/**
 * Picks images and shows a dialog to name them and choose format and
 * mipmaps, then adds them to the .ytd at `origin`.
 */
export async function addTextures(origin: string, existing: string[], onStatus: (s: string) => void): Promise<void> {
  const picked = await hostRequest({ type: 'pickImages', requestId: newRequestId() }, 'pickedImages');
  if (!picked.files.length) return;
  onStatus(`Reading ${picked.files.length} image${picked.files.length === 1 ? '' : 's'}…`);
  const images: { file: string; image: LoadedImage }[] = [];
  const failed: string[] = [];
  for (const f of picked.files) {
    try {
      images.push({ file: f.name, image: await decodeImage(f.name, f.data) });
    } catch (err) {
      failed.push(`${f.name}: ${(err as Error).message}`);
    }
  }
  onStatus(failed.length ? `Couldn't read ${failed.join('; ')}` : '');
  if (!images.length) return;

  const taken = new Set(existing.map((n) => n.toLowerCase()));
  const anyNonPow2 = images.some(({ image }) => !isPowerOfTwo(image.canvas.width) || !isPowerOfTwo(image.canvas.height));
  const pow2 = h('input', { type: 'checkbox', checked: anyNonPow2 });
  const mips = h('input', { type: 'checkbox', checked: true });
  const addButton = h('button', { class: 'chip active' }, 'Add');
  const status = h('span', { class: 'muted edit-status' });

  /** Size an image will be stored at. */
  const targetSize = (img: LoadedImage, format: string) => {
    let { width, height } = img.canvas;
    if (pow2.checked) [width, height] = [nearestPowerOfTwo(width), nearestPowerOfTwo(height)];
    if (isBlockFormat(format)) [width, height] = [Math.max(4, Math.round(width / 4) * 4), Math.max(4, Math.round(height / 4) * 4)];
    return { width, height };
  };

  const rows: Row[] = images.map(({ file, image }) => {
    const thumb = image.canvas.cloneNode() as HTMLCanvasElement;
    thumb.getContext('2d')!.drawImage(image.canvas, 0, 0);
    thumb.className = 'add-thumb';
    const dds = image.dds;
    const alpha = hasAlpha(canvasToRgba(image.canvas));
    const format = h(
      'select',
      { title: 'Format to store the texture in' },
      ...(dds ? [h('option', { value: `dds:${dds.format}` }, `As in the DDS (${dds.format}, ${dds.levels} mip${dds.levels === 1 ? '' : 's'})`)] : []),
      ...ENCODABLE_FORMATS.map((f) => h('option', { value: f.format, title: f.label }, f.format))
    );
    format.value = dds ? `dds:${dds.format}` : alpha ? 'DXT5' : 'DXT1';
    const name = h('input', { type: 'text', value: textureNameFromFile(file), spellcheck: false, class: 'add-name' });
    const problem = h('div', { class: 'small' });
    const el = h(
      'div',
      { class: 'add-row' },
      h('div', { class: 'checker add-thumb-box' }, thumb),
      h('div', { class: 'add-fields' }, name, h('div', { class: 'muted small add-source' }, file), problem),
      format
    );
    const row = { file, image, name, format, problem, el };
    name.addEventListener('input', validate);
    format.addEventListener('change', validate);
    return row;
  });

  /** Checks names and sizes, updates notes; true when everything can be added. */
  function validate(): boolean {
    let ok = true;
    const seen = new Set<string>();
    for (const r of rows) {
      const name = r.name.value.trim();
      const raw = r.format.value.startsWith('dds:');
      const format = raw ? r.image.dds!.format : r.format.value;
      const { width, height } = raw ? { width: r.image.dds!.width, height: r.image.dds!.height } : targetSize(r.image, format);
      const notes: string[] = [];
      let error = textureNameProblem(name);
      if (!error && seen.has(name.toLowerCase())) error = 'Another new texture has this name.';
      seen.add(name.toLowerCase());
      if (raw && isBlockFormat(format) && (width % 4 || height % 4)) error = `${format} needs a size that's a multiple of 4.`;
      if (!raw && !isEncodable(format)) error = `${format} can't be encoded here.`;
      if (!error && taken.has(name.toLowerCase())) notes.push('replaces the existing texture');
      const size = `${width}×${height}`;
      notes.unshift(size !== `${r.image.canvas.width}×${r.image.canvas.height}` ? `${r.image.canvas.width}×${r.image.canvas.height} → ${size}` : size);
      r.problem.className = error ? 'small opt-bad' : taken.has(name.toLowerCase()) ? 'small warn' : 'small muted';
      r.problem.textContent = error ?? notes.join(' · ');
      if (error) ok = false;
    }
    addButton.disabled = !ok;
    addButton.textContent = `Add ${rows.length} texture${rows.length === 1 ? '' : 's'}`;
    return ok;
  }
  pow2.addEventListener('change', validate);
  validate();

  const close = () => overlay.remove();
  addButton.onclick = async () => {
    if (!validate()) return;
    addButton.disabled = true;
    status.textContent = 'Preparing…';
    const add: AddItem[] = rows.map((r) => {
      const name = r.name.value.trim();
      if (r.format.value.startsWith('dds:')) {
        const d = r.image.dds!;
        return { name, width: d.width, height: d.height, format: d.format, levels: d.levels, encoded: d.allLevels };
      }
      const format = r.format.value as EncodableFormat;
      const { width, height } = targetSize(r.image, format);
      const canvas = width === r.image.canvas.width && height === r.image.canvas.height ? r.image.canvas : resizeCanvas(r.image.canvas, width, height);
      const levels = mips.checked ? Math.min(mipLevelsFor(format, width, height), maxMipLevels(width, height)) : 1;
      return { name, width, height, format, levels, rgba: canvasToRgba(canvas) };
    });
    status.textContent = 'Waiting for confirmation…';
    const reply = await hostRequest({ type: 'editYtd', requestId: newRequestId(), origin, add }, 'ytdEdited');
    if (reply.ok) {
      close();
      onStatus(`Added ${add.length} texture${add.length === 1 ? '' : 's'}; reloading…`);
    } else {
      addButton.disabled = false;
      status.textContent = reply.cancelled ? '' : `Couldn't add: ${reply.error}`;
    }
  };

  const overlay = h(
    'div',
    { class: 'lightbox', onclick: (e: Event) => e.target === overlay && close() },
    h(
      'div',
      { class: 'lightbox-panel add-panel' },
      h('div', { class: 'lightbox-header' }, h('strong', null, 'Add textures'), h('button', { class: 'chip', onclick: close, title: 'Close (Esc)' }, '✕')),
      h('div', { class: 'add-list' }, rows.map((r) => r.el)),
      h(
        'div',
        { class: 'row add-options' },
        h('label', { class: 'toggle', title: 'GTA expects power-of-two sizes (256, 512, 1024…)' }, pow2, 'Resize to powers of two'),
        h('label', { class: 'toggle', title: 'Generate a full mipmap chain (recommended)' }, mips, 'Generate mipmaps'),
        h('span', { class: 'spacer' }),
        status,
        addButton
      )
    )
  );
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      close();
      window.removeEventListener('keydown', onKey);
    }
  };
  window.addEventListener('keydown', onKey);
  document.body.append(overlay);
  rows[0]?.name.focus();
}
