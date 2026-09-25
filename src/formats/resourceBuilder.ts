/**
 * Page packing for writing RSC7 resources.
 *
 * A resource segment (system or graphics) is a sequence of pages whose sizes
 * are `base << k` for k = 0..8, laid out largest first. The header flags store
 * how many pages of each size there are, with per-size limits:
 *
 *   k:      0  1  2  3   4   5   6  7  8
 *   max:    1  1  1  1 127  63  15  3  1
 *
 * The game loads each page separately, so a block must never straddle a page
 * boundary. The root structure must sit at offset 0 of the system segment.
 */

const MAX_PAGES = [1, 1, 1, 1, 127, 63, 15, 3, 1];
const ALIGN = 16;

const align = (n: number, a = ALIGN) => Math.ceil(n / a) * a;

export interface PackResult {
  /** Page flags (without the version nibble in bits 28–31). */
  flags: number;
  /** Total segment size in bytes. */
  size: number;
  /** Offset of each input block within the segment. */
  offsets: number[];
  pageCount: number;
}

interface Page {
  k: number;
  used: number;
  blocks: number[];
}

/**
 * Packs blocks of the given sizes into pages. With `rootFirst`, block 0 is
 * placed at offset 0 (the start of the first, largest page).
 *
 * Like the game's own files and CodeWalker, the largest page is kept as
 * small as possible (just big enough for the largest block); among layouts
 * with that page size, the smallest total wins.
 */
export function packSegment(sizes: number[], rootFirst = false): PackResult {
  if (sizes.length === 0) return { flags: 0, size: 0, offsets: [], pageCount: 0 };
  const largest = Math.max(...sizes.map((s) => align(s)));
  let maxPage = 0x200;
  while (maxPage < largest) maxPage *= 2;
  for (; maxPage <= 2 ** 31; maxPage *= 2) {
    let best: PackResult | undefined;
    for (let ss = 0; ss < 16; ss++) {
      const base = 0x200 << ss;
      if (base > maxPage) break;
      const maxK = Math.log2(maxPage / base);
      if (maxK > 8) continue;
      const result = tryPack(sizes, rootFirst, ss, maxK);
      if (result && (!best || result.size < best.size || (result.size === best.size && result.pageCount < best.pageCount))) best = result;
    }
    if (best) return best;
  }
  throw new Error('Resource data is too large to pack into pages.');
}

function tryPack(sizes: number[], rootFirst: boolean, ss: number, maxK: number): PackResult | undefined {
  const base = 0x200 << ss;
  const capacity = (k: number) => base << k;
  if (sizes.some((s) => s > capacity(maxK))) return undefined;

  // First-fit decreasing into the largest pages available, then shrink.
  const order = sizes.map((_, i) => i).filter((i) => !(rootFirst && i === 0));
  order.sort((a, b) => sizes[b] - sizes[a]);
  if (rootFirst) order.unshift(0);
  const counts = new Array(9).fill(0);
  const pages: Page[] = [];
  for (const i of order) {
    const size = align(sizes[i]);
    let target = pages.filter((p) => capacity(p.k) - p.used >= size).sort((a, b) => capacity(a.k) - a.used - (capacity(b.k) - b.used))[0];
    if (!target) {
      // Open the largest page allowed; it's shrunk to fit afterwards.
      let k = maxK;
      while (k >= 0 && (counts[k] >= MAX_PAGES[k] || capacity(k) < size)) k--;
      if (k < 0) return undefined;
      counts[k]++;
      target = { k, used: 0, blocks: [] };
      pages.push(target);
    }
    target.blocks.push(i);
    target.used += size;
  }

  // Shrink each page to the smallest class that fits, respecting the limits.
  const final = new Array(9).fill(0);
  const byUse = [...pages].sort((a, b) => b.used - a.used);
  for (const p of byUse) {
    let k = 0;
    while (k <= maxK && (capacity(k) < p.used || final[k] >= MAX_PAGES[k])) k++;
    if (k > maxK) return undefined;
    p.k = k;
    final[k]++;
  }

  // Pages are laid out largest first; the root's page must come first overall.
  const rootPage = rootFirst ? pages.find((p) => p.blocks[0] === 0) : undefined;
  pages.sort((a, b) => b.k - a.k || (a === rootPage ? -1 : b === rootPage ? 1 : 0));
  if (rootPage && pages[0] !== rootPage) {
    // Move the (small) root block to the front of the first page if it fits.
    const rootSize = align(sizes[0]);
    const first = pages[0];
    if (capacity(first.k) - first.used < rootSize) return undefined;
    rootPage.blocks.shift();
    rootPage.used -= rootSize;
    first.blocks.unshift(0);
    first.used += rootSize;
  }

  const offsets = new Array(sizes.length).fill(0);
  let pageStart = 0;
  for (const p of pages) {
    let off = pageStart;
    for (const i of p.blocks) {
      offsets[i] = off;
      off += align(sizes[i]);
    }
    pageStart += capacity(p.k);
  }

  const c = new Array(9).fill(0);
  for (const p of pages) c[p.k]++;
  const flags =
    (ss & 0xf) |
    ((c[8] & 0x1) << 4) |
    ((c[7] & 0x3) << 5) |
    ((c[6] & 0xf) << 7) |
    ((c[5] & 0x3f) << 11) |
    ((c[4] & 0x7f) << 17) |
    ((c[3] & 0x1) << 24) |
    ((c[2] & 0x1) << 25) |
    ((c[1] & 0x1) << 26) |
    ((c[0] & 0x1) << 27);
  return { flags: flags >>> 0, size: pageStart, offsets, pageCount: pages.length };
}

/** Page boundaries implied by segment flags, in layout order (for validation). */
export function pageRanges(flags: number): [number, number][] {
  const base = 0x200 << (flags & 0xf);
  const counts = [
    (flags >>> 27) & 1,
    (flags >>> 26) & 1,
    (flags >>> 25) & 1,
    (flags >>> 24) & 1,
    (flags >>> 17) & 0x7f,
    (flags >>> 11) & 0x3f,
    (flags >>> 7) & 0xf,
    (flags >>> 5) & 0x3,
    (flags >>> 4) & 0x1,
  ];
  const ranges: [number, number][] = [];
  let start = 0;
  for (let k = 8; k >= 0; k--) {
    for (let n = 0; n < counts[k]; n++) {
      ranges.push([start, start + (base << k)]);
      start += base << k;
    }
  }
  return ranges;
}
