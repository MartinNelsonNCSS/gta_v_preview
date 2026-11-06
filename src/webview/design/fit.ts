import { DESIGN_SIZE, Mirror, Pt } from './model';
import { Affine, apply, clipToSide, compose, fitAffine, fitSimilarity, inPolygon, lineCrosses, mirrorMapping, polygonBox, reflection, sideOf } from './mirror';

/*
 * Lining mirrors up with the UV template. The template's lines are read
 * into a mask; a distance map gives, for any point, the nearest template
 * line. A mirror is good when the source piece's lines, mapped through it,
 * land on the template's lines on the other side.
 */

/** Mask resolution: 2 design units per cell. */
const N = 1024;
const CELL = DESIGN_SIZE / N;

export interface LineMap {
  /** Line strength per cell (0–1). */
  mask: Float32Array;
}

const masks = new WeakMap<HTMLCanvasElement, LineMap>();

/** The template's lines: dark lines on a light, opaque template, or the drawn pixels of a transparent one. */
export function lineMap(template: HTMLCanvasElement): LineMap {
  const cached = masks.get(template);
  if (cached) return cached;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(template, 0, 0, N, N);
  const px = ctx.getImageData(0, 0, N, N).data;
  let alpha = 0;
  for (let i = 3; i < px.length; i += 4 * 97) alpha += px[i];
  const opaque = alpha / (px.length / (4 * 97)) > 200;
  let lum = 0;
  if (opaque) for (let i = 0; i < px.length; i += 4 * 97) lum += (px[i] + px[i + 1] + px[i + 2]) / 3;
  const darkLines = !opaque || lum / (px.length / (4 * 97)) > 128;
  const mask = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) {
    const a = px[i * 4 + 3] / 255;
    const l = (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 765;
    mask[i] = opaque ? (darkLines ? 1 - l : l) : a;
  }
  const map = { mask };
  masks.set(template, map);
  return map;
}

/** A tinted copy of the template's lines (for the alignment ghost). */
const ghosts = new WeakMap<HTMLCanvasElement, Map<string, HTMLCanvasElement>>();
export function tintedTemplate(template: HTMLCanvasElement, colour: [number, number, number]): HTMLCanvasElement {
  const key = colour.join();
  let byColour = ghosts.get(template);
  if (!byColour) ghosts.set(template, (byColour = new Map()));
  const hit = byColour.get(key);
  if (hit) return hit;
  const { mask } = lineMap(template);
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(N, N);
  for (let i = 0; i < N * N; i++) {
    img.data[i * 4] = colour[0];
    img.data[i * 4 + 1] = colour[1];
    img.data[i * 4 + 2] = colour[2];
    img.data[i * 4 + 3] = Math.round(Math.min(1, mask[i] * 1.6) * 255);
  }
  ctx.putImageData(img, 0, 0);
  byColour.set(key, c);
  return c;
}

/** Line points inside a polygon (design units), at most `max`, spread evenly. */
export function linePoints(lines: LineMap, area: Pt[], max = 2000): Pt[] {
  const b = polygonBox(area);
  const out: Pt[] = [];
  const x0 = Math.max(0, Math.floor(b.x / CELL));
  const x1 = Math.min(N - 1, Math.ceil((b.x + b.w) / CELL));
  const y0 = Math.max(0, Math.floor(b.y / CELL));
  const y1 = Math.min(N - 1, Math.ceil((b.y + b.h) / CELL));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (lines.mask[y * N + x] < 0.35) continue;
      const p = { x: (x + 0.5) * CELL, y: (y + 0.5) * CELL };
      if (inPolygon(area, p.x, p.y)) out.push(p);
    }
  }
  if (out.length <= max) return out;
  const step = out.length / max;
  return Array.from({ length: max }, (_, i) => out[Math.floor(i * step)]);
}

export interface Nearest {
  /** Distance (in cells) and nearest line cell, per cell. */
  dist: Float32Array;
  near: Int32Array;
}

