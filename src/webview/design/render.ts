import type { Design, ImageLayer, Layer, Paint, PathPoint, TextLayer } from './model';

/*
 * Drawing designs with Canvas 2D. Each layer is drawn in its own frame
 * (centred on its x/y, rotated, scaled); paints are laid out over the layer's
 * local box so gradients and patterns follow the shape.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Decoded images by asset id (filled in by the designer as assets load). */
export type AssetImages = Map<string, CanvasImageSource & { width: number; height: number }>;

const scratch = document.createElement('canvas').getContext('2d')!;

export function fontString(t: TextLayer): string {
  const family = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/.test(t.font) ? t.font : `"${t.font.replace(/"/g, '')}", sans-serif`;
  return `${t.italic ? 'italic ' : ''}${t.weight} ${t.size}px ${family}`;
}

interface TextLayout {
  lines: { text: string; width: number; chars: { ch: string; w: number }[] }[];
  box: Box;
  /** Arc radius (0: straight), direction (1: bends up), and how far the ends drop. */
  radius: number;
  sign: number;
  sag: number;
  /** Letters placed along a path: position and angle of each, per line. */
  along?: { x: number; y: number; angle: number; ch: string }[][];
}

/** A path as a polyline (curves sampled), with the distance along it at each point. */
export function samplePath(points: PathPoint[], closed: boolean): { pts: [number, number][]; dist: number[] } {
  const pts: [number, number][] = [];
  if (!points.length) return { pts, dist: [] };
  pts.push([points[0].x, points[0].y]);
  const seg = (a: PathPoint, b: PathPoint) => {
    if (!a.out && !b.in) return void pts.push([b.x, b.y]);
    const c1 = [a.x + (a.out?.x ?? 0), a.y + (a.out?.y ?? 0)];
    const c2 = [b.x + (b.in?.x ?? 0), b.y + (b.in?.y ?? 0)];
    for (let k = 1; k <= 32; k++) {
      const t = k / 32;
      const u = 1 - t;
      pts.push([
        u * u * u * a.x + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * b.x,
        u * u * u * a.y + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * b.y,
      ]);
    }
  };
  for (let i = 1; i < points.length; i++) seg(points[i - 1], points[i]);
  if (closed && points.length > 2) seg(points[points.length - 1], points[0]);
  const dist = [0];
  for (let i = 1; i < pts.length; i++) dist.push(dist[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, dist };
}

/** The point and direction at distance `s` along a sampled path (extended straight past its ends). */
function pointAlong(path: { pts: [number, number][]; dist: number[] }, s: number, closed: boolean): { x: number; y: number; angle: number } {
  const { pts, dist } = path;
  const total = dist[dist.length - 1] || 1;
  if (closed) s = ((s % total) + total) % total;
  let i = 1;
  while (i < dist.length - 1 && dist[i] < s) i++;
  const a = pts[i - 1];
  const b = pts[i];
  const len = dist[i] - dist[i - 1] || 1;
  const t = (s - dist[i - 1]) / len;
  return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, angle: Math.atan2(b[1] - a[1], b[0] - a[0]) };
}

const layouts = new WeakMap<TextLayer, { key: string; layout: TextLayout }>();

