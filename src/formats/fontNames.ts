/*
 * Family names from TrueType / OpenType font files (and .ttc collections),
 * read from their `name` table, so the system's installed fonts can be listed.
 */

const tag = (v: DataView, o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));

function decodeUtf16BE(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  return s;
}

function familyAt(v: DataView, bytes: Uint8Array, offset: number): string | undefined {
  const numTables = v.getUint16(offset + 4);
  let name: { off: number; len: number } | undefined;
  for (let i = 0; i < numTables; i++) {
    const rec = offset + 12 + i * 16;
    if (rec + 16 > v.byteLength) return undefined;
    if (tag(v, rec) === 'name') name = { off: v.getUint32(rec + 8), len: v.getUint32(rec + 12) };
  }
  if (!name || name.off + 6 > v.byteLength) return undefined;
  const count = v.getUint16(name.off + 2);
  const strings = name.off + v.getUint16(name.off + 4);
  // nameID 1 is the family name apps use (e.g. "Segoe UI Semibold"); Windows English first, then Mac, then any.
  let best: { score: number; text: string } | undefined;
  for (let i = 0; i < count; i++) {
    const r = name.off + 6 + i * 12;
    if (r + 12 > v.byteLength) break;
    const platform = v.getUint16(r);
    const language = v.getUint16(r + 4);
    const id = v.getUint16(r + 6);
    if (id !== 1) continue;
    const length = v.getUint16(r + 8);
    const start = strings + v.getUint16(r + 10);
    if (start + length > bytes.length) continue;
    const raw = bytes.subarray(start, start + length);
    const text = platform === 1 ? String.fromCharCode(...raw) : decodeUtf16BE(raw);
    const score = platform === 3 && language === 0x409 ? 3 : platform === 3 ? 2 : platform === 1 ? 1 : 0;
    if (text.trim() && (!best || score > best.score)) best = { score, text: text.trim() };
  }
  return best?.text;
}

/** The family names in a .ttf/.otf/.ttc file (empty if it isn't one). */
export function fontFamilies(bytes: Uint8Array): string[] {
  try {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (v.byteLength < 12) return [];
    const head = tag(v, 0);
    if (head === 'ttcf') {
      const n = Math.min(v.getUint32(8), 64);
      return [...new Set(Array.from({ length: n }, (_, i) => familyAt(v, bytes, v.getUint32(12 + i * 4))).filter((x): x is string => !!x))];
    }
    const version = v.getUint32(0);
    if (version !== 0x00010000 && head !== 'OTTO' && head !== 'true') return [];
    const f = familyAt(v, bytes, 0);
    return f ? [f] : [];
  } catch {
    return [];
  }
}