/** Distance to the nearest template line, skipping lines inside `exclude` (the source piece itself). */
export function nearestLines(lines: LineMap, exclude?: Pt[]): Nearest {
  const dist = new Float32Array(N * N).fill(Infinity);
  const near = new Int32Array(N * N).fill(-1);
  const box = exclude && polygonBox(exclude);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      if (lines.mask[i] < 0.35) continue;
      if (exclude && box) {
        const px = (x + 0.5) * CELL;
        const py = (y + 0.5) * CELL;
        if (px >= box.x && px <= box.x + box.w && py >= box.y && py <= box.y + box.h && inPolygon(exclude, px, py)) continue;
      }
      dist[i] = 0;
      near[i] = i;
    }
  }
  // Two passes, carrying each cell's nearest line cell to its neighbours.
  const relax = (i: number, j: number) => {
    const n = near[j];
    if (n < 0) return;
    const dx = (i % N) - (n % N);
    const dy = ((i / N) | 0) - ((n / N) | 0);
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < dist[i]) {
      dist[i] = d;
      near[i] = n;
    }
  };
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      if (x > 0) relax(i, i - 1);
      if (y > 0) {
        relax(i, i - N);
        if (x > 0) relax(i, i - N - 1);
        if (x < N - 1) relax(i, i - N + 1);
      }
    }
    for (let x = N - 2; x >= 0; x--) relax(y * N + x, y * N + x + 1);
  }
  for (let y = N - 1; y >= 0; y--) {
    for (let x = N - 1; x >= 0; x--) {
      const i = y * N + x;
      if (x < N - 1) relax(i, i + 1);
      if (y < N - 1) {
        relax(i, i + N);
        if (x < N - 1) relax(i, i + N + 1);
        if (x > 0) relax(i, i + N - 1);
      }
    }
    for (let x = 1; x < N; x++) relax(y * N + x, y * N + x - 1);
  }
  return { dist, near };
}

const cellOf = (p: Pt) => {
  const x = Math.floor(p.x / CELL);
  const y = Math.floor(p.y / CELL);
  return x < 0 || y < 0 || x >= N || y >= N ? -1 : y * N + x;
};

/** Distance (design units) from a point to the nearest line, capped. */
function distanceAt(near: Nearest, p: Pt, cap: number): number {
  const i = cellOf(p);
  return i < 0 ? cap : Math.min(cap, near.dist[i] * CELL);
}

/** Average distance (design units) from the mapped source lines to the template's lines. */
export function misalignment(near: Nearest, points: Pt[], map: (p: Pt) => Pt, cap = 40): number {
  if (!points.length) return NaN;
  let s = 0;
  for (const p of points) s += distanceAt(near, map(p), cap);
  return s / points.length;
}

/**
 * Iterative closest point: moves the whole map (reflection included) so the
 * mapped points land on the nearest template lines. Similarity first, then a
 * full affine for pieces that are stretched or skewed (kept only if it helps
 * and doesn't squash the piece).
 */
function icp(near: Nearest, pts: Pt[], start: Affine): { M: Affine; score: number } {
  let M = start;
  const step = (similarity: boolean, radius: number): boolean => {
    const src: Pt[] = [];
    const dst: Pt[] = [];
    for (const p of pts) {
      const i = cellOf(apply(M, p));
      if (i < 0 || near.near[i] < 0 || near.dist[i] * CELL > radius) continue;
      const n = near.near[i];
      src.push(p);
      dst.push({ x: ((n % N) + 0.5) * CELL, y: (((n / N) | 0) + 0.5) * CELL });
    }
    if (src.length < Math.max(12, pts.length * 0.2)) return false;
    const next = similarity ? fitSimilarityReflected(src, dst, M) : fitAffine(src, dst);
    if (!next) return false;
    M = next;
    return true;
  };
  for (let it = 0; it < 30; it++) if (!step(true, Math.max(6, 40 - it * 2))) break;
  const sim = M;
  const simScore = misalignment(near, pts, (p) => apply(sim, p));
  for (let it = 0; it < 15; it++) if (!step(false, 6)) break;
  const affScore = misalignment(near, pts, (p) => apply(M, p));
  const det = (a: Affine) => a[0] * a[3] - a[1] * a[2];
  if (!(affScore < simScore - 0.05) || Math.abs(det(M) / det(sim) - 1) > 0.25 || Math.sign(det(M)) !== Math.sign(det(sim))) return { M: sim, score: simScore };
  return { M, score: affScore };
}

