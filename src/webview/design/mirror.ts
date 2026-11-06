import { DESIGN_SIZE, Mirror, MirrorPin, Pt } from './model';

/*
 * Mirror maths. A mirror maps the source piece onto its matching piece:
 * a reflection across the mirror line, then the auto-fit correction (an
 * affine), then the pins' correction: 1 pin moves it, 2 also rotate and
 * scale it, 3 also stretch and skew it, 4 or more bend it like a rubber
 * sheet (a thin-plate spline through the pins).
 */

/** 2D affine as [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f (DOMMatrix order). */
export type Affine = [number, number, number, number, number, number];

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

export function apply(m: Affine | number[], p: Pt): Pt {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

/** a ∘ b: b first, then a. */
export function compose(a: Affine | number[], b: Affine | number[]): Affine {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function invert(m: Affine | number[]): Affine {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

/** Reflection across the line through p1 and p2. */
export function reflection(p1: Pt, p2: Pt): Affine {
  let ux = p2.x - p1.x;
  let uy = p2.y - p1.y;
  const len = Math.hypot(ux, uy) || 1;
  ux /= len;
  uy /= len;
  const a = 2 * ux * ux - 1;
  const b = 2 * ux * uy;
  const d = 2 * uy * uy - 1;
  // p' = p1 + R(p − p1)
  return [a, b, b, d, p1.x - (a * p1.x + b * p1.y), p1.y - (b * p1.x + d * p1.y)];
}

/** Reflection then auto-fit: the mirror without its pins. */
export function baseAffine(m: Mirror): Affine {
  return compose(m.fit ?? IDENTITY, reflection(m.line[0], m.line[1]));
}

export interface Mapping {
  /** Set when the whole mapping is affine (drawn as vectors); otherwise it's a warp. */
  affine?: Affine;
  map(p: Pt): Pt;
  /** The mapping's best affine approximation around `p`. */
  local(p: Pt): Affine;
}

function affineMapping(a: Affine): Mapping {
  return { affine: a, map: (p) => apply(a, p), local: () => a };
}

/** Solves A·x = b in place (Gaussian elimination with partial pivoting); undefined when singular. */
function solve(A: number[][], b: number[]): number[] | undefined {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) return undefined;
    [A[col], A[piv]] = [A[piv], A[col]];
    [b[col], b[piv]] = [b[piv], b[col]];
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / A[col][col];
      if (!f) continue;
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= A[r][c] * x[c];
    x[r] = s / A[r][r];
  }
  return x;
}

/** Least-squares affine taking `src` to `dst` (needs 3+ points not on one line). */
export function fitAffine(src: Pt[], dst: Pt[], weights?: number[]): Affine | undefined {
  if (src.length < 3) return undefined;
  const M = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const bx = [0, 0, 0];
  const by = [0, 0, 0];
  src.forEach((p, i) => {
    const w = weights?.[i] ?? 1;
    const row = [p.x, p.y, 1];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) M[r][c] += w * row[r] * row[c];
      bx[r] += w * row[r] * dst[i].x;
      by[r] += w * row[r] * dst[i].y;
    }
  });
  const sx = solve(M.map((r) => [...r]), bx);
  const sy = solve(M.map((r) => [...r]), by);
  if (!sx || !sy) return undefined;
  return [sx[0], sy[0], sx[1], sy[1], sx[2], sy[2]];
}

/** Least-squares similarity (move, rotate, uniform scale) taking `src` to `dst`. */
export function fitSimilarity(src: Pt[], dst: Pt[], weights?: number[]): Affine | undefined {
  let W = 0;
  let sx = 0, sy = 0, dx = 0, dy = 0;
  src.forEach((p, i) => {
    const w = weights?.[i] ?? 1;
    W += w;
    sx += w * p.x;
    sy += w * p.y;
    dx += w * dst[i].x;
    dy += w * dst[i].y;
  });
  if (!W) return undefined;
  sx /= W;
  sy /= W;
  dx /= W;
  dy /= W;
  let num1 = 0, num2 = 0, den = 0;
  src.forEach((p, i) => {
    const w = weights?.[i] ?? 1;
    const ax = p.x - sx;
    const ay = p.y - sy;
    const bx = dst[i].x - dx;
    const by = dst[i].y - dy;
    num1 += w * (ax * bx + ay * by);
    num2 += w * (ax * by - ay * bx);
    den += w * (ax * ax + ay * ay);
  });
  if (den < 1e-9) return [1, 0, 0, 1, dx - sx, dy - sy];
  const ar = num1 / den;
  const ai = num2 / den;
  return [ar, ai, -ai, ar, dx - (ar * sx - ai * sy), dy - (ai * sx + ar * sy)];
}