export function layoutText(t: TextLayer): TextLayout {
  const key = JSON.stringify([t.text, t.font, t.size, t.weight, t.italic, t.spacing, t.lineHeight, t.align, t.arc, t.path, t.pathStart, t.pathFlip]);
  const cached = layouts.get(t);
  if (cached && cached.key === key) return cached.layout;
  scratch.font = fontString(t);
  scratch.letterSpacing = '0px';
  const lines = t.text.split('\n').map((text) => {
    const chars = [...text].map((ch) => ({ ch, w: scratch.measureText(ch).width + t.spacing }));
    // Whole-line width keeps kerning for straight text.
    scratch.letterSpacing = `${t.spacing}px`;
    const width = text ? scratch.measureText(text).width : 0;
    scratch.letterSpacing = '0px';
    return { text, width, chars };
  });
  const lineH = t.size * t.lineHeight;
  const maxW = Math.max(1, ...lines.map((l) => l.width));
  let box: Box = { x: -maxW / 2, y: (-lineH * lines.length) / 2, w: maxW, h: lineH * lines.length };
  let radius = 0;
  let sag = 0;
  const sign = Math.sign(t.arc) || 1;
  if (t.arc) {
    const a = (Math.min(360, Math.abs(t.arc)) * Math.PI) / 180;
    radius = maxW / a;
    sag = radius * (1 - Math.cos(Math.min(a, Math.PI) / 2));
    const outer = radius + (lineH * lines.length) / 2;
    const chord = a >= Math.PI ? 2 * outer : 2 * outer * Math.sin(a / 2);
    box = { x: -chord / 2, y: (-lineH * lines.length) / 2 - sag / 2, w: chord, h: lineH * lines.length + sag };
  }
  let along: TextLayout['along'];
  if (t.path && t.path.length > 1) {
    // Along a path: each letter at its distance along it, turned to follow it; extra lines sit below.
    const pts = t.pathFlip ? [...t.path].reverse().map((p) => ({ x: p.x, y: p.y, in: p.out, out: p.in })) : t.path;
    const closed = false;
    const sampled = samplePath(pts, closed);
    const total = sampled.dist[sampled.dist.length - 1] || 1;
    const anchor = (t.pathStart ?? 0.5) * total;
    along = lines.map((line, i) => {
      const off = (i - (lines.length - 1) / 2) * lineH;
      const width = line.chars.reduce((n, c) => n + c.w, 0);
      let s = t.align === 'left' ? anchor : t.align === 'right' ? anchor - width : anchor - width / 2;
      return line.chars.map((c) => {
        const at = pointAlong(sampled, s + c.w / 2, closed);
        s += c.w;
        return { x: at.x - Math.sin(at.angle) * off, y: at.y + Math.cos(at.angle) * off, angle: at.angle, ch: c.ch };
      });
    });
    const xs = along.flat().map((c) => c.x);
    const ys = along.flat().map((c) => c.y);
    const r = t.size * 0.6;
    if (xs.length) box = { x: Math.min(...xs) - r, y: Math.min(...ys) - r, w: Math.max(...xs) - Math.min(...xs) + r * 2, h: Math.max(...ys) - Math.min(...ys) + r * 2 };
  }
  const layout = { lines, box, radius, sign, sag, along };
  layouts.set(t, { key, layout });
  return layout;
}

/** The layer's box in its own (centred, unrotated, unscaled) frame. */
export function localBox(l: Layer): Box {
  switch (l.type) {
    case 'rect':
    case 'ellipse':
    case 'polygon':
    case 'image':
      return { x: -l.w / 2, y: -l.h / 2, w: l.w, h: l.h };
    case 'text':
      return layoutText(l).box;
    case 'path':
    case 'brush': {
      const pts: [number, number][] = l.type === 'brush' ? l.points : l.points.flatMap((p) => [[p.x, p.y], ...(p.in ? [[p.x + p.in.x, p.y + p.in.y]] : []), ...(p.out ? [[p.x + p.out.x, p.y + p.out.y]] : [])] as [number, number][]);
      if (!pts.length) return { x: 0, y: 0, w: 0, h: 0 };
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const pad = l.type === 'brush' ? (l.stroke?.width ?? 0) / 2 : 0;
      const x0 = Math.min(...xs) - pad;
      const y0 = Math.min(...ys) - pad;
      return { x: x0, y: y0, w: Math.max(...xs) + pad - x0, h: Math.max(...ys) + pad - y0 };
    }
  }
}

/** The layer's frame as a matrix (local → design). */
export function layerMatrix(l: Layer): DOMMatrix {
  return new DOMMatrix().translateSelf(l.x, l.y).rotateSelf(l.rotation).scaleSelf(l.sx, l.sy);
}

