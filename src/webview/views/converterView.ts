import { buildDds } from '../../formats/dds';
import { EncodableFormat, ENCODABLE_FORMATS, encodeLevel, encodeMipChain, isBlockFormat, maxMipLevels, mipLevelsFor } from '../../formats/bcEncode';
import { decodeToRgba, formatCode } from '../../formats/textures';
import { canvasToRgba, decodeImage, LoadedImage, nearestPowerOfTwo, resizeCanvas, rgbaCanvas } from '../imageUtils';
import { dataSize, kb } from '../textureEditor';
import { h, hostRequest, newRequestId, pref, setPref } from '../ui';

/** Preview images are shown at most this size. */
const PREVIEW_SIZE = 1024;

interface SourceFile {
  name: string;
  uri: string;
  data: Uint8Array;
  image?: LoadedImage;
  error?: string;
  row: HTMLElement;
  status: HTMLElement;
}

type MipMode = 'full' | 'gta' | 'none';
type SizeMode = 'original' | 'pow2' | '4096' | '2048' | '1024' | '512';

/** Converts images to .dds (DXT1/DXT5/... with generated mipmaps). */
export function converterView(files: { name: string; uri: string; data: Uint8Array }[]): HTMLElement {
  const sources: SourceFile[] = files.map((f) => {
    const status = h('span', { class: 'muted small' });
    const row = h('div', { class: 'entity-row converter-row' }, h('span', { class: 'converter-name' }, f.name), status);
    return { ...f, row, status };
  });
  let selected = sources[0];

  const formatSelect = h(
    'select',
    null,
    ENCODABLE_FORMATS.map((f) => h('option', { value: f.format }, f.label))
  );
  formatSelect.value = pref('converterFormat', 'DXT5');
  const mipSelect = h(
    'select',
    null,
    h('option', { value: 'full' }, 'Full chain (down to 1×1)'),
    h('option', { value: 'gta' }, 'Down to 4×4 (like most GTA textures)'),
    h('option', { value: 'none' }, 'None (1 level)')
  );
  mipSelect.value = pref('converterMips', 'full');
  const sizeSelect = h(
    'select',
    null,
    h('option', { value: 'original' }, 'Original size'),
    h('option', { value: 'pow2' }, 'Nearest power of two'),
    ...['4096', '2048', '1024', '512'].map((n) => h('option', { value: n }, `At most ${n} px`))
  );
  sizeSelect.value = pref('converterSize', 'original');

  const preview = h('div', { class: 'converter-preview checker' });
  const info = h('div', { class: 'muted' });
  const convertOne = h('button', { class: 'chip' }, 'Convert selected');
  const convertAll = h('button', { class: 'chip active' }, sources.length > 1 ? `Convert all (${sources.length})` : 'Convert');
  const overall = h('span', { class: 'muted' });

  const options = () => ({
    format: formatSelect.value as EncodableFormat,
    mips: mipSelect.value as MipMode,
    size: sizeSelect.value as SizeMode,
  });

  /** Output size for an image under the current options. */
  const outputSize = (w: number, hgt: number): [number, number] => {
    const { format, size } = options();
    if (size === 'pow2') {
      w = nearestPowerOfTwo(w);
      hgt = nearestPowerOfTwo(hgt);
    } else if (size !== 'original') {
      const max = Number(size);
      const scale = Math.min(1, max / Math.max(w, hgt));
      w = Math.round(w * scale);
      hgt = Math.round(hgt * scale);
    }
    if (isBlockFormat(format)) {
      w = Math.max(4, Math.round(w / 4) * 4);
      hgt = Math.max(4, Math.round(hgt / 4) * 4);
    }
    return [w, hgt];
  };
  const levelsFor = (w: number, hgt: number) => {
    const { format, mips } = options();
    return mips === 'full' ? maxMipLevels(w, hgt) : mips === 'gta' ? mipLevelsFor(format, w, hgt) : 1;
  };

  const load = async (s: SourceFile): Promise<LoadedImage | undefined> => {
    if (s.image || s.error) return s.image;
    try {
      s.image = await decodeImage(s.name, s.data);
    } catch (err) {
      s.error = (err as Error).message;
      s.status.textContent = `can't read: ${s.error}`;
    }
    return s.image;
  };

  const renderPreview = async () => {
    const img = await load(selected);
    if (!img) {
      preview.replaceChildren(h('div', { class: 'muted' }, selected.error ?? ''));
      info.textContent = '';
      return;
    }
    const [w, hgt] = outputSize(img.canvas.width, img.canvas.height);
    const levels = levelsFor(w, hgt);
    const { format } = options();
    // Show the real compression result at display size.
    const scale = Math.min(1, PREVIEW_SIZE / Math.max(w, hgt));
    const pw = Math.max(4, Math.round((w * scale) / 4) * 4);
    const ph = Math.max(4, Math.round((hgt * scale) / 4) * 4);
    const rgba = canvasToRgba(resizeCanvas(img.canvas, pw, ph));
    const decoded = decodeToRgba(formatCode(format)!, encodeLevel(format, rgba, pw, ph), pw, ph);
    const canvas = rgbaCanvas(decoded, pw, ph);
    canvas.className = 'converter-canvas';
    preview.replaceChildren(canvas);
    const bytes = dataSize(format, w, hgt, levels) ?? 0;
    info.textContent = `${selected.name}: ${img.canvas.width}×${img.canvas.height} → ${w}×${hgt} ${format}, ${levels} mip${levels === 1 ? '' : 's'} (${kb(bytes + 128)})`;
    sources.forEach((s) => s.row.classList.toggle('selected', s === selected));
  };

  let overwrite = false;
  const convert = async (list: SourceFile[]) => {
    convertOne.disabled = convertAll.disabled = true;
    let done = 0;
    for (const s of list) {
      const img = await load(s);
      if (!img) continue;
      s.status.textContent = 'encoding…';
      await new Promise((r) => setTimeout(r)); // let the status paint
      const { format } = options();
      const [w, hgt] = outputSize(img.canvas.width, img.canvas.height);
      const levels = levelsFor(w, hgt);
      const rgba = canvasToRgba(resizeCanvas(img.canvas, w, hgt));
      const dds = buildDds(format, w, hgt, levels, encodeMipChain(format, rgba, w, hgt, levels));
      const reply = await hostRequest({ type: 'writeConverted', requestId: newRequestId(), sourceUri: s.uri, data: dds, overwrite, format }, 'converted');
      if (reply.replaceAll) overwrite = true;
      s.status.textContent = reply.ok ? `✓ ${w}×${hgt} ${format}` : reply.skipped ? 'skipped' : `failed: ${reply.error}`;
      if (reply.ok) done++;
      overall.textContent = `${done} of ${list.length} converted`;
    }
    overall.textContent = `${done} of ${list.length} converted${done ? ' — saved next to the source images' : ''}`;
    convertOne.disabled = convertAll.disabled = false;
  };

  for (const s of sources) {
    s.row.onclick = () => {
      selected = s;
      void renderPreview();
    };
  }
  const onOption = (key: string, el: HTMLSelectElement) => {
    el.onchange = () => {
      setPref(key, el.value);
      void renderPreview();
    };
  };
  onOption('converterFormat', formatSelect);
  onOption('converterMips', mipSelect);
  onOption('converterSize', sizeSelect);
  convertOne.onclick = () => void convert([selected]);
  convertAll.onclick = () => void convert(sources);

  void renderPreview();
  return h(
    'div',
    { class: 'ytyp-view' },
    h(
      'div',
      { class: 'toolbar' },
      h('strong', null, 'Convert to DDS'),
      h('label', { class: 'toggle' }, 'Format', formatSelect),
      h('label', { class: 'toggle' }, 'Mipmaps', mipSelect),
      h('label', { class: 'toggle' }, 'Size', sizeSelect),
      h('span', { class: 'spacer' }),
      ...(sources.length > 1 ? [convertOne] : []),
      convertAll
    ),
    h(
      'div',
      { class: 'converter-body' },
      h('div', { class: 'converter-list' }, sources.map((s) => s.row)),
      h('div', { class: 'converter-main' }, info, preview, overall)
    )
  );
}
