import type { Pt } from './model';

/*
 * Draws an image through a non-linear mapping (a mirror with 4+ pins): the
 * source rectangle is cut into a grid of triangles, each moved to where the
 * mapping puts its corners. WebGL when available; otherwise Canvas 2D, one
 * clipped affine draw per triangle.
 */

interface Gl {
  gl: WebGLRenderingContext;
  canvas: HTMLCanvasElement;
  pos: WebGLBuffer;
  uv: WebGLBuffer;
  index: WebGLBuffer;
  tex: WebGLTexture;
  aPos: number;
  aUv: number;
}

let shared: Gl | null | undefined;

function setup(): Gl | null {
  if (shared !== undefined) return shared;
  shared = null;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: true });
    if (!gl) return null;
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, 'attribute vec2 p; attribute vec2 t; varying vec2 v; void main(){ v = t; gl_Position = vec4(p, 0.0, 1.0); }'));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, 'precision mediump float; varying vec2 v; uniform sampler2D s; void main(){ gl_FragColor = texture2D(s, v); }'));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    shared = {
      gl,
      canvas,
      pos: gl.createBuffer()!,
      uv: gl.createBuffer()!,
      index: gl.createBuffer()!,
      tex,
      aPos: gl.getAttribLocation(prog, 'p'),
      aUv: gl.getAttribLocation(prog, 't'),
    };
  } catch {
    shared = null;
  }
  return shared;
}

/**
 * Draws `src` (which shows design rectangle `box`) onto `ctx` through `map`
 * (design → design). The context's current transform maps design units to
 * its pixels; its clip applies.
 */
export function warpImage(ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, box: { x: number; y: number; w: number; h: number }, map: (p: Pt) => Pt, grid = 32): void {
  if (box.w <= 0 || box.h <= 0) return;
  const T = ctx.getTransform();
  const n = grid + 1;
  const dev = new Float32Array(n * n * 2);
  const uv = new Float32Array(n * n * 2);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = i / grid;
      const v = j / grid;
      const d = map({ x: box.x + box.w * u, y: box.y + box.h * v });
      const px = T.a * d.x + T.c * d.y + T.e;
      const py = T.b * d.x + T.d * d.y + T.f;
      const k = (j * n + i) * 2;
      dev[k] = px;
      dev[k + 1] = py;
      uv[k] = u;
      uv[k + 1] = v;
      x0 = Math.min(x0, px);
      y0 = Math.min(y0, py);
      x1 = Math.max(x1, px);
      y1 = Math.max(y1, py);
    }
  }
  // Only the part that lands on the target canvas.
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(ctx.canvas.width, Math.ceil(x1));
  y1 = Math.min(ctx.canvas.height, Math.ceil(y1));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0 || !Number.isFinite(w + h)) return;
  const indices: number[] = [];
  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) {
      const a = j * n + i;
      indices.push(a, a + 1, a + n, a + 1, a + n + 1, a + n);
    }
  }
  const g = w <= 8192 && h <= 8192 ? setup() : null;
  if (g) {
    const { gl } = g;
    if (g.canvas.width !== w || g.canvas.height !== h) {
      g.canvas.width = w;
      g.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const clip = new Float32Array(dev.length);
    for (let k = 0; k < dev.length; k += 2) {
      clip[k] = ((dev[k] - x0) / w) * 2 - 1;
      clip[k + 1] = 1 - ((dev[k + 1] - y0) / h) * 2;
    }
    gl.bindTexture(gl.TEXTURE_2D, g.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.bindBuffer(gl.ARRAY_BUFFER, g.pos);
    gl.bufferData(gl.ARRAY_BUFFER, clip, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(g.aPos);
    gl.vertexAttribPointer(g.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, g.uv);
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(g.aUv);
    gl.vertexAttribPointer(g.aUv, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.index);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STREAM_DRAW);
    gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(g.canvas, 0, 0, w, h, x0, y0, w, h);
    ctx.restore();
    return;
  }
  // Canvas 2D: each triangle as an affine draw, clipped to the triangle (grown a little to hide seams).
  const sw = src.width;
  const sh = src.height;
  ctx.save();
  for (let t = 0; t < indices.length; t += 3) {
    const [i0, i1, i2] = [indices[t], indices[t + 1], indices[t + 2]];
    const P = [i0, i1, i2].map((i) => ({ x: dev[i * 2], y: dev[i * 2 + 1] }));
    const S = [i0, i1, i2].map((i) => ({ x: uv[i * 2] * sw, y: uv[i * 2 + 1] * sh }));
    const cx = (P[0].x + P[1].x + P[2].x) / 3;
    const cy = (P[0].y + P[1].y + P[2].y) / 3;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    P.forEach((p, i) => {
      const dx = p.x - cx;
      const dy = p.y - cy;
      const l = Math.hypot(dx, dy) || 1;
      const q = { x: p.x + (dx / l) * 0.7, y: p.y + (dy / l) * 0.7 };
      if (i) ctx.lineTo(q.x, q.y);
      else ctx.moveTo(q.x, q.y);
    });
    ctx.closePath();
    ctx.clip();
    // Affine taking the source triangle to the destination one.
    const [s0, s1, s2] = S;
    const [d0, d1, d2] = P;
    const den = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y);
    if (Math.abs(den) > 1e-9) {
      const a = ((d1.x - d0.x) * (s2.y - s0.y) - (d2.x - d0.x) * (s1.y - s0.y)) / den;
      const b = ((d1.y - d0.y) * (s2.y - s0.y) - (d2.y - d0.y) * (s1.y - s0.y)) / den;
      const c = ((d2.x - d0.x) * (s1.x - s0.x) - (d1.x - d0.x) * (s2.x - s0.x)) / den;
      const d = ((d2.y - d0.y) * (s1.x - s0.x) - (d1.y - d0.y) * (s2.x - s0.x)) / den;
      ctx.setTransform(a, b, c, d, d0.x - a * s0.x - c * s0.y, d0.y - b * s0.x - d * s0.y);
      ctx.drawImage(src, 0, 0);
    }
    ctx.restore();
  }
  ctx.restore();
}