/** Corners of the layer's box in design units (for handles, snapping). */
export function layerCorners(l: Layer): DOMPoint[] {
  const b = localBox(l);
  const m = layerMatrix(l);
  return [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x + b.w, b.y + b.h],
    [b.x, b.y + b.h],
  ].map(([x, y]) => m.transformPoint(new DOMPoint(x, y)));
}

/** Axis-aligned bounds in design units. */
export function layerBounds(l: Layer): Box {
  const c = layerCorners(l);
  const xs = c.map((p) => p.x);
  const ys = c.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export function shapePath(l: Layer): Path2D | undefined {
  const p = new Path2D();
  switch (l.type) {
    case 'rect':
      p.roundRect(-l.w / 2, -l.h / 2, l.w, l.h, Math.max(0, Math.min(l.radius, l.w / 2, l.h / 2)));
      return p;
    case 'ellipse':
      p.ellipse(0, 0, Math.abs(l.w) / 2, Math.abs(l.h) / 2, 0, 0, Math.PI * 2);
      return p;
    case 'polygon': {
      const n = Math.max(3, Math.round(l.sides));
      const count = l.star ? n * 2 : n;
      for (let i = 0; i < count; i++) {
        const a = -Math.PI / 2 + (i * Math.PI * 2) / count;
        const r = l.star && i % 2 ? l.inner : 1;
        const x = (Math.cos(a) * r * l.w) / 2;
        const y = (Math.sin(a) * r * l.h) / 2;
        if (i) p.lineTo(x, y);
        else p.moveTo(x, y);
      }
      p.closePath();
      return p;
    }
    case 'path':
      return bezierPath(l.points, l.closed);
    case 'brush': {
      const pts = l.points;
      if (!pts.length) return undefined;
      p.moveTo(pts[0][0], pts[0][1]);
      if (pts.length === 1) p.lineTo(pts[0][0] + 0.01, pts[0][1]);
      // Smooth through the midpoints.
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2;
        const my = (pts[i][1] + pts[i + 1][1]) / 2;
        p.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
      }
      if (pts.length > 1) p.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
      return p;
    }
    default:
      return undefined;
  }
}

export function bezierPath(points: PathPoint[], closed: boolean): Path2D {
  const p = new Path2D();
  if (!points.length) return p;
  p.moveTo(points[0].x, points[0].y);
  const seg = (a: PathPoint, b: PathPoint) => {
    if (!a.out && !b.in) p.lineTo(b.x, b.y);
    else p.bezierCurveTo(a.x + (a.out?.x ?? 0), a.y + (a.out?.y ?? 0), b.x + (b.in?.x ?? 0), b.y + (b.in?.y ?? 0), b.x, b.y);
  };
  for (let i = 1; i < points.length; i++) seg(points[i - 1], points[i]);
  if (closed && points.length > 2) {
    seg(points[points.length - 1], points[0]);
    p.closePath();
  }
  return p;
}

function patternFor(a: string, b: string, size: number, kind: 'checker' | 'stripes', angle: number, ctx: CanvasRenderingContext2D): CanvasPattern | string {
  // The tile is drawn at a fixed resolution and scaled into place, so it stays crisp at any export size.
  const res = 64;
  const c = document.createElement('canvas');
  c.width = c.height = res * 2;
  const g = c.getContext('2d')!;
  g.fillStyle = a;
  g.fillRect(0, 0, res * 2, res * 2);
  g.fillStyle = b;
  if (kind === 'checker') {
    g.fillRect(res, 0, res, res);
    g.fillRect(0, res, res, res);
  } else g.fillRect(res, 0, res, res * 2);
  const pattern = ctx.createPattern(c, 'repeat');
  if (!pattern) return a;
  const scale = Math.max(0.01, size) / res;
  pattern.setTransform(new DOMMatrix().rotateSelf(angle).scaleSelf(scale, scale));
  return pattern;
}

