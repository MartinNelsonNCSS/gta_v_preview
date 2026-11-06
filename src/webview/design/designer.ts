import { h } from '../ui';
import { colourInput } from '../colourPicker';
import { fontPicker, bytesToBase64, familyFromFileName, loadFont, setSystemFonts } from './fonts';
import {
  Blend,
  cloneLayer,
  Colour,
  Design,
  DESIGN_SIZE,
  emptyDesign,
  ImageLayer,
  Layer,
  LayerType,
  makeLayer,
  Mirror,
  MirrorMode,
  mirrorMode,
  newId,
  packDesign,
  Paint,
  PathLayer,
  PathPoint,
  Pt,
  solid,
  Stroke,
  TextLayer,
} from './model';
import { AssetImages, Box, drawDesign, drawThroughMirror, hitLayer, layerBounds, layerCorners, layerMatrix, localBox, rasterize } from './render';
import { inPolygon, mappedOutline, mirrorMapping, polygonBox, swapMirror } from './mirror';
import { autoFit, LineMap, linePoints, lineMap, misalignment, Nearest, nearestLines, placeMirror, tintedTemplate } from './fit';

/*
 * The livery designer: a vector editor for livery textures. Shapes, pen
 * paths, brush strokes, text (any installed or added font, outlines,
 * shadows, gradients, text on an arc) and images, in layers with opacity,
 * blend modes and clipping, drawn over the vehicle's UV template.
 */

export interface DesignerHost {
  pickImage(follow: boolean): Promise<{ name: string; data: Uint8Array; linkId?: number } | undefined>;
  pickFont(): Promise<{ name: string; data: Uint8Array } | undefined>;
  /** Installed font families (may be empty). */
  listFonts?(): Promise<string[]>;
  /** The design changed (for drafts and the Create button). */
  changed(): void;
  status(text: string): void;
}

type Tool = 'select' | 'hand' | 'rect' | 'ellipse' | 'polygon' | 'line' | 'pen' | 'brush' | 'text' | 'mirror';

const TOOLS: { tool: Tool; icon: string; label: string; key: string }[] = [
  { tool: 'select', icon: '➤', label: 'Select and move', key: 'V' },
  { tool: 'hand', icon: '✋', label: 'Pan (or hold Space)', key: 'H' },
  { tool: 'rect', icon: '▭', label: 'Rectangle (drag; Shift for a square)', key: 'R' },
  { tool: 'ellipse', icon: '◯', label: 'Ellipse (drag; Shift for a circle)', key: 'E' },
  { tool: 'polygon', icon: '★', label: 'Star / polygon', key: 'S' },
  { tool: 'line', icon: '╱', label: 'Line (Shift snaps to 45°)', key: 'L' },
  { tool: 'pen', icon: '✒', label: 'Pen: click for corners, drag for curves, click the first point to close, Enter to finish', key: 'P' },
  { tool: 'brush', icon: '🖌', label: 'Brush (smoothed vector strokes)', key: 'B' },
  { tool: 'text', icon: 'T', label: 'Text', key: 'T' },
  { tool: 'mirror', icon: '⧓', label: 'Mirror: drag a box around one piece of the template; what you draw there is copied onto its matching piece', key: 'M' },
];

/** Mirror overlay colours: the source piece, and where it lands. */
const SOURCE = '#ff9f1a';
const TARGET = '#ff3df0';
const MIRROR_MODES: [MirrorMode, string, string][] = [
  ['mirror', 'Mirrored', 'Flipped onto the matching piece (stripes, shapes, paint)'],
  ['readable', 'Kept readable', 'Placed on the matching piece but not flipped, so text and logos read forwards'],
  ['off', 'This side only', 'Not copied by mirrors (e.g. a unit number on one side)'],
];

const BLENDS: [Blend, string][] = [
  ['source-over', 'Normal'],
  ['multiply', 'Multiply'],
  ['screen', 'Screen'],
  ['overlay', 'Overlay'],
  ['soft-light', 'Soft light'],
  ['hard-light', 'Hard light'],
  ['darken', 'Darken'],
  ['lighten', 'Lighten'],
  ['color-dodge', 'Colour dodge'],
  ['color-burn', 'Colour burn'],
  ['difference', 'Difference'],
];

/** Colours often used on emergency and racing liveries. */
const SWATCHES = ['#ffffff', '#000000', '#1c3f94', '#0a2a5e', '#ffd200', '#ff7f00', '#c8102e', '#00843d', '#7f7f7f', '#c0c0c0', '#d4af37', '#00a3e0'];

const HANDLE = 7;
const MOD = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate';
const HANDLE_POS: Record<Exclude<Handle, 'rotate'>, [number, number]> = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };

interface Drag {
  kind:
    | 'move' | 'scale' | 'rotate' | 'scale-multi' | 'rotate-multi' | 'pan' | 'create' | 'brush' | 'marquee' | 'node' | 'handle-in' | 'handle-out' | 'pen-handle'
    | 'mirror-box' | 'mirror-end' | 'mirror-line' | 'mirror-vertex' | 'pin-a' | 'pin-b';
  /** The mirror being edited, as it was when the drag started. */
  mirror?: Mirror;
  /** Combined bounds of the layers when a multi-layer transform started. */
  box?: Box;
  start: { x: number; y: number };
  screen: { x: number; y: number };
  originals: Map<string, Layer>;
  handle?: Handle;
  layer?: Layer;
  node?: number;
  pan?: { x: number; y: number };
  moved?: boolean;
}

export class Designer {
  readonly el: HTMLElement;
  private doc: Design = emptyDesign();
  private readonly images: AssetImages = new Map();
  private selection = new Set<string>();
  private tool: Tool = 'select';
  private zoom = 0.3;
  private panX = 20;
  private panY = 20;
  private fitted = false;
  private template?: HTMLCanvasElement;
  private templateMode: 'over' | 'under' | 'off' = 'over';
  private templateOpacity = 0.55;
  private grid = false;
  private snap = true;
  private guides: { x?: number; y?: number } = {};
  private drag?: Drag;
  private spaceDown = false;
  private hover?: { x: number; y: number };
  /** Pen tool points being placed (design units). */
  private pen: PathPoint[] = [];
  /** Brush stroke being drawn. */
  private brushPts: [number, number][] = [];
  /** Path layer whose points are being edited. */
  private nodeEdit?: string;
  private selectedNode?: number;
  private toolColour = '#ffffff';
  private brushSize = 24;
  private lastFont = 'Arial Black';
  private clipboard: Layer[] = [];
  private readonly undoStack: string[] = [];
  private readonly redoStack: string[] = [];
  private historyGroup?: string;
  private historyAt = 0;
  private drawQueued = false;
  /** Followed image files: link id → asset id. */
  private readonly follows = new Map<number, string>();
  /** The mirror being edited, its selected pin, and whether clicks add pins. */
  private mirrorSel?: string;
  private selectedPin?: number;
  private pinMode = false;
  private ghost = true;
  /** Template line distances (without each mirror's own piece), and line points, by area. */
  private readonly nearCache = new Map<string, { near: Nearest; points: Pt[] }>();
  private scoreTimer?: ReturnType<typeof setTimeout>;
  private readonly scoreEl = h('div', { class: 'small designer-score' });

  private readonly canvas = h('canvas', { class: 'designer-canvas', tabindex: 0 });
  private readonly stage = h('div', { class: 'designer-stage' }, this.canvas);
  private readonly toolbar = h('div', { class: 'designer-toolbar' });
  private readonly topbar = h('div', { class: 'designer-topbar' });
  private readonly layersEl = h('div', { class: 'designer-layers' });
  private readonly mirrorsEl = h('div', { class: 'designer-mirrors' });
  private readonly propsEl = h('div', { class: 'designer-props' });
  private readonly zoomLabel = h('span', { class: 'designer-zoom small' });
  private readonly resize = new ResizeObserver(() => this.layout());