/** Coarse coverage: which 16-unit cells have any template line (a dense wireframe makes each piece a solid shape). */
const C = 128;
const CS = DESIGN_SIZE / C;
const covers = new WeakMap<LineMap, Uint8Array>();
function coverage(lines: LineMap): Uint8Array {
  let cover = covers.get(lines);
  if (cover) return cover;
  cover = new Uint8Array(C * C);
  const k = N / C;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (lines.mask[y * N + x] >= 0.35) cover[((y / k) | 0) * C + ((x / k) | 0)] = 1;
  covers.set(lines, cover);
  return cover;
}

/**
 * Finds the mirror line for a piece. First by shape: horizontal and vertical
 * reflections (with a small slide along the line) are scored by how well the
 * piece's mirrored shape overlaps the template's pieces. The best few are
 * then lined up with the template's lines, and the closest fit wins.
 */
export function findLine(lines: LineMap, area: Pt[]): { line: [Pt, Pt]; fit: Affine; score: number } | undefined {
  const pts = linePoints(lines, area, 900);
  if (pts.length < 20) return undefined;
  const cover = coverage(lines);
  const box = polygonBox(area);
  // The piece's cells (centres inside the area), at most ~1500.
  let cells: Pt[] = [];
  for (let y = Math.max(0, Math.floor(box.y / CS)); y <= Math.min(C - 1, Math.floor((box.y + box.h) / CS)); y++)
    for (let x = Math.max(0, Math.floor(box.x / CS)); x <= Math.min(C - 1, Math.floor((box.x + box.w) / CS)); x++) {
      const p = { x: (x + 0.5) * CS, y: (y + 0.5) * CS };
      if (inPolygon(area, p.x, p.y)) cells.push(p);
    }
  if (cells.length > 1500) {
    const step = cells.length / 1500;
    cells = Array.from({ length: 1500 }, (_, i) => cells[Math.floor(i * step)]);
  }
  const covered = (p: Pt) => {
    const x = Math.floor(p.x / CS);
    const y = Math.floor(p.y / CS);
    return x >= 0 && y >= 0 && x < C && y < C && cover[y * C + x] === 1;
  };
  const near = nearestLines(lines);
  const candidates: { vertical: boolean; t: number; s: number; iou: number; raw: number }[] = [];
  for (const vertical of [false, true]) {
    for (let t = 8; t < DESIGN_SIZE - 8; t += 8) {
      // Line distance of the plain reflection.
      const R = reflection(vertical ? { x: t, y: 0 } : { x: 0, y: t }, vertical ? { x: t, y: DESIGN_SIZE } : { x: DESIGN_SIZE, y: t });
      const used = pts.filter((p) => Math.abs((vertical ? p.x : p.y) - t) > 24);
      const raw = used.length > pts.length * 0.5 ? misalignment(near, used, (p) => apply(R, p)) : Infinity;
      // Shape overlap, sliding a little along the line.
      let iou = 0;
      let bestS = 0;
      for (let s = -96; s <= 96; s += 8) {
        let inter = 0;
        let union = 0;
        for (const p of cells) {
          // Cells right next to the line always match themselves.
          if (Math.abs((vertical ? p.x : p.y) - t) < 24) continue;
          const q = vertical ? { x: 2 * t - p.x, y: p.y + s } : { x: p.x + s, y: 2 * t - p.y };
          const a = covered(p);
          const b = covered(q);
          if (a && b) inter++;
          if (a || b) union++;
        }
        const v = union > 20 ? inter / union : 0;
        if (v > iou) ((iou = v), (bestS = s));
      }
      candidates.push({ vertical, t, s: bestS, iou, raw });
    }
  }
  // The most promising few by each measure, one per stretch of the canvas.
  const pick = (sorted: typeof candidates, count: number, into: typeof candidates) => {
    let n = 0;
    for (const c of sorted) {
      if (n >= count) break;
      if (!Number.isFinite(c.raw) && !c.iou) continue;
      if (into.some((p) => p.vertical === c.vertical && Math.abs(p.t - c.t) < 40)) continue;
      into.push(c);
      n++;
    }
  };
  const picked: typeof candidates = [];
  pick([...candidates].sort((a, b) => b.iou - a.iou), 4, picked);
  pick([...candidates].sort((a, b) => a.raw - b.raw), 3, picked);
  let best: { line: [Pt, Pt]; fit: Affine; score: number } | undefined;
  for (const c of picked) {
    const line: [Pt, Pt] = c.vertical ? [{ x: c.t, y: 0 }, { x: c.t, y: DESIGN_SIZE }] : [{ x: 0, y: c.t }, { x: DESIGN_SIZE, y: c.t }];
    const R = reflection(line[0], line[1]);
    const used = pts.filter((p) => Math.abs((c.vertical ? p.x : p.y) - c.t) > 24);
    for (const s of new Set([c.s, 0])) {
      const slide: Affine = c.vertical ? [1, 0, 0, 1, 0, s] : [1, 0, 0, 1, s, 0];
      const { M, score } = icp(near, used, compose(slide, R));
      if (!best || score < best.score) best = { line, fit: compose(M, R), score };
    }
  }
  return best;
}