export function paintStyle(ctx: CanvasRenderingContext2D, paint: Paint, box: Box): string | CanvasGradient | CanvasPattern | undefined {
  switch (paint.kind) {
    case 'none':
      return undefined;
    case 'solid':
      return paint.colour;
    case 'linear': {
      const a = (paint.angle * Math.PI) / 180;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      const len = Math.abs(box.w * dx) + Math.abs(box.h * dy);
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      const g = ctx.createLinearGradient(cx - (dx * len) / 2, cy - (dy * len) / 2, cx + (dx * len) / 2, cy + (dy * len) / 2);
      paint.stops.forEach((s) => g.addColorStop(Math.min(1, Math.max(0, s.at)), s.colour));
      return g;
    }
    case 'radial': {
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(box.w, box.h) / 2);
      paint.stops.forEach((s) => g.addColorStop(Math.min(1, Math.max(0, s.at)), s.colour));
      return g;
    }
    case 'checker':
      return patternFor(paint.a, paint.b, paint.cell, 'checker', paint.angle, ctx);
    case 'stripes':
      return patternFor(paint.a, paint.b, paint.width, 'stripes', paint.angle, ctx);
  }
}

function applyStroke(ctx: CanvasRenderingContext2D, l: Layer, box: Box): boolean {
  const s = l.stroke;
  if (!s || s.width <= 0) return false;
  const style = paintStyle(ctx, s.paint, box);
  if (!style) return false;
  ctx.strokeStyle = style;
  ctx.lineWidth = s.width;
  ctx.lineJoin = s.join;
  ctx.lineCap = s.cap;
  ctx.setLineDash(s.dash > 0 ? [s.dash, s.dash] : []);
  return true;
}

function drawText(ctx: CanvasRenderingContext2D, t: TextLayer): void {
  const layout = layoutText(t);
  const box = layout.box;
  const fill = paintStyle(ctx, t.fill, box);
  const outline = applyStroke(ctx, t, box);
  ctx.font = fontString(t);
  ctx.textBaseline = 'middle';
  const lineH = t.size * t.lineHeight;
  const behind = !!t.stroke?.behind;
  const paintText = (draw: (mode: 'fill' | 'stroke') => void) => {
    if (outline && behind) draw('stroke');
    if (fill) {
      ctx.fillStyle = fill;
      draw('fill');
      // Only the first drawing casts the shadow.
      ctx.shadowColor = 'transparent';
    }
    if (outline && !behind) draw('stroke');
  };
  const maxW = Math.max(1, ...layout.lines.map((l) => l.width));
  if (layout.along) {
    ctx.textAlign = 'center';
    const along = layout.along;
    paintText((mode) => {
      for (const line of along)
        for (const c of line) {
          ctx.save();
          ctx.translate(c.x, c.y);
          ctx.rotate(c.angle);
          if (mode === 'fill') ctx.fillText(c.ch, 0, 0);
          else ctx.strokeText(c.ch, 0, 0);
          ctx.restore();
        }
    });
    return;
  }
  layout.lines.forEach((line, i) => {
    const yMid = -((layout.lines.length - 1) * lineH) / 2 + i * lineH;
    if (!layout.radius) {
      ctx.letterSpacing = `${t.spacing}px`;
      ctx.textAlign = 'left';
      const x = t.align === 'left' ? -maxW / 2 : t.align === 'right' ? maxW / 2 - line.width : -line.width / 2;
      paintText((mode) => (mode === 'fill' ? ctx.fillText(line.text, x, yMid) : ctx.strokeText(line.text, x, yMid)));
      ctx.letterSpacing = '0px';
      return;
    }
    // Along an arc: each letter placed and turned on a circle. Lines on the outside of the bend get a bigger circle.
    const sign = layout.sign;
    const R = layout.radius;
    const r = Math.max(1, R - sign * yMid);
    const total = line.chars.reduce((n, c) => n + c.w, 0);
    ctx.textAlign = 'center';
    paintText((mode) => {
      let along = -total / 2;
      for (const c of line.chars) {
        const theta = (along + c.w / 2) / r;
        along += c.w;
        ctx.save();
        ctx.translate(r * Math.sin(theta), sign * (R - r * Math.cos(theta)) - (sign * layout.sag) / 2);
        ctx.rotate(sign * theta);
        if (mode === 'fill') ctx.fillText(c.ch, 0, 0);
        else ctx.strokeText(c.ch, 0, 0);
        ctx.restore();
      }
    });
  });
}