  constructor(private readonly host: DesignerHost) {
    this.el = h(
      'div',
      { class: 'designer' },
      this.toolbar,
      h('div', { class: 'designer-main' }, this.topbar, this.stage),
      h('div', { class: 'designer-side' }, h('div', { class: 'pack-section' }, 'Mirrors'), this.mirrorsEl, h('div', { class: 'pack-section' }, 'Layers'), this.layersEl, this.propsEl)
    );
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e));
    this.canvas.addEventListener('pointerleave', () => ((this.hover = undefined), this.requestDraw()));
    this.canvas.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKeyUp);
    this.resize.observe(this.stage);
    this.renderToolbar();
    this.renderTopbar();
    this.renderPanels();
    void host.listFonts?.().then(setSystemFonts);
    // Debugging aid: inspect the designer from the webview developer tools.
    (window as unknown as { __designer?: Designer }).__designer = this;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKeyUp);
    this.resize.disconnect();
  }

  // -- public -------------------------------------------------------------------------

  setTemplate(canvas: HTMLCanvasElement | undefined): void {
    this.template = canvas;
    this.nearCache.clear();
    this.renderTopbar();
    this.requestDraw();
  }

  get isEmpty(): boolean {
    return !this.doc.layers.some((l) => l.visible);
  }

  /** The design to save (only the assets and fonts it uses). */
  get design(): Design {
    return packDesign(this.doc);
  }

  async load(design: Design): Promise<void> {
    for (const [family, data] of Object.entries(design.fonts)) {
      try {
        await loadFont(family, data);
      } catch {
        this.host.status(`Couldn't load the font ${family} stored in the design.`);
      }
    }
    this.doc = { ...design, layers: design.layers.map(cloneLayer), mirrors: JSON.parse(JSON.stringify(design.mirrors ?? [])) as Mirror[] };
    this.mirrorSel = undefined;
    this.pinMode = false;
    this.images.clear();
    await Promise.all(Object.entries(this.doc.assets).map(([id, url]) => this.decodeAsset(id, url)));
    this.selection.clear();
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.renderPanels();
    this.requestDraw();
  }

  rasterize(size: number): HTMLCanvasElement {
    return rasterize(this.doc, this.images, size);
  }

  /** Adds an image as a layer (fitting the canvas when `fill`), optionally locked. */
  async addImage(name: string, canvasOrUrl: HTMLCanvasElement | string, opts: { fill?: boolean; locked?: boolean; bottom?: boolean; linkId?: number } = {}): Promise<void> {
    const url = typeof canvasOrUrl === 'string' ? canvasOrUrl : canvasOrUrl.toDataURL('image/png');
    const id = newId();
    this.doc.assets[id] = url;
    const img = await this.decodeAsset(id, url);
    if (!img) return;
    this.checkpoint();
    const aspect = img.width / Math.max(1, img.height);
    const w = opts.fill ? DESIGN_SIZE : Math.min(DESIGN_SIZE * 0.4, img.width);
    const layer = makeLayer('image', DESIGN_SIZE / 2, DESIGN_SIZE / 2, {
      name,
      asset: id,
      w,
      h: opts.fill ? DESIGN_SIZE : w / aspect,
      locked: !!opts.locked,
      // A base texture isn't copied by mirrors.
      ...(opts.bottom ? { mirror: 'off' } : {}),
    } as Partial<ImageLayer>);
    if (opts.bottom) this.doc.layers.unshift(layer);
    else this.doc.layers.push(layer);
    if (opts.linkId !== undefined) this.follows.set(opts.linkId, id);
    this.select([layer.id]);
    this.commit();
  }

  /** A followed image file changed: swap its pixels in place. */
  async updateFollowed(linkId: number, name: string, url: string): Promise<boolean> {
    const id = this.follows.get(linkId);
    if (!id) return false;
    this.doc.assets[id] = url;
    await this.decodeAsset(id, url);
    this.host.status(`Updated ${name} at ${new Date().toLocaleTimeString()}.`);
    this.requestDraw();
    this.host.changed();
    return true;
  }

  // -- helpers --------------------------------------------------------------------------

  private async decodeAsset(id: string, url: string): Promise<HTMLImageElement | undefined> {
    // onload rather than decode(): decode() can stay pending forever in some Chromium versions.
    const img = new Image();
    const ok = await new Promise<boolean>((resolve) => {
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = url;
    });
    if (!ok) {
      this.host.status("Couldn't decode an image in the design.");
      return undefined;
    }
    this.images.set(id, img);
    return img;
  }

  private layer(id: string): Layer | undefined {
    return this.doc.layers.find((l) => l.id === id);
  }

  private get selected(): Layer[] {
    return this.doc.layers.filter((l) => this.selection.has(l.id));
  }

  private select(ids: string[]): void {
    this.selection = new Set(ids);
    if (ids.length) this.selectMirror(undefined, false);
    if (this.nodeEdit && !this.selection.has(this.nodeEdit)) this.nodeEdit = undefined;
    this.renderPanels();
    this.requestDraw();
  }

  private toDesign(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left - this.panX) / this.zoom, y: (e.clientY - r.top - this.panY) / this.zoom };
  }

  private toScreen(x: number, y: number): { x: number; y: number } {
    return { x: x * this.zoom + this.panX, y: y * this.zoom + this.panY };
  }

  // -- history -----------------------------------------------------------------------------

  private checkpoint(group?: string): void {
    const now = performance.now();
    if (group && group === this.historyGroup && now - this.historyAt < 1200) {
      this.historyAt = now;
      return;
    }
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack.length = 0;
    this.historyGroup = group;
    this.historyAt = now;
  }

  private snapshot(): string {
    return JSON.stringify({ layers: this.doc.layers, mirrors: this.doc.mirrors ?? [] });
  }

  /** After a change: redraw, refresh the panels, tell the host. */
  private commit(panels = true): void {
    if (panels) this.renderPanels();
    this.renderTopbar();
    this.requestDraw();
    this.host.changed();
    this.scheduleScore();
  }

  private undo(redo = false): void {
    const from = redo ? this.redoStack : this.undoStack;
    const to = redo ? this.undoStack : this.redoStack;
    const state = from.pop();
    if (!state) return;
    to.push(this.snapshot());
    const parsed = JSON.parse(state) as { layers: Layer[]; mirrors: Mirror[] };
    this.doc.layers = parsed.layers;
    this.doc.mirrors = parsed.mirrors;
    if (this.mirrorSel && !this.mirrorById(this.mirrorSel)) this.mirrorSel = undefined;
    this.selectedPin = undefined;
    this.historyGroup = undefined;
    this.selection = new Set([...this.selection].filter((id) => this.layer(id)));
    this.nodeEdit = undefined;
    this.commit();
  }

  // -- drawing -----------------------------------------------------------------------------

  private layout(): void {
    const r = this.stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    if (!this.fitted && r.width > 50 && r.height > 50) {
      this.fit();
      this.fitted = true;
    }
    this.requestDraw();
  }

  private fit(): void {
    const r = this.stage.getBoundingClientRect();
    this.zoom = (Math.min(r.width, r.height) * 0.94) / DESIGN_SIZE;
    this.panX = (r.width - DESIGN_SIZE * this.zoom) / 2;
    this.panY = (r.height - DESIGN_SIZE * this.zoom) / 2;
    this.updateZoomLabel();
    this.requestDraw();
  }

  private setZoom(z: number, about?: { x: number; y: number }): void {
    const r = this.stage.getBoundingClientRect();
    const sx = about?.x ?? r.width / 2;
    const sy = about?.y ?? r.height / 2;
    const dx = (sx - this.panX) / this.zoom;
    const dy = (sy - this.panY) / this.zoom;
    this.zoom = Math.min(8, Math.max(0.05, z));
    this.panX = sx - dx * this.zoom;
    this.panY = sy - dy * this.zoom;
    this.updateZoomLabel();
    this.requestDraw();
  }

  private updateZoomLabel(): void {
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
  }

  requestDraw(): void {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.draw();
    });
  }

  private draw(): void {
    const ctx = this.canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const size = DESIGN_SIZE * this.zoom;
    // Checkerboard where the texture is transparent (the paint colour shows there).
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.panX, this.panY, size, size);
    ctx.clip();
    const cell = 16;
    ctx.fillStyle = '#9a9a9a';
    ctx.fillRect(this.panX, this.panY, size, size);
    ctx.fillStyle = '#c4c4c4';
    for (let y = 0; y < size; y += cell) for (let x = (Math.floor(y / cell) % 2) * cell; x < size; x += cell * 2) ctx.fillRect(this.panX + x, this.panY + y, cell, cell);
    const drawTemplate = () => {
      if (!this.template) return;
      ctx.globalAlpha = this.templateOpacity;
      ctx.drawImage(this.template, this.panX, this.panY, size, size);
      ctx.globalAlpha = 1;
    };
    if (this.templateMode === 'under') drawTemplate();
    ctx.save();
    ctx.setTransform(dpr * this.zoom, 0, 0, dpr * this.zoom, dpr * this.panX, dpr * this.panY);
    drawDesign(ctx, this.doc, this.images);
    if (this.brushPts.length) {
      const preview = makeLayer('brush', 0, 0, { points: this.brushPts, stroke: { ...this.newStroke(), width: this.brushSize } } as Partial<Layer>);
      drawDesign(ctx, { ...this.doc, layers: [preview] }, this.images);
    }
    ctx.restore();
    if (this.templateMode === 'over') drawTemplate();
    this.drawGhost(ctx, dpr);
    if (this.grid) {
      ctx.strokeStyle = 'rgba(0,160,255,0.25)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 16; i++) {
        const p = (i * size) / 16;
        ctx.beginPath();
        ctx.moveTo(this.panX + p, this.panY);
        ctx.lineTo(this.panX + p, this.panY + size);
        ctx.moveTo(this.panX, this.panY + p);
        ctx.lineTo(this.panX + size, this.panY + p);
        ctx.stroke();
      }
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(128,128,128,0.8)';
    ctx.lineWidth = 1;
    ctx.strokeRect(this.panX - 0.5, this.panY - 0.5, size + 1, size + 1);
    this.drawOverlay(ctx);
  }

  private drawOverlay(ctx: CanvasRenderingContext2D): void {
    const accent = '#3794ff';
    // Snap guides.
    ctx.strokeStyle = '#ff4fd8';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    if (this.guides.x !== undefined) {
      const s = this.toScreen(this.guides.x, 0).x;
      ctx.beginPath();
      ctx.moveTo(s, 0);
      ctx.lineTo(s, this.canvas.height);
      ctx.stroke();
    }
    if (this.guides.y !== undefined) {
      const s = this.toScreen(0, this.guides.y).y;
      ctx.beginPath();
      ctx.moveTo(0, s);
      ctx.lineTo(this.canvas.width, s);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // Selection outlines and handles.
    const sel = this.selected;
    for (const l of sel) {
      const c = layerCorners(l).map((p) => this.toScreen(p.x, p.y));
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1;
      ctx.beginPath();
      c.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
    }
    const handles = sel.length === 1 && !sel[0].locked && !this.nodeEdit ? this.handlePositions(sel[0]) : sel.length > 1 ? this.multiHandles(sel) : [];
    if (sel.length > 1 && handles.length) {
      const b = union(sel.map(layerBounds));
      const a = this.toScreen(b.x, b.y);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = accent;
      ctx.strokeRect(a.x, a.y, b.w * this.zoom, b.h * this.zoom);
      ctx.setLineDash([]);
    }
    {
      for (const [name, p] of handles) {
        ctx.fillStyle = name === 'rotate' ? accent : '#ffffff';
        ctx.strokeStyle = accent;
        ctx.beginPath();
        if (name === 'rotate') ctx.arc(p.x, p.y, HANDLE - 1, 0, Math.PI * 2);
        else ctx.rect(p.x - HANDLE / 2 - 1, p.y - HANDLE / 2 - 1, HANDLE + 2, HANDLE + 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    // Path node editing.
    const edit = this.nodeEdit ? this.layer(this.nodeEdit) : undefined;
    const editPts = edit && editablePoints(edit);
    if (edit && editPts) {
      const m = layerMatrix(edit);
      const sp = (x: number, y: number) => {
        const d = m.transformPoint(new DOMPoint(x, y));
        return this.toScreen(d.x, d.y);
      };
      if (edit.type === 'text') {
        // The path the text follows, drawn as a guide.
        const pts = edit.path!;
        ctx.strokeStyle = 'rgba(55,148,255,0.6)';
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        const p0 = sp(pts[0].x, pts[0].y);
        ctx.moveTo(p0.x, p0.y);
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1];
          const b = pts[i];
          const c1 = sp(a.x + (a.out?.x ?? 0), a.y + (a.out?.y ?? 0));
          const c2 = sp(b.x + (b.in?.x ?? 0), b.y + (b.in?.y ?? 0));
          const pb = sp(b.x, b.y);
          ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, pb.x, pb.y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
      editPts.forEach((pt, i) => {
        const p = sp(pt.x, pt.y);
        for (const hd of [pt.in, pt.out]) {
          if (!hd) continue;
          const q = sp(pt.x + hd.x, pt.y + hd.y);
          ctx.strokeStyle = accent;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(q.x, q.y);
          ctx.stroke();
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(q.x, q.y, 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
        ctx.fillStyle = i === this.selectedNode ? accent : '#ffffff';
        ctx.strokeStyle = accent;
        ctx.fillRect(p.x - 4, p.y - 4, 8, 8);
        ctx.strokeRect(p.x - 4, p.y - 4, 8, 8);
      });
    }
    // Pen tool in progress.
    if (this.pen.length) {
      const path = new Path2D();
      const pts = this.hover && !this.drag ? [...this.pen, { x: this.hover.x, y: this.hover.y }] : this.pen;
      const s = (p: { x: number; y: number }) => this.toScreen(p.x, p.y);
      path.moveTo(s(pts[0]).x, s(pts[0]).y);
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const ca = s({ x: a.x + (a.out?.x ?? 0), y: a.y + (a.out?.y ?? 0) });
        const cb = s({ x: b.x + (b.in?.x ?? 0), y: b.y + (b.in?.y ?? 0) });
        const pb = s(b);
        path.bezierCurveTo(ca.x, ca.y, cb.x, cb.y, pb.x, pb.y);
      }
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5;
      ctx.stroke(path);
      this.pen.forEach((p, i) => {
        const q = s(p);
        ctx.fillStyle = i === 0 ? accent : '#ffffff';
        ctx.fillRect(q.x - 4, q.y - 4, 8, 8);
        ctx.strokeRect(q.x - 4, q.y - 4, 8, 8);
      });
    }
    this.drawMirrorOverlay(ctx);
    // Marquee.
    if (this.drag?.kind === 'marquee' && this.hover) {
      const a = this.toScreen(this.drag.start.x, this.drag.start.y);
      const b = this.toScreen(this.hover.x, this.hover.y);
      ctx.strokeStyle = accent;
      ctx.fillStyle = 'rgba(55,148,255,0.1)';
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    }
  }

  private handlePositions(l: Layer): [Handle, { x: number; y: number }][] {
    const b = localBox(l);
    const m = layerMatrix(l);
    const at = (u: number, v: number) => {
      const p = m.transformPoint(new DOMPoint(b.x + u * b.w, b.y + v * b.h));
      return this.toScreen(p.x, p.y);
    };
    const out: [Handle, { x: number; y: number }][] = (Object.keys(HANDLE_POS) as Exclude<Handle, 'rotate'>[]).map((k) => [k, at(...HANDLE_POS[k])]);
    // Rotation handle: above the top edge, along the layer's own "up".
    const top = at(0.5, 0);
    const centre = at(0.5, 0.5);
    const len = Math.hypot(top.x - centre.x, top.y - centre.y) || 1;
    out.push(['rotate', { x: top.x + ((top.x - centre.x) / len) * 24, y: top.y + ((top.y - centre.y) / len) * 24 }]);
    return out;
  }

  /** Corner and rotation handles around several layers' combined bounds. */
  private multiHandles(sel: Layer[]): [Handle, { x: number; y: number }][] {
    if (sel.every((l) => l.locked)) return [];
    const b = union(sel.map(layerBounds));
    const at = (u: number, v: number) => this.toScreen(b.x + u * b.w, b.y + v * b.h);
    const top = at(0.5, 0);
    return [['nw', at(0, 0)], ['ne', at(1, 0)], ['se', at(1, 1)], ['sw', at(0, 1)], ['rotate', { x: top.x, y: top.y - 24 }]];
  }

  // -- mirrors --------------------------------------------------------------------------------

  private mirrorById(id: string): Mirror | undefined {
    return this.doc.mirrors?.find((m) => m.id === id);
  }

  private get activeMirror(): Mirror | undefined {
    return this.mirrorSel ? this.mirrorById(this.mirrorSel) : undefined;
  }

  private selectMirror(id: string | undefined, render = true): void {
    if (this.mirrorSel === id) return;
    this.mirrorSel = id;
    this.selectedPin = undefined;
    if (!id) this.pinMode = false;
    if (id) this.selection.clear();
    if (render) {
      this.renderPanels();
      this.requestDraw();
      this.scheduleScore();
    }
  }

  private lines(): LineMap | undefined {
    return this.template ? lineMap(this.template) : undefined;
  }

  /** The selected mirror's source lines drawn through it, in pink, to compare with the template. */
  private drawGhost(ctx: CanvasRenderingContext2D, dpr: number): void {
    const m = this.activeMirror;
    if (!m || !this.ghost || !this.template || this.templateMode === 'off' || m.area.length < 3) return;
    const ghost = tintedTemplate(this.template, [255, 61, 240]);
    ctx.save();
    ctx.setTransform(dpr * this.zoom, 0, 0, dpr * this.zoom, dpr * this.panX, dpr * this.panY);
    ctx.globalAlpha = Math.min(1, this.templateOpacity + 0.25);
    drawThroughMirror(ctx, m.area, mirrorMapping(m), (c) => c.drawImage(ghost, 0, 0, DESIGN_SIZE, DESIGN_SIZE));
    ctx.restore();
  }

  private drawMirrorOverlay(ctx: CanvasRenderingContext2D): void {
    const s = (p: Pt) => this.toScreen(p.x, p.y);
    const outline = (pts: Pt[], colour: string, dash: number[], fill?: string) => {
      if (pts.length < 2) return;
      ctx.beginPath();
      pts.forEach((p, i) => {
        const q = s(p);
        if (i) ctx.lineTo(q.x, q.y);
        else ctx.moveTo(q.x, q.y);
      });
      ctx.closePath();
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      ctx.strokeStyle = colour;
      ctx.setLineDash(dash);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    ctx.lineWidth = 1;
    // Other mirrors, faintly, while the mirror tool is out.
    for (const m of this.doc.mirrors ?? []) {
      if (m.id === this.mirrorSel || (this.tool !== 'mirror' && !this.pinMode)) continue;
      outline(m.area, m.enabled ? 'rgba(255,159,26,0.6)' : 'rgba(128,128,128,0.6)', [3, 3]);
    }
    if (this.drag?.kind === 'mirror-box' && this.hover) {
      const a = this.drag.start;
      const b = this.hover;
      outline([a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }], SOURCE, [5, 4], 'rgba(255,159,26,0.1)');
    }
    const m = this.activeMirror;
    if (!m) return;
    const mapping = mirrorMapping(m);
    outline(m.area, SOURCE, [], 'rgba(255,159,26,0.08)');
    outline(mappedOutline(m.area, mapping.map), TARGET, [6, 4]);
    // The mirror line, across the canvas.
    const [p1, p2] = m.line;
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
    const ux = (p2.x - p1.x) / len;
    const uy = (p2.y - p1.y) / len;
    const far = DESIGN_SIZE * 2;
    const a = s({ x: p1.x - ux * far, y: p1.y - uy * far });
    const b = s({ x: p1.x + ux * far, y: p1.y + uy * far });
    ctx.strokeStyle = SOURCE;
    ctx.setLineDash([10, 5]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of m.line) {
      const q = s(p);
      ctx.fillStyle = SOURCE;
      ctx.strokeStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(q.x, q.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    for (const p of m.area) {
      const q = s(p);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = SOURCE;
      ctx.fillRect(q.x - 4, q.y - 4, 8, 8);
      ctx.strokeRect(q.x - 4, q.y - 4, 8, 8);
    }
    m.pins.forEach((pin, i) => {
      const qa = s(pin.a);
      const qb = s(pin.b);
      const active = i === this.selectedPin;
      if (active) {
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(qa.x, qa.y);
        ctx.lineTo(qb.x, qb.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.lineWidth = active ? 2.5 : 1.5;
      ctx.fillStyle = SOURCE;
      ctx.strokeStyle = active ? '#ffffff' : '#000000';
      ctx.beginPath();
      ctx.arc(qa.x, qa.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = TARGET;
      ctx.beginPath();
      ctx.moveTo(qb.x, qb.y - 7);
      ctx.lineTo(qb.x + 7, qb.y);
      ctx.lineTo(qb.x, qb.y + 7);
      ctx.lineTo(qb.x - 7, qb.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.font = '10px sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(String(i + 1), qa.x + 7, qa.y - 6);
      ctx.fillText(String(i + 1), qb.x + 8, qb.y - 7);
    });
  }

  /** The selected mirror's handle under a screen point. */
  private mirrorHit(screen: Pt): { kind: Drag['kind']; index: number } | undefined {
    const m = this.activeMirror;
    if (!m) return undefined;
    const near = (p: Pt, r: number) => {
      const q = this.toScreen(p.x, p.y);
      return Math.hypot(q.x - screen.x, q.y - screen.y) <= r;
    };
    for (let i = m.pins.length - 1; i >= 0; i--) if (near(m.pins[i].b, 9)) return { kind: 'pin-b', index: i };
    for (let i = m.pins.length - 1; i >= 0; i--) if (near(m.pins[i].a, 8)) return { kind: 'pin-a', index: i };
    for (let i = 0; i < 2; i++) if (near(m.line[i], 9)) return { kind: 'mirror-end', index: i };
    for (let i = 0; i < m.area.length; i++) if (near(m.area[i], 7)) return { kind: 'mirror-vertex', index: i };
    // On the line itself (inside the canvas): move it.
    const a = this.toScreen(m.line[0].x, m.line[0].y);
    const b = this.toScreen(m.line[1].x, m.line[1].y);
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const d = Math.abs((b.x - a.x) * (a.y - screen.y) - (a.x - screen.x) * (b.y - a.y)) / len;
    const p = this.toDesign({ clientX: screen.x + this.canvas.getBoundingClientRect().left, clientY: screen.y + this.canvas.getBoundingClientRect().top });
    if (d <= 5 && p.x >= 0 && p.y >= 0 && p.x <= DESIGN_SIZE && p.y <= DESIGN_SIZE) return { kind: 'mirror-line', index: 0 };
    return undefined;
  }

  /** A box was drawn with the mirror tool: make a mirror for that piece and find its match. */
  private createMirror(start: Pt, end: Pt): void {
    const x0 = Math.max(0, Math.min(start.x, end.x));
    const x1 = Math.min(DESIGN_SIZE, Math.max(start.x, end.x));
    const y0 = Math.max(0, Math.min(start.y, end.y));
    const y1 = Math.min(DESIGN_SIZE, Math.max(start.y, end.y));
    if (x1 - x0 < 8 || y1 - y0 < 8) {
      // A click: pick the mirror whose piece is there.
      const hit = [...(this.doc.mirrors ?? [])].reverse().find((m) => inPolygon(m.area, start.x, start.y));
      this.selectMirror(hit?.id);
      return;
    }
    this.doc.mirrors ??= [];
    const draft: Mirror = {
      id: newId(),
      name: `Mirror ${this.doc.mirrors.length + 1}`,
      enabled: true,
      // Without a template: the canvas's vertical centre line.
      line: [{ x: DESIGN_SIZE / 2, y: 0 }, { x: DESIGN_SIZE / 2, y: DESIGN_SIZE }],
      area: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
      pins: [],
    };
    const lines = this.lines();
    this.host.status(lines ? 'Finding the matching piece…' : '');
    // Let the status paint before the search.
    setTimeout(() => {
      const { mirror, score } = placeMirror(lines, draft, start);
      this.checkpoint();
      this.doc.mirrors!.push(mirror);
      this.setTool('select');
      this.selectMirror(mirror.id);
      this.commit();
      if (!lines) this.host.status(`${mirror.name}: drag the orange line where the two pieces meet (its ends tilt it). There’s no template to fit to, so check the copy by eye.`);
      else if (score === undefined || score > 6)
        this.host.status(`${mirror.name}: couldn’t find a clear match. Drag the orange line between the two pieces, then Auto-fit, or add pins.`);
      else this.host.status(`${mirror.name}: copies the orange piece onto the pink one (off by ${score.toFixed(1)} on average). Check the pink ghost sits on the template; add pins where it doesn’t.`);
    }, 20);
  }

  private editMirror(fn: (m: Mirror) => Mirror | void, group?: string): void {
    const m = this.activeMirror;
    if (!m) return;
    this.checkpoint(group);
    const next = fn(m);
    if (next) this.doc.mirrors = this.doc.mirrors!.map((x) => (x.id === m.id ? next : x));
    this.commit();
  }

  private runAutoFit(): void {
    const m = this.activeMirror;
    const lines = this.lines();
    if (!m || !lines) return;
    const result = autoFit(lines, m);
    if (!result || !(result.after < result.before)) {
      this.host.status(result ? `Auto-fit couldn’t improve it (off by ${result.before.toFixed(1)}). Move the line closer, or add pins.` : 'Auto-fit needs template lines inside the orange piece.');
      return;
    }
    this.editMirror((x) => ({ ...x, fit: result.fit }));
    this.host.status(`Auto-fit: off by ${result.after.toFixed(1)} on average (was ${result.before.toFixed(1)}).`);
  }

  private findMatch(): void {
    const m = this.activeMirror;
    const lines = this.lines();
    if (!m || !lines) return;
    const b = polygonBox(m.area);
    const { mirror, score } = placeMirror(lines, { ...m, fit: undefined, pins: [] }, { x: b.x + b.w / 2, y: b.y + b.h / 2 });
    this.editMirror(() => mirror);
    this.host.status(score === undefined || score > 6 ? 'Couldn’t find a clear match; place the line by hand.' : `Found it: off by ${score.toFixed(1)} on average.`);
  }

  /** Recomputes the selected mirror's misalignment shortly after a change. */
  private scheduleScore(): void {
    clearTimeout(this.scoreTimer);
    this.scoreTimer = setTimeout(() => this.updateScore(), this.drag ? 400 : 120);
  }

  private updateScore(): void {
    const m = this.activeMirror;
    const lines = this.lines();
    if (!m || !lines || m.area.length < 3) {
      this.scoreEl.textContent = '';
      return;
    }
    const key = JSON.stringify(m.area);
    let cached = this.nearCache.get(key);
    if (!cached) {
      if (this.nearCache.size > 8) this.nearCache.clear();
      cached = { near: nearestLines(lines, m.area), points: linePoints(lines, m.area, 1500) };
      this.nearCache.set(key, cached);
    }
    const score = misalignment(cached.near, cached.points, mirrorMapping(m).map);
    if (!Number.isFinite(score)) {
      this.scoreEl.textContent = 'No template lines inside the orange piece.';
      this.scoreEl.className = 'small designer-score muted';
      return;
    }
    const quality = score < 1.5 ? 'good' : score < 4 ? 'fair' : 'poor';
    this.scoreEl.textContent = `Off by ${score.toFixed(1)} on average (${quality === 'good' ? 'lined up' : quality === 'fair' ? 'close: add pins where the ghost is off' : 'not lined up yet'}).`;
    this.scoreEl.className = `small designer-score ${quality}`;
  }

  private renderMirrors(): void {
    const mirrors = this.doc.mirrors ?? [];
    const rows = mirrors.map((m) => {
      const name = h('span', { class: 'designer-layer-name', title: 'Double-click to rename' }, m.name);
      name.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const input = h('input', { type: 'text', value: m.name, class: 'designer-rename' });
        const done = () => this.editMirror((x) => ({ ...x, name: input.value.trim() || x.name }));
        input.addEventListener('keydown', (k) => (k.key === 'Enter' ? done() : undefined));
        input.addEventListener('blur', done);
        name.replaceWith(input);
        input.focus();
        input.select();
      });
      return h(
        'div',
        { class: `designer-layer${m.id === this.mirrorSel ? ' active' : ''}${m.enabled ? '' : ' hidden'}`, onclick: () => this.selectMirror(m.id === this.mirrorSel ? undefined : m.id) },
        h(
          'button',
          {
            class: 'designer-icon',
            title: m.enabled ? 'Turn this mirror off' : 'Turn this mirror on',
            onclick: (e: Event) => {
              e.stopPropagation();
              this.checkpoint();
              m.enabled = !m.enabled;
              this.commit();
            },
          },
          m.enabled ? '👁' : '◌'
        ),
        h('span', { class: 'designer-layer-type' }, '⧓'),
        name,
        h('span', { class: 'small muted' }, m.pins.length ? `${m.pins.length} pin${m.pins.length === 1 ? '' : 's'}` : '')
      );
    });
    this.mirrorsEl.replaceChildren(
      ...(rows.length ? [h('div', { class: 'designer-layer-list designer-mirror-list' }, rows)] : []),
      h(
        'div',
        { class: 'row designer-layer-actions' },
        h('button', { class: `chip mini${this.tool === 'mirror' ? ' active' : ''}`, title: 'Drag a box around one piece of the template (M)', onclick: () => this.setTool(this.tool === 'mirror' ? 'select' : 'mirror') }, '+ Mirror'),
        rows.length ? null : h('span', { class: 'small muted' }, 'Copy one side onto its matching piece.')
      )
    );
  }

  private renderMirrorProps(m: Mirror): void {
    const btn = (label: string, title: string, onclick: () => void, opts: { active?: boolean; disabled?: boolean } = {}) =>
      h('button', { class: `chip mini${opts.active ? ' active' : ''}`, title, disabled: !!opts.disabled, onclick }, label);
    const hasTemplate = !!this.template;
    const n = m.pins.length;
    const pinHelp =
      n === 0 ? 'No pins: a plain mirror.'
      : n === 1 ? '1 pin: moves the copy.'
      : n === 2 ? '2 pins: move, rotate and scale.'
      : n === 3 ? '3 pins: also stretch and skew.'
      : `${n} pins: bends to fit every pin.`;
    const ghost = h('input', { type: 'checkbox', checked: this.ghost });
    ghost.addEventListener('change', () => ((this.ghost = ghost.checked), this.requestDraw()));
    const on = h('input', { type: 'checkbox', checked: m.enabled });
    on.addEventListener('change', () => this.editMirror((x) => ({ ...x, enabled: on.checked })));
    this.propsEl.replaceChildren(
      h(
        'div',
        { class: 'designer-section' },
        h('div', { class: 'designer-section-title' }, m.name),
        h(
          'div',
          { class: 'small muted' },
          'Whatever you draw in the orange piece is copied onto the pink outline. Text and logos stay readable; set it per layer under Layer → In mirrors.'
        ),
        h('div', { class: 'row' }, h('label', { class: 'toggle' }, on, 'On'), hasTemplate ? h('label', { class: 'toggle', title: 'Show the orange piece’s template lines where the mirror puts them' }, ghost, 'Alignment ghost') : null),
        hasTemplate ? this.scoreEl : null,
        h(
          'div',
          { class: 'row' },
          hasTemplate ? btn('Auto-fit', 'Line the copy up with the template on the other side (move, rotate, scale, stretch)', () => this.runAutoFit()) : null,
          hasTemplate ? btn('Find match', 'Search the template for the matching piece again (resets the fit and pins)', () => this.findMatch()) : null,
          btn('Swap sides', 'Make the pink piece the one you draw on', () => this.editMirror((x) => swapMirror(x)))
        )
      ),
      h(
        'div',
        { class: 'designer-section' },
        h('div', { class: 'designer-section-title' }, 'Pins'),
        h('div', { class: 'small muted' }, `Where the pink ghost doesn’t sit on the template: Add pins, click a point on the orange piece, then drag its pink ◆ onto the matching point. ${pinHelp}`),
        h(
          'div',
          { class: 'row' },
          btn(this.pinMode ? 'Adding pins…' : 'Add pins', 'Click points on the orange piece to pin them (Esc to stop)', () => {
            this.pinMode = !this.pinMode;
            this.host.status(this.pinMode ? 'Click a point on the orange piece (a corner, a wheel arch, a door edge), then drag its pink ◆ onto the same point on the other piece.' : '');
            this.renderProps();
            this.requestDraw();
          }, { active: this.pinMode }),
          btn('Remove pin', 'Remove the selected pin (Delete)', () => this.removePin(), { disabled: this.selectedPin === undefined }),
          btn('Clear pins', 'Remove all pins', () => this.editMirror((x) => ({ ...x, pins: [] })), { disabled: !n })
        )
      ),
      h(
        'div',
        { class: 'designer-section' },
        h('div', { class: 'designer-section-title' }, 'Mirror line'),
        h('div', { class: 'small muted' }, 'Drag the orange line to move it, its round ends to tilt it (Shift: level), the white squares to reshape the piece.'),
        h(
          'div',
          { class: 'row' },
          btn('Reset fit', 'Back to a plain reflection across the line (keeps the pins)', () => this.editMirror((x) => ({ ...x, fit: undefined })), { disabled: !m.fit }),
          btn('Delete mirror', 'Remove this mirror (the layers stay)', () => {
            this.checkpoint();
            this.doc.mirrors = (this.doc.mirrors ?? []).filter((x) => x.id !== m.id);
            this.selectMirror(undefined, false);
            this.commit();
          })
        )
      )
    );
    this.updateScore();
  }

  private removePin(): void {
    const i = this.selectedPin;
    if (i === undefined) return;
    this.selectedPin = undefined;
    this.editMirror((x) => ({ ...x, pins: x.pins.filter((_, j) => j !== i) }));
  }

  // -- pointer ------------------------------------------------------------------------------

  private hitTop(p: { x: number; y: number }): Layer | undefined {
    const tol = 4 / this.zoom;
    for (let i = this.doc.layers.length - 1; i >= 0; i--) {
      const l = this.doc.layers[i];
      if (l.visible && !l.locked && hitLayer(l, p.x, p.y, tol)) return l;
    }
    return undefined;
  }

  private onDown(e: PointerEvent): void {
    this.canvas.focus();
    const p = this.toDesign(e);
    const r = this.canvas.getBoundingClientRect();
    const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
    const base = (kind: Drag['kind'], extra: Partial<Drag> = {}): Drag => ({ kind, start: p, screen, originals: new Map(), ...extra });
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events have no capturable pointer.
    }
    if (e.button === 1 || this.tool === 'hand' || this.spaceDown) {
      this.drag = base('pan', { pan: { x: this.panX, y: this.panY } });
      return;
    }
    if (e.button !== 0) return;
    switch (this.tool) {
      case 'select': {
        // The selected mirror's handles first, then adding pins.
        const mhit = this.mirrorHit(screen);
        const am = this.activeMirror;
        if (mhit && am) {
          this.checkpoint();
          if (mhit.kind === 'pin-a' || mhit.kind === 'pin-b') this.selectedPin = mhit.index;
          this.drag = base(mhit.kind, { node: mhit.index, mirror: JSON.parse(JSON.stringify(am)) as Mirror });
          this.renderProps();
          this.requestDraw();
          return;
        }
        if (am && this.pinMode) {
          this.checkpoint();
          const b = mirrorMapping(am).map(p);
          am.pins.push({ a: { x: p.x, y: p.y }, b });
          this.selectedPin = am.pins.length - 1;
          this.host.status(`Pin ${am.pins.length}: now drag the pink ◆ onto the matching point on the other piece.`);
          this.commit();
          return;
        }
        // Node editing next.
        const edit = this.nodeEdit ? this.layer(this.nodeEdit) : undefined;
        if (edit && editablePoints(edit)) {
          const hit = this.hitNode(edit, screen);
          if (hit) {
            this.checkpoint();
            this.selectedNode = hit.index;
            this.drag = base(hit.part === 'node' ? 'node' : hit.part === 'in' ? 'handle-in' : 'handle-out', { layer: edit, node: hit.index });
            this.requestDraw();
            return;
          }
        }
        const sel = this.selected;
        if (sel.length === 1 && !sel[0].locked && !this.nodeEdit) {
          const handle = this.handlePositions(sel[0]).find(([, hp]) => Math.hypot(hp.x - screen.x, hp.y - screen.y) <= HANDLE + 2)?.[0];
          if (handle) {
            this.checkpoint();
            this.drag = base(handle === 'rotate' ? 'rotate' : 'scale', { handle, layer: sel[0], originals: new Map([[sel[0].id, cloneLayer(sel[0])]]) });
            return;
          }
        }
        if (sel.length > 1) {
          const handle = this.multiHandles(sel).find(([, hp]) => Math.hypot(hp.x - screen.x, hp.y - screen.y) <= HANDLE + 2)?.[0];
          if (handle) {
            this.checkpoint();
            this.drag = base(handle === 'rotate' ? 'rotate-multi' : 'scale-multi', {
              handle,
              box: union(sel.map(layerBounds)),
              originals: new Map(sel.filter((l) => !l.locked).map((l) => [l.id, cloneLayer(l)])),
            });
            return;
          }
        }
        const hit = this.hitTop(p);
        if (!hit) {
          if (this.nodeEdit) {
            this.nodeEdit = undefined;
            this.selectedNode = undefined;
          }
          if (!e.shiftKey) this.select([]);
          this.drag = base('marquee');
          return;
        }
        // A grouped layer selects its whole group (Alt picks the one layer).
        const ids = hit.group && !e.altKey ? this.doc.layers.filter((l) => l.group === hit.group && !l.locked).map((l) => l.id) : [hit.id];
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          const next = new Set(this.selection);
          const on = !next.has(hit.id);
          ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
          this.select([...next]);
        } else if (!this.selection.has(hit.id)) this.select(ids);
        this.drag = base('move', { originals: new Map(this.selected.filter((l) => !l.locked).map((l) => [l.id, cloneLayer(l)])) });
        return;
      }
      case 'rect':
      case 'ellipse':
      case 'polygon':
      case 'line': {
        this.checkpoint();
        const layer =
          this.tool === 'line'
            ? makeLayer('path', p.x, p.y, { name: 'Line', closed: false, points: [{ x: 0, y: 0 }, { x: 0.01, y: 0 }], fill: { kind: 'none' }, stroke: { ...this.newStroke(), width: 16 } } as Partial<PathLayer>)
            : makeLayer(this.tool, p.x, p.y, { w: 1, h: 1, fill: solid(this.toolColour) } as Partial<Layer>);
        this.doc.layers.push(layer);
        this.selection = new Set([layer.id]);
        this.drag = base('create', { layer });
        return;
      }
      case 'text': {
        this.checkpoint();
        const layer = makeLayer('text', p.x, p.y, { font: this.lastFont, fill: solid(this.toolColour) } as Partial<TextLayer>);
        this.doc.layers.push(layer);
        this.setTool('select');
        this.select([layer.id]);
        this.commit();
        // Start typing straight away.
        const field = this.propsEl.querySelector('textarea');
        field?.focus();
        field?.select();
        return;
      }
      case 'pen': {
        if (this.pen.length >= 3) {
          const first = this.toScreen(this.pen[0].x, this.pen[0].y);
          if (Math.hypot(first.x - screen.x, first.y - screen.y) < 9) {
            this.finishPen(true);
            return;
          }
        }
        this.pen.push({ x: p.x, y: p.y });
        this.drag = base('pen-handle', { node: this.pen.length - 1 });
        this.requestDraw();
        return;
      }
      case 'brush':
        this.brushPts = [[p.x, p.y]];
        this.drag = base('brush');
        return;
      case 'mirror':
        this.drag = base('mirror-box');
        return;
    }
  }

  private onMove(e: PointerEvent): void {
    const p = this.toDesign(e);
    this.hover = p;
    const d = this.drag;
    if (!d) {
      this.updateCursor(e);
      if (this.pen.length) this.requestDraw();
      return;
    }
    const r = this.canvas.getBoundingClientRect();
    const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
    switch (d.kind) {
      case 'pan':
        this.panX = d.pan!.x + screen.x - d.screen.x;
        this.panY = d.pan!.y + screen.y - d.screen.y;
        break;
      case 'move': {
        if (!d.moved) {
          if (Math.hypot(screen.x - d.screen.x, screen.y - d.screen.y) < 3) return;
          this.checkpoint();
          d.moved = true;
        }
        let dx = p.x - d.start.x;
        let dy = p.y - d.start.y;
        if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
        const moved = [...d.originals.values()];
        if (this.snap && !e.altKey && moved.length) {
          const s = this.snapDelta(moved, dx, dy);
          dx = s.dx;
          dy = s.dy;
        } else this.guides = {};
        for (const o of moved) {
          const l = this.layer(o.id);
          if (l) ((l.x = o.x + dx), (l.y = o.y + dy));
        }
        this.commit(false);
        break;
      }
      case 'rotate': {
        const l = d.layer!;
        const o = d.originals.get(l.id)!;
        const a0 = Math.atan2(d.start.y - o.y, d.start.x - o.x);
        const a1 = Math.atan2(p.y - o.y, p.x - o.x);
        let deg = o.rotation + ((a1 - a0) * 180) / Math.PI;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        l.rotation = ((((deg + 180) % 360) + 360) % 360) - 180;
        this.commit(false);
        break;
      }
      case 'scale':
        this.scaleLayer(d, p, e.shiftKey);
        this.commit(false);
        break;
      case 'scale-multi': {
        // Proportional, about the opposite corner of the combined box.
        const b = d.box!;
        const [u, v] = HANDLE_POS[d.handle as Exclude<Handle, 'rotate'>];
        const hx = b.x + u * b.w;
        const hy = b.y + v * b.h;
        const ax = b.x + (1 - u) * b.w;
        const ay = b.y + (1 - v) * b.h;
        const len2 = (hx - ax) ** 2 + (hy - ay) ** 2 || 1;
        const k = Math.max(0.02, ((p.x - ax) * (hx - ax) + (p.y - ay) * (hy - ay)) / len2);
        for (const o of d.originals.values()) {
          const l = this.layer(o.id);
          if (l) scaleCopy(l, o, k, ax, ay);
        }
        this.commit(false);
        break;
      }
      case 'rotate-multi': {
        const b = d.box!;
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        let deg = ((Math.atan2(p.y - cy, p.x - cx) - Math.atan2(d.start.y - cy, d.start.x - cx)) * 180) / Math.PI;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        const r = (deg * Math.PI) / 180;
        for (const o of d.originals.values()) {
          const l = this.layer(o.id);
          if (!l) continue;
          const dx = o.x - cx;
          const dy = o.y - cy;
          l.x = cx + dx * Math.cos(r) - dy * Math.sin(r);
          l.y = cy + dx * Math.sin(r) + dy * Math.cos(r);
          l.rotation = ((((o.rotation + deg + 180) % 360) + 360) % 360) - 180;
        }
        this.commit(false);
        break;
      }
      case 'create': {
        const l = d.layer!;
        let x1 = p.x;
        let y1 = p.y;
        if (l.type === 'path') {
          // Line: from the start point, Shift snaps to 45°.
          let dx = x1 - d.start.x;
          let dy = y1 - d.start.y;
          if (e.shiftKey) {
            const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
            const len = Math.hypot(dx, dy);
            dx = Math.cos(a) * len;
            dy = Math.sin(a) * len;
          }
          l.x = d.start.x + dx / 2;
          l.y = d.start.y + dy / 2;
          l.points = [{ x: -dx / 2, y: -dy / 2 }, { x: dx / 2, y: dy / 2 }];
        } else if ('w' in l) {
          if (e.shiftKey) {
            const s = Math.max(Math.abs(x1 - d.start.x), Math.abs(y1 - d.start.y));
            x1 = d.start.x + Math.sign(x1 - d.start.x || 1) * s;
            y1 = d.start.y + Math.sign(y1 - d.start.y || 1) * s;
          }
          l.w = Math.max(1, Math.abs(x1 - d.start.x));
          l.h = Math.max(1, Math.abs(y1 - d.start.y));
          l.x = (x1 + d.start.x) / 2;
          l.y = (y1 + d.start.y) / 2;
        }
        this.requestDraw();
        break;
      }
      case 'brush': {
        const last = this.brushPts[this.brushPts.length - 1];
        if (Math.hypot(p.x - last[0], p.y - last[1]) > 2 / this.zoom) this.brushPts.push([p.x, p.y]);
        break;
      }
      case 'pen-handle': {
        const pt = this.pen[d.node!];
        const dx = p.x - pt.x;
        const dy = p.y - pt.y;
        if (Math.hypot(dx, dy) * this.zoom > 3) {
          pt.out = { x: dx, y: dy };
          pt.in = { x: -dx, y: -dy };
        }
        break;
      }
      case 'mirror-box':
        break;
      case 'mirror-end':
      case 'mirror-line':
      case 'mirror-vertex':
      case 'pin-a':
      case 'pin-b': {
        const m = this.activeMirror;
        const o = d.mirror!;
        if (!m) break;
        const dx = p.x - d.start.x;
        const dy = p.y - d.start.y;
        const i = d.node!;
        if (d.kind === 'mirror-line') m.line = [{ x: o.line[0].x + dx, y: o.line[0].y + dy }, { x: o.line[1].x + dx, y: o.line[1].y + dy }];
        else if (d.kind === 'mirror-end') {
          let q = { x: p.x, y: p.y };
          const other = o.line[1 - i];
          // Shift: level or upright.
          if (e.shiftKey) q = Math.abs(q.x - other.x) > Math.abs(q.y - other.y) ? { x: q.x, y: other.y } : { x: other.x, y: q.y };
          if (Math.hypot(q.x - other.x, q.y - other.y) > 4) m.line[i] = q;
        } else if (d.kind === 'mirror-vertex') m.area[i] = { x: Math.max(0, Math.min(DESIGN_SIZE, p.x)), y: Math.max(0, Math.min(DESIGN_SIZE, p.y)) };
        else if (d.kind === 'pin-a') m.pins[i].a = { x: o.pins[i].a.x + dx, y: o.pins[i].a.y + dy };
        else m.pins[i].b = { x: o.pins[i].b.x + dx, y: o.pins[i].b.y + dy };
        this.commit(false);
        break;
      }
      case 'node':
      case 'handle-in':
      case 'handle-out': {
        const l = d.layer!;
        const local = layerMatrix(l).inverse().transformPoint(new DOMPoint(p.x, p.y));
        const pt = editablePoints(l)![d.node!];
        if (d.kind === 'node') {
          pt.x = local.x;
          pt.y = local.y;
        } else {
          const hd = { x: local.x - pt.x, y: local.y - pt.y };
          const other = d.kind === 'handle-in' ? 'out' : 'in';
          pt[d.kind === 'handle-in' ? 'in' : 'out'] = hd;
          // Smooth points keep their handles in line (Alt breaks them).
          if (!e.altKey && pt[other]) {
            const len = Math.hypot(pt[other]!.x, pt[other]!.y);
            const hl = Math.hypot(hd.x, hd.y) || 1;
            pt[other] = { x: (-hd.x / hl) * len, y: (-hd.y / hl) * len };
          }
        }
        this.commit(false);
        break;
      }
    }
    this.requestDraw();
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    this.drag = undefined;
    this.guides = {};
    if (!d) return;
    if (d.kind === 'mirror-box') {
      this.createMirror(d.start, this.toDesign(e));
    } else if (['mirror-end', 'mirror-line', 'mirror-vertex', 'pin-a', 'pin-b'].includes(d.kind)) {
      this.commit();
    } else if (d.kind === 'create') {
      const l = d.layer!;
      // A click without dragging makes a default-sized shape.
      const tiny = Math.hypot(e.clientX - this.canvas.getBoundingClientRect().left - d.screen.x, e.clientY - this.canvas.getBoundingClientRect().top - d.screen.y) < 4;
      if (tiny) {
        if (l.type === 'path') l.points = [{ x: -150, y: 0 }, { x: 150, y: 0 }];
        else if ('w' in l) Object.assign(l, l.type === 'rect' ? { w: 400, h: 200 } : { w: 300, h: 300 });
      }
      this.setTool('select');
      this.select([l.id]);
      this.commit();
    } else if (d.kind === 'brush') {
      const pts = simplify(this.brushPts, 1.2 / this.zoom);
      this.brushPts = [];
      if (pts.length) {
        this.checkpoint();
        const xs = pts.map((q) => q[0]);
        const ys = pts.map((q) => q[1]);
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
        const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
        const layer = makeLayer('brush', cx, cy, { points: pts.map(([x, y]) => [x - cx, y - cy]), stroke: { ...this.newStroke(), width: this.brushSize } } as Partial<Layer>);
        this.doc.layers.push(layer);
        this.selection = new Set([layer.id]);
        this.commit();
      }
    } else if (d.kind === 'marquee' && this.hover) {
      const x0 = Math.min(d.start.x, this.hover.x);
      const x1 = Math.max(d.start.x, this.hover.x);
      const y0 = Math.min(d.start.y, this.hover.y);
      const y1 = Math.max(d.start.y, this.hover.y);
      if ((x1 - x0) * this.zoom > 3 || (y1 - y0) * this.zoom > 3) {
        const inside = this.doc.layers.filter((l) => {
          if (!l.visible || l.locked) return false;
          const b = layerBounds(l);
          return b.x >= x0 && b.y >= y0 && b.x + b.w <= x1 && b.y + b.h <= y1;
        });
        this.select([...(e.shiftKey ? this.selection : []), ...inside.map((l) => l.id)]);
      }
    } else if (['move', 'scale', 'rotate', 'scale-multi', 'rotate-multi', 'node', 'handle-in', 'handle-out'].includes(d.kind)) {
      this.commit();
    }
    this.requestDraw();
  }

  private onDoubleClick(e: MouseEvent): void {
    if (this.tool === 'pen') {
      // The double-click's two clicks added a point each; drop the extra one.
      this.pen.pop();
      this.finishPen(false);
      return;
    }
    const p = this.toDesign(e);
    const hit = this.hitTop(p);
    if (hit && editablePoints(hit)) {
      this.nodeEdit = hit.id;
      this.select([hit.id]);
      this.host.status('Editing points: drag them or their handles (Alt breaks a smooth point). Delete removes the selected point. Esc when done.');
    } else if (hit?.type === 'text') {
      const field = this.propsEl.querySelector('textarea');
      field?.focus();
      field?.select();
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) this.setZoom(this.zoom * Math.pow(1.0015, -e.deltaY), { x: e.clientX - r.left, y: e.clientY - r.top });
    else {
      this.panX -= e.deltaX;
      this.panY -= e.deltaY;
      this.requestDraw();
    }
  }

  private updateCursor(e: PointerEvent): void {
    const r = this.canvas.getBoundingClientRect();
    const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
    let cursor = 'default';
    if (this.tool === 'hand' || this.spaceDown) cursor = 'grab';
    else if (this.tool === 'text') cursor = 'text';
    else if (this.tool === 'select' && this.mirrorHit(screen)) cursor = this.mirrorHit(screen)!.kind === 'mirror-line' ? 'move' : 'pointer';
    else if (this.tool === 'select' && this.pinMode) cursor = 'crosshair';
    else if (this.tool !== 'select') cursor = 'crosshair';
    else {
      const sel = this.selected;
      const list = sel.length === 1 && !sel[0].locked ? this.handlePositions(sel[0]) : sel.length > 1 ? this.multiHandles(sel) : [];
      const handle = list.find(([, hp]) => Math.hypot(hp.x - screen.x, hp.y - screen.y) <= HANDLE + 2)?.[0];
      if (handle === 'rotate') cursor = 'grab';
      else if (handle) cursor = ['n', 's'].includes(handle) ? 'ns-resize' : ['e', 'w'].includes(handle) ? 'ew-resize' : ['nw', 'se'].includes(handle) ? 'nwse-resize' : 'nesw-resize';
      else if (this.hitTop(this.toDesign(e))) cursor = 'move';
    }
    this.canvas.style.cursor = cursor;
  }

  private hitNode(l: Layer, screen: { x: number; y: number }): { index: number; part: 'node' | 'in' | 'out' } | undefined {
    const m = layerMatrix(l);
    const sp = (x: number, y: number) => {
      const d = m.transformPoint(new DOMPoint(x, y));
      return this.toScreen(d.x, d.y);
    };
    const points = editablePoints(l) ?? [];
    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      for (const part of ['in', 'out'] as const) {
        const hd = pt[part];
        if (!hd) continue;
        const q = sp(pt.x + hd.x, pt.y + hd.y);
        if (Math.hypot(q.x - screen.x, q.y - screen.y) < 7) return { index: i, part };
      }
      const q = sp(pt.x, pt.y);
      if (Math.hypot(q.x - screen.x, q.y - screen.y) < 7) return { index: i, part: 'node' };
    }
    return undefined;
  }

  /** Scales about the opposite handle, in the layer's own frame. */
  private scaleLayer(d: Drag, p: { x: number; y: number }, keepRatio: boolean): void {
    const l = d.layer!;
    const o = d.originals.get(l.id)!;
    const b = localBox(o);
    const [u, v] = HANDLE_POS[d.handle as Exclude<Handle, 'rotate'>];
    const hx = b.x + u * b.w;
    const hy = b.y + v * b.h;
    const ax = b.x + (1 - u) * b.w;
    const ay = b.y + (1 - v) * b.h;
    const local = layerMatrix(o).inverse().transformPoint(new DOMPoint(p.x, p.y));
    let rx = u === 0.5 ? 1 : (local.x - ax) / (hx - ax || 1);
    let ry = v === 0.5 ? 1 : (local.y - ay) / (hy - ay || 1);
    const corner = u !== 0.5 && v !== 0.5;
    if (keepRatio || (corner && (o.type === 'text' || o.type === 'image'))) {
      if (corner) {
        const s = Math.max(Math.abs(rx), Math.abs(ry));
        rx = Math.sign(rx || 1) * s;
        ry = Math.sign(ry || 1) * s;
      }
    }
    const clamp = (r: number) => (Math.abs(r) < 0.01 ? 0.01 * (Math.sign(r) || 1) : r);
    rx = clamp(rx);
    ry = clamp(ry);
    const pos = layerMatrix(o).transformPoint(new DOMPoint(ax * (1 - rx), ay * (1 - ry)));
    l.x = pos.x;
    l.y = pos.y;
    if (l.type === 'rect' || l.type === 'ellipse' || l.type === 'polygon' || l.type === 'image') {
      const ow = o as typeof l;
      l.w = ow.w * Math.abs(rx);
      l.h = ow.h * Math.abs(ry);
      l.sx = o.sx * Math.sign(rx);
      l.sy = o.sy * Math.sign(ry);
    } else {
      l.sx = o.sx * rx;
      l.sy = o.sy * ry;
    }
  }

  /** Snaps a move to the canvas centre/edges and other layers' edges and centres. */
  private snapDelta(moved: Layer[], dx: number, dy: number): { dx: number; dy: number } {
    const ids = new Set(moved.map((l) => l.id));
    const box = union(moved.map(layerBounds));
    const xs = [0, DESIGN_SIZE / 2, DESIGN_SIZE];
    const ys = [0, DESIGN_SIZE / 2, DESIGN_SIZE];
    for (const l of this.doc.layers) {
      if (ids.has(l.id) || !l.visible) continue;
      const b = layerBounds(l);
      xs.push(b.x, b.x + b.w / 2, b.x + b.w);
      ys.push(b.y, b.y + b.h / 2, b.y + b.h);
    }
    const tol = 7 / this.zoom;
    const best = (edges: number[], targets: number[]) => {
      let found: { delta: number; at: number } | undefined;
      for (const e of edges) for (const t of targets) if (Math.abs(t - e) < tol && (!found || Math.abs(t - e) < Math.abs(found.delta))) found = { delta: t - e, at: t };
      return found;
    };
    const sx = best([box.x + dx, box.x + box.w / 2 + dx, box.x + box.w + dx], xs);
    const sy = best([box.y + dy, box.y + box.h / 2 + dy, box.y + box.h + dy], ys);
    this.guides = { x: sx?.at, y: sy?.at };
    return { dx: dx + (sx?.delta ?? 0), dy: dy + (sy?.delta ?? 0) };
  }

  private finishPen(closed: boolean): void {
    const pts = this.pen;
    this.pen = [];
    if (pts.length < 2) {
      this.requestDraw();
      return;
    }
    this.checkpoint();
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const layer = makeLayer('path', cx, cy, {
      name: closed ? 'Shape' : 'Path',
      closed,
      points: pts.map((p) => ({ ...p, x: p.x - cx, y: p.y - cy })),
      fill: closed ? solid(this.toolColour) : { kind: 'none' },
      ...(closed ? {} : { stroke: { ...this.newStroke(), width: 16 } }),
    } as Partial<PathLayer>);
    this.doc.layers.push(layer);
    this.setTool('select');
    this.select([layer.id]);
    this.commit();
  }

  private newStroke(): Stroke {
    return { paint: solid(this.toolColour), width: 8, join: 'round', cap: 'round', dash: 0, behind: false };
  }

  // -- keyboard -----------------------------------------------------------------------------

  private typing(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    if (!t || !this.el.isConnected || document.querySelector('.lightbox')) return true;
    if (t.isContentEditable || t.tagName === 'TEXTAREA') return true;
    return t.tagName === 'INPUT' && !['range', 'checkbox', 'color', 'button'].includes((t as HTMLInputElement).type);
  }

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === ' ') {
      this.spaceDown = false;
      this.canvas.style.cursor = '';
    }
  };

  private readonly onKey = (e: KeyboardEvent): void => {
    if (this.typing(e)) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const sel = this.selected;
    let handled = true;
    if (e.key === ' ') {
      this.spaceDown = true;
      this.canvas.style.cursor = 'grab';
    } else if (mod && key === 'z') this.undo(e.shiftKey);
    else if (mod && key === 'y') this.undo(true);
    else if (mod && key === 'a') this.select(this.doc.layers.filter((l) => !l.locked && l.visible).map((l) => l.id));
    else if (mod && key === 'd') this.duplicate();
    else if (mod && key === 'g') (e.shiftKey ? this.ungroup() : this.group());
    else if (mod && key === 'c') this.clipboard = sel.map(cloneLayer);
    else if (mod && key === 'x') ((this.clipboard = sel.map(cloneLayer)), this.remove());
    else if (mod && key === 'v') this.paste();
    else if (mod && e.key === ']') this.arrange(e.shiftKey ? 'front' : 'forward');
    else if (mod && e.key === '[') this.arrange(e.shiftKey ? 'back' : 'backward');
    else if (mod && (key === '=' || key === '+')) this.setZoom(this.zoom * 1.25);
    else if (mod && key === '-') this.setZoom(this.zoom / 1.25);
    else if (mod && key === '0') this.fit();
    else if (mod) handled = false;
    else if ((e.key === 'Delete' || e.key === 'Backspace') && this.activeMirror && !sel.length) {
      if (this.selectedPin !== undefined) this.removePin();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      const edit = this.nodeEdit ? this.layer(this.nodeEdit) : undefined;
      const pts = edit && editablePoints(edit);
      if (pts && this.selectedNode !== undefined && pts.length > 2) {
        this.checkpoint();
        pts.splice(this.selectedNode, 1);
        this.selectedNode = undefined;
        this.commit();
      } else this.remove();
    } else if (e.key === 'Escape') {
      if (this.pen.length) this.finishPen(false);
      else if (this.nodeEdit) ((this.nodeEdit = undefined), (this.selectedNode = undefined), this.host.status(''), this.requestDraw());
      else if (this.tool !== 'select') this.setTool('select');
      else if (this.pinMode) ((this.pinMode = false), this.host.status(''), this.renderProps(), this.requestDraw());
      else if (this.mirrorSel) this.selectMirror(undefined);
      else this.select([]);
    } else if (e.key === 'Enter') {
      if (this.pen.length) this.finishPen(false);
      else if (sel.length === 1 && editablePoints(sel[0])) ((this.nodeEdit = sel[0].id), this.requestDraw());
      else handled = false;
    } else if (e.key.startsWith('Arrow') && sel.length) {
      const step = e.shiftKey ? 10 : 1;
      this.checkpoint('nudge');
      for (const l of sel) {
        if (l.locked) continue;
        if (e.key === 'ArrowLeft') l.x -= step;
        if (e.key === 'ArrowRight') l.x += step;
        if (e.key === 'ArrowUp') l.y -= step;
        if (e.key === 'ArrowDown') l.y += step;
      }
      this.commit();
    } else {
      const t = TOOLS.find((x) => x.key.toLowerCase() === key);
      if (t) this.setTool(t.tool);
      else handled = false;
    }
    if (handled) e.preventDefault();
  };

  // -- layer operations --------------------------------------------------------------------

  private setTool(tool: Tool): void {
    if (this.pen.length && tool !== 'pen') this.finishPen(false);
    this.tool = tool;
    this.nodeEdit = undefined;
    if (tool === 'mirror') this.host.status('Drag a box around one piece of the template (for a piece that is its own mirror image, like a bumper, box the whole piece starting on the side you’ll draw on).');
    this.renderMirrors();
    this.renderToolbar();
    this.renderTopbar();
    this.requestDraw();
  }

  private duplicate(): void {
    const sel = this.selected;
    if (!sel.length) return;
    this.checkpoint();
    const copies = this.regroup(sel.map((l) => ({ ...cloneLayer(l), id: newId(), name: `${l.name} copy`, x: l.x + 24, y: l.y + 24 })));
    const top = Math.max(...sel.map((l) => this.doc.layers.indexOf(l)));
    this.doc.layers.splice(top + 1, 0, ...copies);
    this.select(copies.map((l) => l.id));
    this.commit();
  }

  /** Copies of grouped layers form new groups of their own. */
  private regroup(copies: Layer[]): Layer[] {
    const ids = new Map<string, string>();
    this.doc.groups ??= {};
    for (const l of copies) {
      if (!l.group) continue;
      if (!ids.has(l.group)) {
        const id = newId();
        ids.set(l.group, id);
        this.doc.groups[id] = { name: `${this.doc.groups[l.group]?.name ?? 'Group'} copy` };
      }
      l.group = ids.get(l.group);
    }
    return copies;
  }

  /** Groups the selected layers (Ctrl/Cmd G), keeping them together in the layer order. */
  private group(): void {
    const sel = this.selected;
    if (sel.length < 2) return;
    this.checkpoint();
    const id = newId();
    this.doc.groups ??= {};
    this.doc.groups[id] = { name: `Group ${Object.keys(this.doc.groups).length + 1}` };
    const top = Math.max(...sel.map((l) => this.doc.layers.indexOf(l)));
    const rest = this.doc.layers.filter((l) => !this.selection.has(l.id));
    const at = rest.indexOf(this.doc.layers[top + 1]);
    sel.forEach((l) => (l.group = id));
    rest.splice(at < 0 ? rest.length : at, 0, ...sel);
    this.doc.layers = rest;
    this.commit();
  }

  /** Ungroups the selection (Ctrl/Cmd Shift G). */
  private ungroup(): void {
    const sel = this.selected.filter((l) => l.group);
    if (!sel.length) return;
    this.checkpoint();
    sel.forEach((l) => delete l.group);
    this.commit();
  }

  /** Puts the selected text on the selected path (the path becomes the text's own, the path layer is hidden). */
  private putOnPath(text: TextLayer, path: PathLayer): void {
    this.checkpoint();
    const c = layerMatrix(text).inverse().multiply(layerMatrix(path));
    const map = (x: number, y: number) => c.transformPoint(new DOMPoint(x, y));
    text.path = path.points.map((pt) => {
      const p = map(pt.x, pt.y);
      const v = (hd?: { x: number; y: number }) => {
        if (!hd) return undefined;
        const q = map(pt.x + hd.x, pt.y + hd.y);
        return { x: q.x - p.x, y: q.y - p.y };
      };
      return { x: p.x, y: p.y, ...(pt.in ? { in: v(pt.in) } : {}), ...(pt.out ? { out: v(pt.out) } : {}) };
    });
    text.pathStart ??= 0.5;
    text.arc = 0;
    path.visible = false;
    this.select([text.id]);
    this.host.status('The text follows the path now; the path layer is hidden. Double-click the text to reshape its path.');
    this.commit();
  }

  private paste(): void {
    if (!this.clipboard.length) return;
    this.checkpoint();
    const copies = this.regroup(this.clipboard.map((l) => ({ ...cloneLayer(l), id: newId(), x: l.x + 24, y: l.y + 24 })));
    this.clipboard = copies.map(cloneLayer);
    this.doc.layers.push(...copies);
    this.select(copies.map((l) => l.id));
    this.commit();
  }

  private remove(): void {
    const sel = this.selected.filter((l) => !l.locked);
    if (!sel.length) return;
    this.checkpoint();
    const gone = new Set(sel.map((l) => l.id));
    this.doc.layers = this.doc.layers.filter((l) => !gone.has(l.id));
    this.select([]);
    this.commit();
  }

  private arrange(where: 'front' | 'back' | 'forward' | 'backward'): void {
    const sel = this.selected;
    if (!sel.length) return;
    this.checkpoint();
    const ids = new Set(sel.map((l) => l.id));
    const rest = this.doc.layers.filter((l) => !ids.has(l.id));
    if (where === 'front') this.doc.layers = [...rest, ...sel];
    else if (where === 'back') this.doc.layers = [...sel, ...rest];
    else {
      const layers = this.doc.layers;
      const order = where === 'forward' ? [...layers.keys()].reverse() : [...layers.keys()];
      for (const i of order) {
        const j = where === 'forward' ? i + 1 : i - 1;
        if (!ids.has(layers[i].id) || j < 0 || j >= layers.length || ids.has(layers[j].id)) continue;
        [layers[i], layers[j]] = [layers[j], layers[i]];
      }
    }
    this.commit();
  }

  /** Flips the selection in place, or makes a mirrored copy on the other half of the canvas. */
  private mirror(axis: 'x' | 'y', copy: boolean): void {
    const sel = this.selected.filter((l) => !l.locked);
    if (!sel.length) return;
    this.checkpoint();
    const out: Layer[] = [];
    for (const l of sel) {
      const t = copy ? { ...cloneLayer(l), id: newId(), name: `${l.name} (mirrored)` } : l;
      if (axis === 'x') {
        t.sx = -t.sx;
        t.rotation = -t.rotation;
        if (copy) t.x = DESIGN_SIZE - t.x;
      } else {
        t.sy = -t.sy;
        t.rotation = -t.rotation;
        if (copy) t.y = DESIGN_SIZE - t.y;
      }
      if (copy) out.push(t);
    }
    if (copy) {
      this.doc.layers.push(...out);
      this.select(out.map((l) => l.id));
    }
    this.commit();
  }

  private align(how: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'): void {
    const sel = this.selected.filter((l) => !l.locked);
    if (!sel.length) return;
    this.checkpoint();
    // One layer aligns to the canvas, several to their combined bounds.
    const target: Box = sel.length === 1 ? { x: 0, y: 0, w: DESIGN_SIZE, h: DESIGN_SIZE } : union(sel.map(layerBounds));
    for (const l of sel) {
      const b = layerBounds(l);
      if (how === 'left') l.x += target.x - b.x;
      if (how === 'hcenter') l.x += target.x + target.w / 2 - (b.x + b.w / 2);
      if (how === 'right') l.x += target.x + target.w - (b.x + b.w);
      if (how === 'top') l.y += target.y - b.y;
      if (how === 'vcenter') l.y += target.y + target.h / 2 - (b.y + b.h / 2);
      if (how === 'bottom') l.y += target.y + target.h - (b.y + b.h);
    }
    this.commit();
  }

  private async addFont(apply?: TextLayer): Promise<void> {
    const file = await this.host.pickFont();
    if (!file) return;
    const family = familyFromFileName(file.name);
    try {
      await loadFont(family, file.data);
      this.doc.fonts[family] = bytesToBase64(file.data);
      if (apply) {
        this.checkpoint();
        apply.font = family;
        this.lastFont = family;
      }
      this.host.status(`Added the font ${family}; it's stored in the design.`);
      this.commit();
    } catch (err) {
      this.host.status(`Couldn't use ${file.name} as a font: ${(err as Error).message}`);
    }
  }

  // -- UI -------------------------------------------------------------------------------------

  private renderToolbar(): void {
    this.toolbar.replaceChildren(
      ...TOOLS.map((t) =>
        h('button', { class: `designer-tool${t.tool === this.tool ? ' active' : ''}`, title: `${t.label} (${t.key})`, onclick: () => this.setTool(t.tool) }, t.icon)
      ),
      h('div', { class: 'designer-tool-sep' }),
      h('button', { class: 'designer-tool', title: 'Add an image (logo, badge…) as a layer', onclick: () => void this.importImage(false) }, '🖼'),
      h('button', { class: 'designer-tool', title: 'Add an image file as a layer that updates whenever you save it in your image app', onclick: () => void this.importImage(true) }, '⟳')
    );
  }

  private async importImage(follow: boolean): Promise<void> {
    const picked = await this.host.pickImage(follow);
    if (!picked) return;
    const url = await bytesToDataUrl(picked.name, picked.data);
    await this.addImage(picked.name, url, { linkId: picked.linkId });
  }

  private renderTopbar(): void {
    const btn = (label: string, title: string, onclick: () => void, active = false, disabled = false) => h('button', { class: `chip mini${active ? ' active' : ''}`, title, disabled, onclick }, label);
    const templateMode = h(
      'select',
      { title: 'UV template', onchange: () => ((this.templateMode = templateMode.value as typeof this.templateMode), this.requestDraw()) },
      h('option', { value: 'over', selected: this.templateMode === 'over' }, 'Template over'),
      h('option', { value: 'under', selected: this.templateMode === 'under' }, 'Template under'),
      h('option', { value: 'off', selected: this.templateMode === 'off' }, 'Template hidden')
    );
    const opacity = h('input', { type: 'range', min: 5, max: 100, value: Math.round(this.templateOpacity * 100), title: 'Template opacity' });
    opacity.addEventListener('input', () => ((this.templateOpacity = Number(opacity.value) / 100), this.requestDraw()));
    const colour = colourField(this.toolColour, (c) => (this.toolColour = c), 'Colour for new shapes, text and brush strokes', false);
    const brushSize = h('input', { type: 'number', min: 1, max: 400, value: this.brushSize, class: 'designer-num', title: 'Brush size' });
    brushSize.addEventListener('input', () => (this.brushSize = Math.max(1, Number(brushSize.value) || 1)));
    this.updateZoomLabel();
    this.topbar.replaceChildren(
      btn('−', `Zoom out (${MOD} −)`, () => this.setZoom(this.zoom / 1.25)),
      this.zoomLabel,
      btn('+', `Zoom in (${MOD} +; ${MOD} + scroll)`, () => this.setZoom(this.zoom * 1.25)),
      btn('Fit', `Fit the canvas (${MOD} 0)`, () => this.fit()),
      h('span', { class: 'designer-sep' }),
      ...(this.template ? [templateMode, opacity] : [h('span', { class: 'muted small' }, 'No UV template')]),
      btn('Grid', 'Show a 16×16 grid', () => ((this.grid = !this.grid), this.renderTopbar(), this.requestDraw()), this.grid),
      btn('Snap', 'Snap to the canvas centre and other layers while moving (hold Alt to stop)', () => ((this.snap = !this.snap), this.renderTopbar()), this.snap),
      h('span', { class: 'designer-sep' }),
      h('span', { class: 'small muted' }, 'New:'),
      colour,
      ...(this.tool === 'brush' ? [h('span', { class: 'small muted' }, 'Size'), brushSize] : []),
      h('span', { class: 'spacer' }),
      btn('↶', `Undo (${MOD} Z)`, () => this.undo(), false, !this.undoStack.length),
      btn('↷', `Redo (${MOD} Shift Z)`, () => this.undo(true), false, !this.redoStack.length)
    );
  }

  renderPanels(): void {
    this.renderMirrors();
    this.renderLayers();
    this.renderProps();
  }

  private layerRow(l: Layer, icon: Record<LayerType, string>, setDrag: (id: string) => void, getDrag: () => string | undefined): HTMLElement {
      const name = h('span', { class: 'designer-layer-name', title: 'Double-click to rename' }, l.name);
      name.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const input = h('input', { type: 'text', value: l.name, class: 'designer-rename' });
        const done = () => {
          if (input.value.trim() && input.value !== l.name) {
            this.checkpoint();
            l.name = input.value.trim();
          }
          this.commit();
        };
        input.addEventListener('keydown', (k) => (k.key === 'Enter' ? done() : k.key === 'Escape' ? this.renderLayers() : undefined));
        input.addEventListener('blur', done);
        name.replaceWith(input);
        input.focus();
        input.select();
      });
      const row = h(
        'div',
        {
          class: `designer-layer${this.selection.has(l.id) ? ' active' : ''}${l.visible ? '' : ' hidden'}`,
          draggable: true,
          onclick: (e: MouseEvent) => {
            if (e.shiftKey || e.ctrlKey || e.metaKey) {
              const next = new Set(this.selection);
              if (next.has(l.id)) next.delete(l.id);
              else next.add(l.id);
              this.select([...next]);
            } else this.select([l.id]);
          },
        },
        h(
          'button',
          { class: 'designer-icon', title: l.visible ? 'Hide' : 'Show', onclick: (e: Event) => (e.stopPropagation(), this.checkpoint(), (l.visible = !l.visible), this.commit()) },
          l.visible ? '👁' : '◌'
        ),
        h(
          'button',
          { class: 'designer-icon', title: l.locked ? 'Unlock' : 'Lock (can’t be selected on the canvas)', onclick: (e: Event) => (e.stopPropagation(), this.checkpoint(), (l.locked = !l.locked), this.commit()) },
          l.locked ? '🔒' : '🔓'
        ),
        h('span', { class: 'designer-layer-type' }, l.clip ? '↳' : icon[l.type]),
        name
      );
      row.addEventListener('dragstart', () => setDrag(l.id));
      row.addEventListener('dragover', (e) => e.preventDefault());
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        const dragId = getDrag();
        if (!dragId || dragId === l.id) return;
        const moving = this.layer(dragId);
        if (!moving) return;
        this.checkpoint();
        // Dropping next to a grouped layer puts it in that group (or out of one).
        if (l.group) moving.group = l.group;
        else delete moving.group;
        this.doc.layers = this.doc.layers.filter((x) => x !== moving);
        // Rows are top-first: dropping on a row puts the layer just above it.
        this.doc.layers.splice(this.doc.layers.indexOf(l) + 1, 0, moving);
        this.commit();
      });
      row.classList.toggle('grouped', !!l.group);
      return row;
  }

  private renderLayers(): void {
    const icon: Record<LayerType, string> = { rect: '▭', ellipse: '◯', polygon: '★', path: '✒', brush: '🖌', text: 'T', image: '🖼' };
    let dragId: string | undefined;
    const groups = (this.doc.groups ??= {});
    const rows: HTMLElement[] = [];
    let lastGroup: string | undefined;
    for (const l of [...this.doc.layers].reverse()) {
      if (l.group && l.group !== lastGroup) {
        const g = (groups[l.group] ??= { name: 'Group' });
        const members = this.doc.layers.filter((x) => x.group === l.group);
        const gid = l.group;
        const gname = h('span', { class: 'designer-layer-name', title: 'Double-click to rename the group' }, g.name);
        gname.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          const input = h('input', { type: 'text', value: g.name, class: 'designer-rename' });
          const done = () => ((g.name = input.value.trim() || g.name), this.commit());
          input.addEventListener('keydown', (k) => (k.key === 'Enter' ? done() : undefined));
          input.addEventListener('blur', done);
          gname.replaceWith(input);
          input.focus();
          input.select();
        });
        rows.push(
          h(
            'div',
            { class: `designer-layer designer-group${members.every((m) => this.selection.has(m.id)) ? ' active' : ''}`, onclick: () => this.select(members.filter((m) => !m.locked).map((m) => m.id)) },
            h('button', { class: 'designer-icon', title: g.collapsed ? 'Show the layers' : 'Fold', onclick: (e: Event) => (e.stopPropagation(), (g.collapsed = !g.collapsed), this.renderLayers()) }, g.collapsed ? '▸' : '▾'),
            h(
              'button',
              { class: 'designer-icon', title: 'Show / hide the group', onclick: (e: Event) => (e.stopPropagation(), this.checkpoint(), members.forEach((m) => (m.visible = !members.every((x) => x.visible))), this.commit()) },
              members.every((m) => m.visible) ? '👁' : '◌'
            ),
            h('span', { class: 'designer-layer-type' }, '▣'),
            gname,
            h('span', { class: 'small muted' }, String(members.length))
          )
        );
      }
      lastGroup = l.group;
      if (l.group && groups[l.group]?.collapsed) continue;
      rows.push(this.layerRow(l, icon, (id) => (dragId = id), () => dragId));
    }
    const sel = this.selected;

    const btn = (label: string, title: string, onclick: () => void) => h('button', { class: 'chip mini', title, disabled: !sel.length, onclick }, label);
    this.layersEl.replaceChildren(
      h('div', { class: 'designer-layer-list' }, rows.length ? rows : h('div', { class: 'muted small designer-empty' }, 'No layers yet: pick a tool on the left and draw on the canvas.')),
      h(
        'div',
        { class: 'row designer-layer-actions' },
        btn('↑', `Bring forward (${MOD} ])`, () => this.arrange('forward')),
        btn('↓', `Send backward (${MOD} [)`, () => this.arrange('backward')),
        btn('⧉', `Duplicate (${MOD} D)`, () => this.duplicate()),
        btn('⇋', 'Flip horizontally', () => this.mirror('x', false)),
        btn('⇅', 'Flip vertically', () => this.mirror('y', false)),
        btn('◧', 'Mirrored copy on the other side of the canvas', () => this.mirror('x', true)),
        btn('🗑', 'Delete (Del)', () => this.remove())
      ),
      h(
        'div',
        { class: 'row designer-layer-actions' },
        h('span', { class: 'small muted' }, 'Align'),
        btn('⇤', 'Align left (to the canvas, or to each other when several are selected)', () => this.align('left')),
        btn('↔', 'Centre horizontally', () => this.align('hcenter')),
        btn('⇥', 'Align right', () => this.align('right')),
        btn('⤒', 'Align top', () => this.align('top')),
        btn('↕', 'Centre vertically', () => this.align('vcenter')),
        btn('⤓', 'Align bottom', () => this.align('bottom'))
      )
    );
  }

  private renderProps(): void {
    const sel = this.selected;
    if (sel.length !== 1) {
      const am = this.activeMirror;
      if (!sel.length && am) return void this.renderMirrorProps(am);
      if (!sel.length) return void this.propsEl.replaceChildren(h('div', { class: 'small muted designer-help' }, helpText()));
      const texts = sel.filter((l): l is TextLayer => l.type === 'text');
      const paths = sel.filter((l): l is PathLayer => l.type === 'path');
      const grouped = sel.some((l) => l.group);
      this.propsEl.replaceChildren(
        h('div', { class: 'small muted' }, `${sel.length} layers selected. Drag the corners to resize them together, the round handle to rotate.`),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'chip mini', title: `Group (${MOD} G)`, onclick: () => this.group() }, 'Group'),
          grouped ? h('button', { class: 'chip mini', title: `Ungroup (${MOD} Shift G)`, onclick: () => this.ungroup() }, 'Ungroup') : null,
          texts.length === 1 && paths.length === 1 && sel.length === 2
            ? h('button', { class: 'chip mini active', title: 'Make the text run along the path', onclick: () => this.putOnPath(texts[0], paths[0]) }, 'Put text on path')
            : null
        ),
        h('div', { class: 'small muted' }, texts.length && paths.length && sel.length === 2 ? '' : 'Tip: select a text and a path (Shift-click) to put the text on the path.')
      );
      return;
    }
    const l = sel[0];
    const change = (group: string, fn: () => void, panels = false) => {
      this.checkpoint(`${group}:${l.id}`);
      fn();
      this.commit(panels);
    };
    const num = (label: string, get: () => number, set: (v: number) => void, opts: { step?: number; min?: number; max?: number; title?: string } = {}) => {
      const input = h('input', { type: 'number', class: 'designer-num', value: round(get()), step: opts.step ?? 1, ...(opts.min !== undefined ? { min: opts.min } : {}), ...(opts.max !== undefined ? { max: opts.max } : {}) });
      input.addEventListener('input', () => {
        const v = Number(input.value);
        if (Number.isFinite(v)) change(label, () => set(v));
      });
      return h('label', { class: 'designer-field', title: opts.title ?? label }, h('span', null, label), input);
    };
    const slider = (label: string, get: () => number, set: (v: number) => void, min: number, max: number, step = 1, unit = '') => {
      const out = h('span', { class: 'small muted designer-value' }, `${round(get())}${unit}`);
      const input = h('input', { type: 'range', min, max, step, value: get() });
      input.addEventListener('input', () => change(label, () => set(Number(input.value))));
      input.addEventListener('input', () => (out.textContent = `${round(Number(input.value))}${unit}`));
      return h('label', { class: 'designer-slider' }, h('span', null, label), input, out);
    };
    const check = (label: string, get: () => boolean, set: (v: boolean) => void, title?: string) => {
      const input = h('input', { type: 'checkbox', checked: get() });
      input.addEventListener('change', () => change(label, () => set(input.checked), true));
      return h('label', { class: 'toggle', title: title ?? label }, input, label);
    };
    const section = (title: string, ...body: (HTMLElement | null | false)[]) =>
      h('div', { class: 'designer-section' }, h('div', { class: 'designer-section-title' }, title), ...body.filter((x): x is HTMLElement => !!x));

    const sized = l.type === 'rect' || l.type === 'ellipse' || l.type === 'polygon' || l.type === 'image';
    const transform = section(
      'Position',
      h('div', { class: 'designer-grid' }, num('X', () => l.x, (v) => (l.x = v)), num('Y', () => l.y, (v) => (l.y = v))),
      sized
        ? h('div', { class: 'designer-grid' }, num('W', () => (l as { w: number }).w, (v) => ((l as { w: number }).w = Math.max(1, v)), { min: 1 }), num('H', () => (l as { h: number }).h, (v) => ((l as { h: number }).h = Math.max(1, v)), { min: 1 }))
        : h(
            'div',
            { class: 'designer-grid' },
            num('Scale X %', () => l.sx * 100, (v) => (l.sx = v / 100), { title: 'Horizontal scale (negative mirrors)' }),
            num('Scale Y %', () => l.sy * 100, (v) => (l.sy = v / 100), { title: 'Vertical scale (negative mirrors)' })
          ),
      h('div', { class: 'designer-grid' }, num('Rotate °', () => l.rotation, (v) => (l.rotation = v)), h('span'))
    );

    const appearance = section(
      'Layer',
      slider('Opacity', () => l.opacity * 100, (v) => (l.opacity = v / 100), 0, 100, 1, '%'),
      h(
        'label',
        { class: 'designer-field' },
        h('span', null, 'Blend'),
        (() => {
          const s = h('select', null, BLENDS.map(([v, n]) => h('option', { value: v, selected: l.blend === v }, n)));
          s.addEventListener('change', () => change('blend', () => (l.blend = s.value as Blend)));
          return s;
        })()
      ),
      check('Clip to the layer below', () => l.clip, (v) => (l.clip = v), 'Only show this layer where the layer below it is (e.g. stripes inside a shape)'),
      this.doc.mirrors?.length
        ? h(
            'label',
            { class: 'designer-field', title: 'How mirrors copy this layer onto the matching piece' },
            h('span', null, 'In mirrors'),
            (() => {
              const mode = mirrorMode(l);
              const s = h('select', null, MIRROR_MODES.map(([v, n, t]) => h('option', { value: v, selected: mode === v, title: t }, n)));
              s.addEventListener('change', () => change('mirror', () => (l.mirror = s.value as MirrorMode)));
              return s;
            })()
          )
        : null
    );

    const filled = !(l.type === 'brush' || l.type === 'image' || (l.type === 'path' && !l.closed));
    const fill = filled ? section('Fill', paintEditor(l.fill, (p, group) => change(group, () => (l.fill = p)), () => this.renderProps())) : null;

    const stroke = l.type === 'image'
      ? null
      : section(
          l.type === 'brush' ? 'Brush' : 'Outline',
          l.type === 'brush' ? null : check('Outline', () => !!l.stroke, (v) => (l.stroke = v ? { ...this.newStroke(), paint: solid('#000000'), width: 8, behind: l.type === 'text' } : undefined)),
          ...(l.stroke
            ? [
                paintEditor(l.stroke.paint, (p, group) => change(group, () => (l.stroke!.paint = p)), () => this.renderProps()),
                slider('Width', () => l.stroke!.width, (v) => (l.stroke!.width = v), 0, l.type === 'brush' ? 400 : 120, 1),
                h(
                  'div',
                  { class: 'row' },
                  (() => {
                    const s = h('select', { title: 'Corners' }, ['round', 'miter', 'bevel'].map((j) => h('option', { value: j, selected: l.stroke!.join === j }, `${j} corners`)));
                    s.addEventListener('change', () => change('join', () => (l.stroke!.join = s.value as CanvasLineJoin)));
                    return s;
                  })(),
                  (() => {
                    const s = h('select', { title: 'Line ends' }, ['round', 'butt', 'square'].map((j) => h('option', { value: j, selected: l.stroke!.cap === j }, `${j} ends`)));
                    s.addEventListener('change', () => change('cap', () => (l.stroke!.cap = s.value as CanvasLineCap)));
                    return s;
                  })()
                ),
                slider('Dashes', () => l.stroke!.dash, (v) => (l.stroke!.dash = v), 0, 200, 1),
                l.type === 'brush' ? null : check('Behind the fill', () => !!l.stroke!.behind, (v) => (l.stroke!.behind = v), 'Draw the outline under the fill, so a thick outline doesn’t eat into thin letters'),
              ]
            : [])
        );

    const shadow = section(
      'Shadow',
      check('Drop shadow', () => !!l.shadow, (v) => (l.shadow = v ? { colour: '#000000a0', blur: 12, dx: 8, dy: 8 } : undefined)),
      ...(l.shadow
        ? [
            colourField(l.shadow.colour, (c) => change('shadow-colour', () => (l.shadow!.colour = c)), 'Shadow colour'),
            slider('Blur', () => l.shadow!.blur, (v) => (l.shadow!.blur = v), 0, 100),
            h('div', { class: 'designer-grid' }, num('Offset X', () => l.shadow!.dx, (v) => (l.shadow!.dx = v)), num('Offset Y', () => l.shadow!.dy, (v) => (l.shadow!.dy = v))),
          ]
        : [])
    );

    let specific: HTMLElement | null = null;
    if (l.type === 'text') {
      const area = h('textarea', { class: 'designer-text', rows: 2, spellcheck: false }, l.text);
      area.addEventListener('input', () => change('text', () => (l.text = area.value || ' ')));
      const weight = h('select', null, [100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => h('option', { value: String(w), selected: l.weight === w }, `${w}${w === 400 ? ' regular' : w === 700 ? ' bold' : w === 900 ? ' black' : ''}`)));
      weight.addEventListener('change', () => change('weight', () => (l.weight = Number(weight.value))));
      const alignBtns = (['left', 'center', 'right'] as const).map((a) =>
        h('button', { class: `chip mini${l.align === a ? ' active' : ''}`, onclick: () => change('align', () => (l.align = a), true) }, a === 'left' ? '⇤' : a === 'center' ? '↔' : '⇥')
      );
      specific = section(
        'Text',
        area,
        fontPicker(l.font, (f) => change('font', () => ((l.font = f), (this.lastFont = f)), true), () => void this.addFont(l)),
        h('div', { class: 'designer-grid' }, num('Size', () => l.size, (v) => (l.size = Math.max(4, v)), { min: 4 }), h('label', { class: 'designer-field' }, h('span', null, 'Weight'), weight)),
        h('div', { class: 'row' }, check('Italic', () => l.italic, (v) => (l.italic = v)), h('span', { class: 'spacer' }), ...alignBtns),
        slider('Spacing', () => l.spacing, (v) => (l.spacing = v), -40, 200, 1),
        slider('Line height', () => l.lineHeight, (v) => (l.lineHeight = v), 0.6, 3, 0.05),
        l.path ? null : slider('Arc', () => l.arc, (v) => (l.arc = v), -360, 360, 1, '°'),
        slider('Stretch', () => (l.sx / (l.sy || 1)) * 100, (v) => (l.sx = (Math.sign(l.sx) || 1) * Math.abs(l.sy) * (v / 100)), 30, 300, 1, '%')
      );
      if (l.path) {
        specific.append(
          h('div', { class: 'designer-section-title' }, 'On a path'),
          slider('Start', () => (l.pathStart ?? 0.5) * 100, (v) => (l.pathStart = v / 100), 0, 100, 1, '%'),
          check('Other side', () => !!l.pathFlip, (v) => (l.pathFlip = v), 'Run the text the other way along the path, on its other side'),
          h(
            'div',
            { class: 'row' },
            h('button', { class: 'chip mini', onclick: () => ((this.nodeEdit = l.id), this.requestDraw()) }, 'Edit path'),
            h('button', { class: 'chip mini', onclick: () => change('path', () => ((l.path = undefined), (this.nodeEdit = undefined)), true) }, 'Straighten')
          )
        );
      }
    } else if (l.type === 'rect') {
      specific = section('Rectangle', slider('Corner radius', () => l.radius, (v) => (l.radius = v), 0, Math.max(10, Math.min(l.w, l.h) / 2)));
    } else if (l.type === 'polygon') {
      specific = section(
        'Star / polygon',
        check('Star', () => l.star, (v) => (l.star = v)),
        slider(l.star ? 'Points' : 'Sides', () => l.sides, (v) => (l.sides = v), 3, 24),
        l.star ? slider('Inner size', () => l.inner * 100, (v) => (l.inner = v / 100), 5, 95, 1, '%') : null
      );
    } else if (l.type === 'path') {
      specific = section(
        'Path',
        check('Closed shape', () => l.closed, (v) => (l.closed = v)),
        h('button', { class: 'chip mini', onclick: () => ((this.nodeEdit = l.id), this.requestDraw()) }, 'Edit points'),
        h('div', { class: 'small muted' }, 'Or double-click the path. Drag points and handles; Alt breaks a smooth point; Delete removes a point.')
      );
    } else if (l.type === 'image') {
      specific = section(
        'Image',
        h(
          'button',
          {
            class: 'chip mini',
            onclick: () => {
              const img = this.images.get(l.asset);
              if (img) change('aspect', () => (l.h = l.w * (img.height / Math.max(1, img.width))));
            },
          },
          'Original proportions'
        ),
        h('button', { class: 'chip mini', onclick: () => change('fill', () => Object.assign(l, { x: DESIGN_SIZE / 2, y: DESIGN_SIZE / 2, w: DESIGN_SIZE, h: DESIGN_SIZE, rotation: 0 })) }, 'Fill the canvas')
      );
    }
    this.propsEl.replaceChildren(specific ?? h('span'), fill ?? h('span'), stroke ?? h('span'), shadow, appearance, transform);
  }
}