/** Refines a mirror so its source lines sit on the template's lines on the other side. Returns the new `fit`. */
export function autoFit(lines: LineMap, m: Mirror): { fit: Affine; before: number; after: number } | undefined {
  const pts = linePoints(lines, m.area, 1500);
  if (pts.length < 20) return undefined;
  const near = nearestLines(lines, m.area);
  const R = reflection(m.line[0], m.line[1]);
  const before = misalignment(near, pts, mirrorMapping(m).map);
  const { M, score } = icp(near, pts, compose(m.fit ?? [1, 0, 0, 1, 0, 0], R));
  // fit ∘ R = M, and R is its own inverse.
  return { fit: compose(M, R), before, after: score };
}

/** A similarity that keeps the mirror's handedness: fit on the reflected points, then reflect. */
function fitSimilarityReflected(src: Pt[], dst: Pt[], current: Affine): Affine | undefined {
  const flip = current[0] * current[3] - current[1] * current[2] < 0;
  const F: Affine = flip ? [1, 0, 0, -1, 0, 0] : [1, 0, 0, 1, 0, 0];
  const s = fitSimilarity(src.map((p) => apply(F, p)), dst);
  return s && compose(s, F);
}

/**
 * Sets up a new mirror for a drawn box: finds the matching piece (with a
 * template), and when the piece is its own mirror image (a bumper), keeps
 * only the half where the box was started.
 */
export function placeMirror(lines: LineMap | undefined, m: Mirror, start: Pt): { mirror: Mirror; score?: number } {
  let next = { ...m };
  if (lines) {
    const found = findLine(lines, m.area);
    if (found) next = { ...next, line: found.line, fit: found.fit };
  }
  if (lineCrosses(next.area, next.line[0], next.line[1])) {
    const side = sideOf(next.line[0], next.line[1], start) || 1;
    next = { ...next, area: clipToSide(next.area, next.line[0], next.line[1], side) };
  }
  if (!lines) return { mirror: next };
  const fitted = autoFit(lines, next);
  if (fitted && fitted.after <= fitted.before) next = { ...next, fit: fitted.fit };
  return { mirror: next, score: fitted ? Math.min(fitted.after, fitted.before) : undefined };
}