/** Draws one layer in design units (the context already maps design units to pixels). */
export function drawLayer(ctx: CanvasRenderingContext2D, l: Layer, images: AssetImages): void {
  if (!l.visible || l.opacity <= 0) return;
  ctx.save();
  ctx.globalAlpha *= l.opacity;
  ctx.globalCompositeOperation = l.blend;
  const m = layerMatrix(l);
  ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
  if (l.shadow && (l.shadow.blur > 0 || l.shadow.dx || l.shadow.dy)) {
    // Shadow offsets ignore the transform, so scale them by the current pixel scale.
    const t = ctx.getTransform();
    const px = Math.hypot(t.a, t.b);
    ctx.shadowColor = l.shadow.colour;
    ctx.shadowBlur = l.shadow.blur * px;
    ctx.shadowOffsetX = l.shadow.dx * px;
    ctx.shadowOffsetY = l.shadow.dy * px;
  }
  const box = localBox(l);
  if (l.type === 'text') drawText(ctx, l);
  else if (l.type === 'image') {
    const img = images.get(l.asset);
    if (img) ctx.drawImage(img, -l.w / 2, -l.h / 2, l.w, l.h);
  } else {
    const path = shapePath(l);
    if (path) {
      const fill = l.type === 'brush' || (l.type === 'path' && !l.closed) ? undefined : paintStyle(ctx, l.fill, box);
      const outline = applyStroke(ctx, l, box);
      if (outline && l.stroke?.behind) ctx.stroke(path);
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill(path);
        ctx.shadowColor = 'transparent';
      }
      if (outline && !l.stroke?.behind) ctx.stroke(path);
    }
  }
  ctx.restore();
}

/** Draws a whole design. `scale`: pixels per design unit. */
export function drawDesign(ctx: CanvasRenderingContext2D, d: Design, images: AssetImages): void {
  d.layers.forEach((l, i) => {
    if (l.clip && i > 0) {
      // Clip to the layer below: done here so the clip is part of this layer's saved state.
      const below = d.layers[i - 1];
      const mask = shapePath(below);
      ctx.save();
      if (mask) {
        const m = layerMatrix(below);
        const t = ctx.getTransform();
        ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
        ctx.clip(mask);
        ctx.setTransform(t);
      }
      drawLayer(ctx, l, images);
      ctx.restore();
    } else drawLayer(ctx, l, images);
  });
}

/** The design as pixels at `size`×`size`. */
export function rasterize(d: Design, images: AssetImages, size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.scale(size / 2048, size / 2048);
  drawDesign(ctx, d, images);
  return c;
}

/** Whether design point (x, y) is on the layer. */
export function hitLayer(l: Layer, x: number, y: number, tolerance: number): boolean {
  const local = layerMatrix(l).inverse().transformPoint(new DOMPoint(x, y));
  const scale = Math.max(1e-6, Math.min(Math.abs(l.sx), Math.abs(l.sy)));
  const tol = tolerance / scale;
  if (l.type === 'text' || l.type === 'image') {
    const b = localBox(l);
    return local.x >= b.x - tol && local.x <= b.x + b.w + tol && local.y >= b.y - tol && local.y <= b.y + b.h + tol;
  }
  const path = shapePath(l);
  if (!path) return false;
  scratch.setTransform(1, 0, 0, 1, 0, 0);
  const filled = !(l.type === 'brush' || (l.type === 'path' && !l.closed)) && l.fill.kind !== 'none';
  if (filled && scratch.isPointInPath(path, local.x, local.y)) return true;
  scratch.lineWidth = (l.stroke?.width ?? 0) + tol * 2;
  scratch.lineJoin = 'round';
  return scratch.isPointInStroke(path, local.x, local.y);
}

export function isImage(l: Layer): l is ImageLayer {
  return l.type === 'image';
}