// -- shared UI pieces ---------------------------------------------------------------------------

/** Editable points of a layer: a path's own, or the path text runs along. */
function editablePoints(l: Layer): PathPoint[] | undefined {
  return l.type === 'path' ? l.points : l.type === 'text' && l.path?.length ? l.path : undefined;
}

/** Sets `l` to `o` scaled by `k` about (ax, ay), sizes and effects included. */
function scaleCopy(l: Layer, o: Layer, k: number, ax: number, ay: number): void {
  l.x = ax + (o.x - ax) * k;
  l.y = ay + (o.y - ay) * k;
  if (l.type === 'rect' || l.type === 'ellipse' || l.type === 'polygon' || l.type === 'image') {
    const ow = o as typeof l;
    l.w = ow.w * k;
    l.h = ow.h * k;
    if (l.type === 'rect') l.radius = (o as typeof l).radius * k;
    // These shapes don't scale their outline and shadow with the frame, so scale them here.
    if (l.stroke && o.stroke) l.stroke.width = o.stroke.width * k;
    if (l.shadow && o.shadow) Object.assign(l.shadow, { blur: o.shadow.blur * k, dx: o.shadow.dx * k, dy: o.shadow.dy * k });
  } else {
    l.sx = o.sx * k;
    l.sy = o.sy * k;
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function union(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}

/** Ramer–Douglas–Peucker: fewer points along a stroke, same shape. */
function simplify(pts: [number, number][], epsilon: number): [number, number][] {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  let index = -1;
  let dist = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const d = Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
    if (d > dist) ((dist = d), (index = i));
  }
  if (dist <= epsilon) return [a, b];
  return [...simplify(pts.slice(0, index + 1), epsilon).slice(0, -1), ...simplify(pts.slice(index), epsilon)];
}

export async function bytesToDataUrl(name: string, data: Uint8Array): Promise<string> {
  const type = /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.webp$/i.test(name) ? 'image/webp' : /\.gif$/i.test(name) ? 'image/gif' : /\.bmp$/i.test(name) ? 'image/bmp' : 'image/png';
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([data.slice()], { type }));
  });
}