/** Thin-plate spline through the points (coordinates normalised to the design size for conditioning). */
function thinPlate(src: Pt[], dst: Pt[]): ((p: Pt) => Pt) | undefined {
  const n = src.length;
  const k = 1 / DESIGN_SIZE;
  const s = src.map((p) => ({ x: p.x * k, y: p.y * k }));
  const U = (r2: number) => (r2 < 1e-20 ? 0 : r2 * Math.log(r2));
  const size = n + 3;
  const build = () => {
    const A = Array.from({ length: size }, () => new Array<number>(size).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) A[i][j] = U((s[i].x - s[j].x) ** 2 + (s[i].y - s[j].y) ** 2);
      A[i][n] = A[n][i] = 1;
      A[i][n + 1] = A[n + 1][i] = s[i].x;
      A[i][n + 2] = A[n + 2][i] = s[i].y;
    }
    return A;
  };
  const rhs = (v: number[]) => [...v, 0, 0, 0];
  const wx = solve(build(), rhs(dst.map((p) => p.x * k)));
  const wy = solve(build(), rhs(dst.map((p) => p.y * k)));
  if (!wx || !wy) return undefined;
  return (p) => {
    const x = p.x * k;
    const y = p.y * k;
    let fx = wx[n] + wx[n + 1] * x + wx[n + 2] * y;
    let fy = wy[n] + wy[n + 1] * x + wy[n + 2] * y;
    for (let i = 0; i < n; i++) {
      const u = U((x - s[i].x) ** 2 + (y - s[i].y) ** 2);
      fx += wx[i] * u;
      fy += wy[i] * u;
    }
    return { x: fx / k, y: fy / k };
  };
}

/** The pins' correction after `base`, as an affine when it is one. */
function pinCorrection(base: Affine, pins: MirrorPin[]): { affine?: Affine; warp?: (p: Pt) => Pt } {
  const src = pins.map((p) => apply(base, p.a));
  const dst = pins.map((p) => p.b);
  if (!pins.length) return { affine: IDENTITY };
  if (pins.length === 1) return { affine: [1, 0, 0, 1, dst[0].x - src[0].x, dst[0].y - src[0].y] };
  if (pins.length === 2) return { affine: fitSimilarity(src, dst) ?? IDENTITY };
  if (pins.length === 3) return { affine: fitAffine(src, dst) ?? fitSimilarity(src, dst) ?? IDENTITY };
  const warp = thinPlate(src, dst);
  return warp ? { warp } : { affine: fitAffine(src, dst) ?? IDENTITY };
}

export function mirrorMapping(m: Mirror): Mapping {
  const base = baseAffine(m);
  const corr = pinCorrection(base, m.pins);
  if (corr.affine) return affineMapping(compose(corr.affine, base));
  const warp = corr.warp!;
  const map = (p: Pt) => warp(apply(base, p));
  return {
    map,
    local: (p) => {
      const h = 2;
      const c = map(p);
      const px = map({ x: p.x + h, y: p.y });
      const nx = map({ x: p.x - h, y: p.y });
      const py = map({ x: p.x, y: p.y + h });
      const ny = map({ x: p.x, y: p.y - h });
      const a = (px.x - nx.x) / (2 * h);
      const b = (px.y - nx.y) / (2 * h);
      const cc = (py.x - ny.x) / (2 * h);
      const d = (py.y - ny.y) / (2 * h);
      return [a, b, cc, d, c.x - (a * p.x + cc * p.y), c.y - (b * p.x + d * p.y)];
    },
  };
}

// -- polygons ----------------------------------------------------------------------------------

export function polygonPath(pts: Pt[]): Path2D {
  const path = new Path2D();
  pts.forEach((p, i) => (i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y)));
  path.closePath();
  return path;
}

export function inPolygon(pts: Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function polygonBox(pts: Pt[]): { x: number; y: number; w: number; h: number } {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Which side of the line p1→p2 a point is on (sign of the cross product). */
export function sideOf(p1: Pt, p2: Pt, p: Pt): number {
  return Math.sign((p2.x - p1.x) * (p.y - p1.y) - (p2.y - p1.y) * (p.x - p1.x));
}

/** The part of a polygon on `side` of the line (Sutherland–Hodgman against one edge). */
export function clipToSide(pts: Pt[], p1: Pt, p2: Pt, side: number): Pt[] {
  const f = (p: Pt) => side * ((p2.x - p1.x) * (p.y - p1.y) - (p2.y - p1.y) * (p.x - p1.x));
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const fa = f(a);
    const fb = f(b);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) {
      const t = fa / (fa - fb);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

/** Whether the line through p1 and p2 crosses the polygon. */
export function lineCrosses(pts: Pt[], p1: Pt, p2: Pt): boolean {
  const sides = new Set(pts.map((p) => sideOf(p1, p2, p)).filter(Boolean));
  return sides.size > 1;
}

/** Points along the polygon's edges mapped through `map` (the mapped outline of a warped piece). */
export function mappedOutline(pts: Pt[], map: (p: Pt) => Pt, perEdge = 16): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    for (let k = 0; k < perEdge; k++) out.push(map({ x: a.x + ((b.x - a.x) * k) / perEdge, y: a.y + ((b.y - a.y) * k) / perEdge }));
  }
  return out;
}

/**
 * Swaps which piece is the source: the area becomes the mapped area, the
 * pins swap ends, and the fit is turned around (the reflection stays).
 */
export function swapMirror(m: Mirror): Mirror {
  const map = mirrorMapping(m).map;
  const R = reflection(m.line[0], m.line[1]);
  const fit = m.fit ? compose(R, compose(invert(m.fit), R)) : undefined;
  return { ...m, area: m.area.map(map), pins: m.pins.map((p) => ({ a: p.b, b: p.a })), ...(fit ? { fit } : {}) };
}