function helpText(): HTMLElement {
  return h(
    'div',
    null,
    h('div', null, 'Pick a tool on the left and draw on the canvas; select a layer to change its fill, outline, shadow and more.'),
    h(
      'ul',
      null,
      [
        'Drag to move; corner handles resize (Shift keeps proportions), the round handle rotates (Shift: 15° steps)',
        'Scroll to pan, Ctrl/⌘ + scroll to zoom, Space + drag to pan',
        'Arrows nudge (Shift: ×10); Delete removes; Ctrl/⌘ D duplicates; Ctrl/⌘ C / V copy and paste',
        'Ctrl/⌘ Z / Shift Z undo and redo',
        'Clip a layer to the one below for stripes or patterns inside a shape',
        'Mirror (M): box one piece of the template and what you draw there is copied onto its matching piece; pins fix pieces that aren’t exact mirror images',
        'Transparent areas show the vehicle’s paint colour',
      ].map((t) => h('li', null, t))
    )
  );
}

/** A colour picker with opacity and quick swatches. Colours are #rrggbb or #rrggbbaa. */
export function colourField(value: Colour, onChange: (c: Colour) => void, title = 'Colour', withSwatches = true): HTMLElement {
  const rgb = value.slice(0, 7);
  const alpha = value.length === 9 ? parseInt(value.slice(7), 16) / 255 : 1;
  const picker = colourInput(rgb, title);
  const opacity = h('input', { type: 'range', min: 0, max: 100, value: Math.round(alpha * 100), title: 'Opacity', class: 'designer-alpha' });
  const emit = () => {
    const a = Number(opacity.value) / 100;
    onChange(a >= 1 ? picker.value : `${picker.value}${Math.round(a * 255).toString(16).padStart(2, '0')}`);
  };
  picker.addEventListener('input', emit);
  opacity.addEventListener('input', emit);
  const swatches = h(
    'span',
    { class: 'designer-swatches' },
    SWATCHES.map((c) => h('button', { class: 'designer-swatch', style: `background:${c}`, title: c, onclick: () => ((picker.value = c), emit()) }))
  );
  return h('span', { class: 'designer-colour' }, picker, opacity, withSwatches ? swatches : null);
}

const PAINT_KINDS: [Paint['kind'], string][] = [
  ['none', 'None'],
  ['solid', 'Solid colour'],
  ['linear', 'Linear gradient'],
  ['radial', 'Radial gradient'],
  ['checker', 'Checker (Battenburg)'],
  ['stripes', 'Stripes'],
];

/** Edits a paint; `onChange(paint, group)` for each change, `rerender` when its controls change shape. */
function paintEditor(paint: Paint, onChange: (p: Paint, group: string) => void, rerender: () => void): HTMLElement {
  const first = (p: Paint): Colour => (p.kind === 'solid' ? p.colour : p.kind === 'linear' || p.kind === 'radial' ? p.stops[0]?.colour ?? '#ffffff' : p.kind === 'checker' || p.kind === 'stripes' ? p.a : '#ffffff');
  const kind = h('select', null, PAINT_KINDS.map(([k, n]) => h('option', { value: k, selected: paint.kind === k }, n)));
  kind.addEventListener('change', () => {
    const c = first(paint);
    const k = kind.value as Paint['kind'];
    const next: Paint =
      k === 'none' ? { kind: 'none' }
      : k === 'solid' ? solid(c)
      : k === 'linear' ? { kind: 'linear', angle: 0, stops: [{ at: 0, colour: c }, { at: 1, colour: '#000000' }] }
      : k === 'radial' ? { kind: 'radial', stops: [{ at: 0, colour: c }, { at: 1, colour: '#000000' }] }
      : k === 'checker' ? { kind: 'checker', a: c, b: c === '#ffd200' ? '#1c3f94' : '#ffd200', cell: 80, angle: 0 }
      : { kind: 'stripes', a: c, b: '#000000', width: 60, angle: 45 };
    onChange(next, 'paint-kind');
    rerender();
  });
  const body: HTMLElement[] = [];
  if (paint.kind === 'solid') body.push(colourField(paint.colour, (c) => onChange({ ...paint, colour: c }, 'paint-colour')));
  if (paint.kind === 'linear' || paint.kind === 'radial') {
    const stops = paint.stops;
    stops.forEach((s, i) => {
      const at = h('input', { type: 'range', min: 0, max: 100, value: Math.round(s.at * 100), title: 'Position', class: 'designer-alpha' });
      at.addEventListener('input', () => onChange({ ...paint, stops: stops.map((x, j) => (j === i ? { ...x, at: Number(at.value) / 100 } : x)) } as Paint, `stop-at-${i}`));
      body.push(
        h(
          'div',
          { class: 'designer-stop' },
          colourField(s.colour, (c) => onChange({ ...paint, stops: stops.map((x, j) => (j === i ? { ...x, colour: c } : x)) } as Paint, `stop-${i}`)),
          at,
          stops.length > 2 ? h('button', { class: 'chip mini', title: 'Remove this colour', onclick: () => (onChange({ ...paint, stops: stops.filter((_, j) => j !== i) } as Paint, 'stops'), rerender()) }, '✕') : null
        )
      );
    });
    body.push(
      h(
        'button',
        {
          class: 'chip mini',
          disabled: stops.length >= 6,
          onclick: () => {
            const sorted = [...stops].sort((a, b) => a.at - b.at);
            onChange({ ...paint, stops: [...stops, { at: (sorted[0].at + sorted[sorted.length - 1].at) / 2, colour: '#ffffff' }] } as Paint, 'stops');
            rerender();
          },
        },
        '+ Colour'
      )
    );
    if (paint.kind === 'linear') {
      const angle = h('input', { type: 'range', min: -180, max: 180, value: paint.angle });
      angle.addEventListener('input', () => onChange({ ...paint, angle: Number(angle.value) }, 'angle'));
      body.push(h('label', { class: 'designer-slider' }, h('span', null, 'Angle'), angle));
    }
  }
  if (paint.kind === 'checker' || paint.kind === 'stripes') {
    const size = h('input', { type: 'range', min: 4, max: 600, value: paint.kind === 'checker' ? paint.cell : paint.width });
    size.addEventListener('input', () => onChange(paint.kind === 'checker' ? { ...paint, cell: Number(size.value) } : { ...paint, width: Number(size.value) }, 'size'));
    const angle = h('input', { type: 'range', min: -180, max: 180, value: paint.angle });
    angle.addEventListener('input', () => onChange({ ...paint, angle: Number(angle.value) }, 'angle'));
    body.push(
      colourField(paint.a, (c) => onChange({ ...paint, a: c }, 'paint-a')),
      colourField(paint.b, (c) => onChange({ ...paint, b: c }, 'paint-b')),
      h('label', { class: 'designer-slider' }, h('span', null, paint.kind === 'checker' ? 'Square size' : 'Band width'), size),
      h('label', { class: 'designer-slider' }, h('span', null, 'Angle'), angle)
    );
  }
  return h('div', { class: 'designer-paint' }, kind, ...body);
}
