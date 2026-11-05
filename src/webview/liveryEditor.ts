import * as THREE from 'three';
import type { DrawableData, TextureData } from '../shared/model';
import {
  CENTRE_EPSILON,
  Decal,
  decalCoords,
  decalFrame,
  decalInstances,
  LiveryMesh,
  liveryIndex,
  liveryMeshes,
  LiverySet,
  liverySets,
  paintDecals,
  paintRole,
  RgbaImage,
  Vec3,
} from '../formats/livery';
import { isEncodable, mipLevelsFor } from '../formats/bcEncode';
import { availableLod, DEFAULT_PAINT, TextureStore } from './scene';
import { decodeBc7 } from './bc7';
import { canvasToRgba, decodeImage, resizeCanvas, rgbaCanvas, rgbaToPng } from './imageUtils';
import { textureCanvas, textureDescription } from './textureCanvas';
import { originName } from './textureEditor';
import { h, hostRequest, newRequestId, onHostMessage, pref, setPref, vscode } from './ui';
import type { Viewer } from './viewer';

/*
 * Livery tools for vehicle models: switch between a vehicle's liveries, pick
 * paint colours, place images and text on the bodywork in 3D, follow an image
 * file that is being edited elsewhere, export a UV template, and add or remove
 * liveries. Changes are previewed on the model and only written when saved.
 */

export interface LiveryHost {
  viewer: Viewer;
  store: TextureStore;
  drawable(): DrawableData | undefined;
  setStatus(text: string): void;
}

interface Livery {
  index: number;
  /** Lower-cased texture name (the store key). */
  key: string;
  /** Name as stored in the dictionary. */
  name: string;
}

interface SetState {
  set: LiverySet;
  /** The .ytd holding the liveries. */
  origin?: string;
  liveries: Livery[];
  /** Texture shown on the model. */
  current: string;
  searched: boolean;
}

interface TextDecal {
  text: string;
  colour: string;
  outline: string;
  outlineOn: boolean;
  font: string;
}

interface DecalItem extends Decal {
  id: number;
  label: string;
  placed: boolean;
  text?: TextDecal;
  /** Texels covered in the last preview (0: no livery space there). */
  covered?: number;
}

/** A point in a livery's decal history (for undo / redo). */
interface Snapshot {
  decals: DecalItem[];
  selected?: number;
  dirty: boolean;
}

const cloneDecal = (d: DecalItem): DecalItem => ({ ...d, position: [...d.position] as Vec3, normal: [...d.normal] as Vec3, text: d.text && { ...d.text } });

/** Unsaved changes to one livery texture. */
interface Edit {
  decals: DecalItem[];
  /** An image replacing the livery underneath the decals (a followed or replaced file). */
  base?: { canvas: HTMLCanvasElement; name: string };
  linkId?: number;
  linkName?: string;
  dirty: boolean;
}

const FONTS = [
  { value: 'bold 120px system-ui, sans-serif', label: 'Sans bold' },
  { value: 'italic bold 120px system-ui, sans-serif', label: 'Sans bold italic' },
  { value: 'bold 120px Impact, Haettenschweiler, sans-serif', label: 'Impact' },
  { value: 'bold 120px Georgia, serif', label: 'Serif bold' },
  { value: 'bold 120px ui-monospace, monospace', label: 'Mono bold' },
];

let nextDecalId = 1;

export class LiveryEditor {
  /** Stable element (kept across sidebar re-renders). */
  readonly el = h('div', { class: 'livery-editor' });
  private sets: SetState[] = [];
  private active = 0;
  private readonly edits = new Map<string, Edit>();
  private selected?: number;
  private placing?: number;
  private dragging?: { id: number; mirrored: boolean; moved: boolean };
  /** New decals go on both sides of the vehicle. */
  private symmetry = pref('livery:symmetry', true);
  private readonly history = new Map<string, { undo: Snapshot[]; redo: Snapshot[]; group?: string; at: number }>();
  /** Showing the saved livery while "Compare" is held. */
  private comparing = false;
  private meshCache = new Map<string, LiveryMesh[]>();
  private readonly outline: THREE.Group = new THREE.Group();
  private previewQueued = false;
  private coverageMsg = '';
  private baseCache = new WeakMap<HTMLCanvasElement, { w: number; h: number; rgba: Uint8Array }>();
  private drawableRef?: DrawableData;
  /** The vehicle the model belongs to (its file name without _hi). */
  private model = '';
  private readonly offHost: () => void;

  constructor(private readonly host: LiveryHost) {
    host.viewer.scene.add(this.outline);
    const canvas = host.viewer.renderer.domElement;
    // Capture phase, so a drag on a decal can stop the orbit controls first.
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e), { capture: true });
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { capture: true, passive: false });
    canvas.addEventListener('dragover', (e) => this.onDragOver(e));
    canvas.addEventListener('drop', (e) => void this.onDrop(e));
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('paste', this.onPaste);
    this.offHost = onHostMessage((m) => {
      if (m.type === 'liveryLinkedImage') void this.onLinkedImage(m.linkId, m.name, m.data);
    });
  }

  private readonly onPointerUp = () => this.endDrag();
  private readonly thumbsEl = h('div', { class: 'livery-thumbs' });

  dispose(): void {
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('paste', this.onPaste);
    this.offHost();
    for (const e of this.edits.values()) if (e.linkId) vscode.postMessage({ type: 'liveryUnlink', linkId: e.linkId });
  }

  /** Whether the model has liveries (the section is shown). */
  get available(): boolean {
    return this.sets.length > 0;
  }

  setDrawable(d: DrawableData | undefined): void {
    const sets = d ? liverySets(d) : [];
    const same = sets.length === this.sets.length && sets.every((s, i) => s.prefix === this.sets[i].set.prefix);
    this.drawableRef = d;
    this.meshCache.clear();
    if (!same) {
      this.sets = sets.map((set) => ({ set, liveries: [], current: set.reference, searched: false }));
      this.active = 0;
      this.selected = undefined;
      this.placing = undefined;
    } else {
      sets.forEach((s, i) => (this.sets[i].set = s));
    }
    if (d) for (const shader of new Set(d.shaders.filter((s) => /^vehicle_paint/i.test(s.name)).map((s) => s.name.toLowerCase()))) {
      this.host.store.setPaint(shader, pref(`paint:${shader}`, DEFAULT_PAINT));
    }
    if (this.sets.length) void this.loadLiveries();
    this.render();
  }

  /** The drawable with each livery set showing the chosen livery. */
  apply(d: DrawableData): DrawableData {
    if (!this.sets.length) return d;
    const choice = new Map<number, string>();
    for (const s of this.sets) if (s.current !== s.set.reference) s.set.shaders.forEach((i) => choice.set(i, s.current));
    if (!choice.size) return d;
    return { ...d, shaders: d.shaders.map((s, i) => (choice.has(i) ? { ...s, diffuse: choice.get(i) } : s)) };
  }

  /** Called after the model was (re)built. */
  shown(): void {
    this.meshCache.clear();
    this.updateOutline();
    this.schedulePreview();
  }

  // -- data -------------------------------------------------------------------------

  private get state(): SetState | undefined {
    return this.sets[this.active];
  }

  private edit(key: string): Edit {
    let e = this.edits.get(key);
    if (!e) this.edits.set(key, (e = { decals: [], dirty: false }));
    return e;
  }

  private get currentEdit(): Edit | undefined {
    const s = this.state;
    return s && this.edits.get(s.current);
  }

  private selectedDecal(): DecalItem | undefined {
    return this.currentEdit?.decals.find((d) => d.id === this.selected);
  }

  private async loadLiveries(force = false): Promise<void> {
    const pending = this.sets.filter((s) => force || !s.searched);
    if (!pending.length) return;
    const reply = await hostRequest({ type: 'findLiveries', requestId: newRequestId(), prefixes: pending.map((s) => s.set.prefix) }, 'liveries');
    this.model = reply.model;
    for (const found of reply.sets) {
      const s = this.sets.find((x) => x.set.prefix === found.prefix);
      if (!s) continue;
      s.searched = true;
      s.origin = found.origin;
      const source = found.textures[0] ? originName(found.textures[0]) : '';
      if (force) this.host.store.update(found.textures, source);
      else this.host.store.add(found.textures, source);
      s.liveries = found.textures
        .map((t) => ({ index: liveryIndex(s.set, t.name) ?? 0, key: t.name.toLowerCase(), name: t.name }))
        .sort((a, b) => a.index - b.index);
      if (!s.liveries.some((l) => l.key === s.current) && s.liveries.length && s.current !== s.set.reference) s.current = s.liveries[0].key;
    }
    this.render();
    this.schedulePreview();
  }

  private meshes(): LiveryMesh[] {
    const s = this.state;
    const d = this.drawableRef;
    if (!s || !d) return [];
    // Paint with the most detailed geometry, whichever LOD is on screen (they share the texture).
    const lod = availableLod(d, 'high');
    const key = `${s.set.prefix}|${lod}`;
    let m = this.meshCache.get(key);
    if (!m) this.meshCache.set(key, (m = liveryMeshes(d, lod, s.set.shaders)));
    return m;
  }

  /** Shows livery `key` of the active set on the model. */
  private choose(key: string): void {
    const s = this.state;
    if (!s) return;
    s.current = key;
    this.selected = undefined;
    this.placing = undefined;
    this.host.viewer.content.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m?.userData?.liveryPrefix === s.set.prefix && m.userData.textureName !== key) this.host.store.rebind(m, key);
    });
    this.host.viewer.requestRender();
    this.updateOutline();
    this.render();
    this.schedulePreview();
  }

  // -- preview ----------------------------------------------------------------------

  private schedulePreview(): void {
    if (this.previewQueued) return;
    this.previewQueued = true;
    requestAnimationFrame(() => {
      this.previewQueued = false;
      this.preview();
    });
  }

  /** RGBA of a texture's pixels (decoding BC7), or undefined without data. */
  private static rgbaOf(t: TextureData | undefined): RgbaImage | undefined {
    const px = t?.pixels;
    if (!px) return undefined;
    const data = px.encoding === 'bc7' ? decodeBc7(px.data, px.width, px.height) : px.data;
    return data ? { width: px.width, height: px.height, data } : undefined;
  }

  private baseAt(canvas: HTMLCanvasElement, w: number, hgt: number): Uint8Array {
    const cached = this.baseCache.get(canvas);
    if (cached && cached.w === w && cached.h === hgt) return cached.rgba.slice();
    const rgba = canvasToRgba(canvas.width === w && canvas.height === hgt ? canvas : resizeCanvas(canvas, w, hgt));
    this.baseCache.set(canvas, { w, h: hgt, rgba });
    return rgba.slice();
  }

  private preview(): void {
    const s = this.state;
    const e = s && this.edits.get(s.current);
    if (!s || !e || this.comparing) return;
    const store = this.host.store;
    const original = store.original(s.current);
    const orig = LiveryEditor.rgbaOf(original);
    if (!original || !orig) return;
    const placed = e.decals.filter((d) => d.placed);
    if (!e.base && !placed.length) {
      store.setPreview(s.current, undefined);
    } else {
      const data = e.base ? this.baseAt(e.base.canvas, orig.width, orig.height) : new Uint8Array(orig.data);
      const covered = paintDecals({ width: orig.width, height: orig.height, data }, this.meshes(), placed);
      const hidden = placed.filter((d, i) => (d.covered = covered[i]) === 0);
      const msg = hidden.length
        ? `${hidden.map((d) => d.label).join(', ')} can't show there: that part of the model has no space on the livery texture (see "UV template…"). Try another panel, or raise Depth.`
        : '';
      // Only clear the status this message set.
      if (msg || this.coverageMsg) this.host.setStatus(msg);
      this.coverageMsg = msg;
      store.setPreview(s.current, { ...original, pixels: { encoding: 'rgba', width: orig.width, height: orig.height, data } });
    }
    this.host.viewer.requestRender();
  }

  /** Full-resolution result of the current edit: the base (file or image) with decals painted on. */
  private async composeFull(key: string, e: Edit | undefined): Promise<{ texture: TextureData; image: RgbaImage } | undefined> {
    const info = this.host.store.original(key);
    if (!info?.origin) return undefined;
    this.host.setStatus('Loading the full-resolution livery…');
    const full = await hostRequest({ type: 'getFullTexture', requestId: newRequestId(), origin: info.origin, name: info.name }, 'fullTexture');
    this.host.setStatus('');
    const fullRgba = LiveryEditor.rgbaOf(full.texture);
    if (!full.texture || !fullRgba) {
      this.host.setStatus(`Couldn't load ${info.name}: ${full.error ?? 'no pixel data'}`);
      return undefined;
    }
    let { width: w, height: hgt } = fullRgba;
    const base = e?.base?.canvas;
    // A replacement image keeps its own size when it's a power of two (e.g. painting a bigger livery).
    if (base && isPow2(base.width) && isPow2(base.height)) [w, hgt] = [base.width, base.height];
    const data = base ? this.baseAt(base, w, hgt) : new Uint8Array(fullRgba.data);
    const image = { width: w, height: hgt, data };
    const placed = e?.decals.filter((d) => d.placed) ?? [];
    if (placed.length) paintDecals(image, this.meshes(), placed);
    return { texture: full.texture, image };
  }

  // -- 3D interaction ---------------------------------------------------------------

  private hit(e: { clientX: number; clientY: number }): { point: Vec3; normal: Vec3 } | undefined {
    const s = this.state;
    if (!s) return undefined;
    const viewer = this.host.viewer;
    const rect = viewer.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, viewer.camera);
    const hits = ray.intersectObject(viewer.content, true);
    const first = hits[0];
    if (!first || ((first.object as THREE.Mesh).material as THREE.Material)?.userData?.liveryPrefix !== s.set.prefix) return undefined;
    const mesh = first.object as THREE.Mesh;
    const normal = new THREE.Vector3();
    const geo = mesh.geometry;
    const nAttr = geo.getAttribute('normal') as THREE.BufferAttribute | undefined;
    if (first.face && nAttr && first.barycoord) {
      const { a, b, c } = first.face;
      const na = new THREE.Vector3().fromBufferAttribute(nAttr, a);
      const nb = new THREE.Vector3().fromBufferAttribute(nAttr, b);
      const nc = new THREE.Vector3().fromBufferAttribute(nAttr, c);
      normal.addScaledVector(na, first.barycoord.x).addScaledVector(nb, first.barycoord.y).addScaledVector(nc, first.barycoord.z);
    } else if (first.face) normal.copy(first.face.normal);
    normal.transformDirection(mesh.matrixWorld);
    if (normal.dot(ray.ray.direction) > 0) normal.negate();
    return { point: first.point.toArray() as Vec3, normal: normal.normalize().toArray() as Vec3 };
  }

  /** The decal (and whether its mirrored copy) under a surface point. */
  private decalAt(p: Vec3): { id: number; mirrored: boolean } | undefined {
    const decals = this.currentEdit?.decals ?? [];
    for (let i = decals.length - 1; i >= 0; i--) {
      const d = decals[i];
      if (!d.placed) continue;
      const instances = decalInstances(d);
      for (let k = 0; k < instances.length; k++) {
        const c = decalCoords(decalFrame(instances[k].decal), p);
        if (c.u >= 0 && c.u <= 1 && c.v >= 0 && c.v <= 1 && Math.abs(c.dist) <= d.depth) return { id: d.id, mirrored: k === 1 };
      }
    }
    return undefined;
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || !this.state) return;
    const hit = this.placing !== undefined || this.currentEdit?.decals.length ? this.hit(e) : undefined;
    if (!hit) return;
    const edit = this.currentEdit;
    if (this.placing !== undefined && edit) {
      const d = edit.decals.find((x) => x.id === this.placing);
      this.placing = undefined;
      if (d) {
        // A new decal's undo step is its adding; placing one again is a step of its own.
        if (d.placed) this.checkpoint();
        this.placeAt(d, hit);
        edit.dirty = true;
        this.selected = d.id;
        this.dragging = { id: d.id, mirrored: false, moved: true };
        this.host.viewer.controls.enabled = false;
      }
      this.host.setStatus('');
      this.render();
      this.updateOutline();
      this.schedulePreview();
      return;
    }
    const under = this.decalAt(hit.point);
    if (!under) return;
    this.dragging = { ...under, moved: false };
    this.host.viewer.controls.enabled = false;
    if (this.selected !== under.id) {
      this.selected = under.id;
      this.render();
      this.updateOutline();
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const canvas = this.host.viewer.renderer.domElement;
    if (!this.dragging) {
      if (this.placing !== undefined) canvas.style.cursor = 'crosshair';
      else if (this.currentEdit?.decals.some((d) => d.placed)) {
        const hit = this.hit(e);
        canvas.style.cursor = hit && this.decalAt(hit.point) ? 'move' : '';
      } else canvas.style.cursor = '';
      return;
    }
    const hit = this.hit(e);
    const d = this.currentEdit?.decals.find((x) => x.id === this.dragging!.id);
    if (!hit || !d) return;
    if (!this.dragging.moved) {
      this.checkpoint();
      this.dragging.moved = true;
    }
    const m = this.dragging.mirrored;
    this.placeAt(d, m ? { point: [-hit.point[0], hit.point[1], hit.point[2]], normal: [-hit.normal[0], hit.normal[1], hit.normal[2]] } : hit, e.altKey);
    this.currentEdit!.dirty = true;
    this.updateOutline();
    this.schedulePreview();
  }

  /** Shift + wheel resizes the selected decal, Alt + wheel rotates it (instead of zooming). */
  private onWheel(e: WheelEvent): void {
    const d = this.selectedDecal();
    if (!d?.placed || !(e.shiftKey || e.altKey)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    // Shift turns vertical scrolling into deltaX on some systems.
    const delta = e.deltaY || e.deltaX;
    this.checkpoint(`${e.shiftKey ? 'size' : 'rotation'}:${d.id}`);
    if (e.shiftKey) d.size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, d.size * Math.pow(1.1, -delta / 100)));
    else d.rotation = ((((d.rotation + delta / 10 + 180) % 360) + 360) % 360) - 180;
    this.currentEdit!.dirty = true;
    this.updateOutline();
    this.schedulePreview();
    this.queueControls();
  }

  private controlsQueued = false;
  private queueControls(): void {
    if (this.controlsQueued) return;
    this.controlsQueued = true;
    setTimeout(() => {
      this.controlsQueued = false;
      this.render();
    }, 150);
  }

  private endDrag(): void {
    if (!this.dragging) return;
    this.dragging = undefined;
    this.snapped = false;
    this.host.viewer.controls.enabled = true;
    this.renderStatusLine();
  }

  /** Yellow frame around the selected decal (and its mirrored copy). */
  private updateOutline(): void {
    this.outline.children.forEach((c) => {
      (c as THREE.LineLoop).geometry.dispose();
      ((c as THREE.LineLoop).material as THREE.Material).dispose();
    });
    this.outline.clear();
    const d = this.selectedDecal();
    if (d?.placed) {
      for (const { decal } of decalInstances(d)) {
        const f = decalFrame(decal);
        const lift = 0.004;
        const corner = (sx: number, sy: number) =>
          new THREE.Vector3(...f.origin)
            .addScaledVector(new THREE.Vector3(...f.right), sx * f.halfWidth)
            .addScaledVector(new THREE.Vector3(...f.up), sy * f.halfHeight)
            .addScaledVector(new THREE.Vector3(...f.normal), lift);
        const geo = new THREE.BufferGeometry().setFromPoints([corner(-1, 1), corner(1, 1), corner(1, -1), corner(-1, -1)]);
        const line = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color: 0xffc107, depthTest: false, transparent: true }));
        line.renderOrder = 10;
        this.outline.add(line);
      }
    }
    this.host.viewer.requestRender();
  }

  // -- decals -----------------------------------------------------------------------

  private addDecal(image: RgbaImage, label: string, text?: TextDecal, at?: { point: Vec3; normal: Vec3 }): void {
    const s = this.state;
    if (!s) return;
    this.checkpoint();
    const edit = this.edit(s.current);
    const size = text ? 0.5 : 0.4;
    const d: DecalItem = {
      id: nextDecalId++,
      label,
      image,
      text,
      position: [0, 0, 0],
      normal: [1, 0, 0],
      size,
      rotation: 0,
      opacity: 1,
      depth: 0.12,
      mirror: this.symmetry,
      placed: false,
    };
    edit.decals.push(d);
    this.selected = d.id;
    if (at) {
      this.placeAt(d, at);
      edit.dirty = true;
      this.host.setStatus('');
      this.updateOutline();
      this.schedulePreview();
    } else {
      this.placing = d.id;
      this.host.setStatus(`Click on the ${this.describeSurface()} to place ${text ? label : `"${label}"`}.`);
    }
    this.render();
  }

  /** Whether the last move snapped the decal to the centreline. */
  private snapped = false;

  /**
   * Puts a decal at a surface point. Mirrored decals near the centreline snap
   * onto it (one decal across the middle) unless `free`.
   */
  private placeAt(d: DecalItem, at: { point: Vec3; normal: Vec3 }, free = false): void {
    const snap = d.mirror && !free && Math.abs(at.point[0]) < Math.max(0.03, d.size * 0.08);
    d.position = snap ? [0, at.point[1], at.point[2]] : [...at.point];
    if (snap) {
      const [, ny, nz] = at.normal;
      const len = Math.hypot(ny, nz) || 1;
      d.normal = [0, ny / len, nz / len];
    } else d.normal = [...at.normal];
    d.placed = true;
    if (snap !== this.snapped) {
      this.snapped = snap;
      this.renderStatusLine();
    }
  }

  private describeSurface(): string {
    return 'livery area of the model (the painted bodywork)';
  }

  private async addImageDecal(): Promise<void> {
    const reply = await hostRequest({ type: 'pickImage', requestId: newRequestId() }, 'pickedImage');
    if (!reply.data || !reply.name) return;
    try {
      const img = await decodeImage(reply.name, reply.data);
      this.addDecal(LiveryEditor.decalImage(img.canvas), reply.name);
    } catch (err) {
      this.host.setStatus(`Couldn't read ${reply.name}: ${(err as Error).message}`);
    }
  }

  private addTextDecal(): void {
    const text: TextDecal = { text: 'TEXT', colour: '#ffffff', outline: '#000000', outlineOn: true, font: FONTS[0].value };
    this.addDecal(renderText(text), `"${text.text}"`, text);
  }

  private removeDecal(id: number): void {
    const edit = this.currentEdit;
    if (!edit) return;
    this.checkpoint();
    edit.decals = edit.decals.filter((d) => d.id !== id);
    edit.dirty = true;
    if (this.selected === id) this.selected = undefined;
    if (this.placing === id) this.placing = undefined;
    this.render();
    this.updateOutline();
    this.schedulePreview();
  }

  private duplicateDecal(d: DecalItem): void {
    const edit = this.currentEdit;
    if (!edit) return;
    this.checkpoint();
    const copy: DecalItem = { ...d, id: nextDecalId++, text: d.text && { ...d.text }, position: [...d.position] as Vec3, normal: [...d.normal] as Vec3, placed: false };
    edit.decals.push(copy);
    this.selected = copy.id;
    this.placing = copy.id;
    this.host.setStatus(`Click on the model to place the copy of "${d.label}".`);
    this.render();
  }

  // -- undo / redo ------------------------------------------------------------------

  private readonly undoBtn = h('button', { class: 'chip mini', title: `Undo (${MOD} + Z)`, onclick: () => this.undo() }, '↶');
  private readonly redoBtn = h('button', { class: 'chip mini', title: `Redo (${MOD} + Shift + Z)`, onclick: () => this.undo(true) }, '↷');

  private updateUndoButtons(): void {
    const hist = this.state && this.history.get(this.state.current);
    this.undoBtn.disabled = !hist?.undo.length;
    this.redoBtn.disabled = !hist?.redo.length;
  }

  private snapshot(e: Edit): Snapshot {
    return { decals: e.decals.map(cloneDecal), selected: this.selected, dirty: e.dirty };
  }

  /**
   * Records the current decals before a change. Changes in the same `group`
   * (one slider drag, one run of scrolling) within a moment share one step.
   */
  private checkpoint(group?: string): void {
    const s = this.state;
    if (!s) return;
    let hist = this.history.get(s.current);
    if (!hist) this.history.set(s.current, (hist = { undo: [], redo: [], at: 0 }));
    const now = performance.now();
    if (group && hist.group === group && now - hist.at < 1500) {
      hist.at = now;
      return;
    }
    hist.undo.push(this.snapshot(this.edit(s.current)));
    if (hist.undo.length > 100) hist.undo.shift();
    hist.redo = [];
    hist.group = group;
    hist.at = now;
    this.updateUndoButtons();
  }

  private undo(redo = false): void {
    const s = this.state;
    const hist = s && this.history.get(s.current);
    const snap = (redo ? hist?.redo : hist?.undo)?.pop();
    if (!s || !hist || !snap) {
      this.host.setStatus(redo ? 'Nothing to redo.' : 'Nothing to undo.');
      return;
    }
    const e = this.edit(s.current);
    (redo ? hist.undo : hist.redo).push(this.snapshot(e));
    hist.group = undefined;
    e.decals = snap.decals.map(cloneDecal);
    e.dirty = snap.dirty;
    this.selected = e.decals.some((d) => d.id === snap.selected) ? snap.selected : undefined;
    this.placing = undefined;
    this.dragging = undefined;
    this.host.setStatus(redo ? 'Redone.' : 'Undone.');
    this.render();
    this.updateOutline();
    this.schedulePreview();
  }

  // -- keyboard, paste, drop ---------------------------------------------------------

  /** Whether keys and pastes are for the livery editor (it's showing, no dialog open, not typing). */
  private wantsInput(target: EventTarget | null): boolean {
    if (!this.state || !this.el.isConnected || document.querySelector('.lightbox')) return false;
    const t = target as HTMLElement | null;
    if (!t) return true;
    // Text fields keep their own keys; sliders, tick boxes and buttons don't need them.
    if (t.tagName === 'INPUT') return ['range', 'checkbox', 'color', 'button', 'radio'].includes((t as HTMLInputElement).type);
    return !(t.isContentEditable || t.tagName === 'TEXTAREA');
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.wantsInput(e.target)) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    const d = this.selectedDecal();
    let handled = true;
    if (mod && key === 'z') this.undo(e.shiftKey);
    else if (mod && key === 'y') this.undo(true);
    else if (mod && key === 's') {
      if (this.currentEdit?.dirty) void this.save();
    } else if (mod && key === 'd' && d) this.duplicateDecal(d);
    else if ((e.key === 'Delete' || e.key === 'Backspace') && !mod && d) this.removeDecal(d.id);
    else if (e.key === 'Escape' && (this.placing !== undefined || d)) {
      const unplaced = this.placing !== undefined && !d?.placed;
      if (unplaced && d) {
        // Escape before placing a new decal takes it away again.
        this.undo();
        this.host.setStatus('');
      } else {
        this.placing = undefined;
        this.selected = undefined;
        this.render();
        this.updateOutline();
      }
    } else handled = false;
    if (handled) e.preventDefault();
  };

  /** Pasting an image (e.g. copied from an image app or browser) adds it as a decal. */
  private readonly onPaste = (e: ClipboardEvent): void => {
    if (!this.wantsInput(e.target) || !this.host.store.original(this.state!.current)?.pixels) return;
    const file = [...(e.clipboardData?.items ?? [])].find((i) => i.kind === 'file' && i.type.startsWith('image/'))?.getAsFile();
    if (!file) return;
    e.preventDefault();
    void this.decalFromFile(file, 'Pasted image');
  };

  private onDragOver(e: DragEvent): void {
    if (!this.state || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }

  /** Dropping an image file on the model puts it there as a decal. */
  private async onDrop(e: DragEvent): Promise<void> {
    const file = [...(e.dataTransfer?.files ?? [])].find((f) => /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif|bmp|dds)$/i.test(f.name));
    if (!file || !this.state) return;
    e.preventDefault();
    e.stopPropagation();
    await this.decalFromFile(file, file.name, this.hit(e));
  }

  private async decalFromFile(file: File, label: string, at?: { point: Vec3; normal: Vec3 }): Promise<void> {
    try {
      const name = file.name || `${label}.${file.type.split('/')[1] ?? 'png'}`;
      const img = await decodeImage(name, new Uint8Array(await file.arrayBuffer()));
      this.addDecal(LiveryEditor.decalImage(img.canvas), label, undefined, at);
    } catch (err) {
      this.host.setStatus(`Couldn't read ${label}: ${(err as Error).message}`);
    }
  }

  /** Decal pixels from an image, kept reasonably small (they're resampled when painted anyway). */
  private static decalImage(canvas: HTMLCanvasElement): RgbaImage {
    const scale = Math.min(1, 2048 / Math.max(canvas.width, canvas.height));
    const c = scale < 1 ? resizeCanvas(canvas, Math.round(canvas.width * scale), Math.round(canvas.height * scale)) : canvas;
    return { width: c.width, height: c.height, data: canvasToRgba(c) };
  }

  // -- saving, files ----------------------------------------------------------------

  private async save(): Promise<void> {
    const s = this.state;
    if (!s) return;
    const key = s.current;
    const e = this.edits.get(key);
    const composed = await this.composeFull(key, e);
    if (!composed) return;
    const { texture, image } = composed;
    const hasAlpha = image.data.some((_, i) => i % 4 === 3 && image.data[i] < 255);
    // Liveries need alpha (where the paint shows through); DXT1 can't hold it smoothly.
    const format = isEncodable(texture.format) && !(texture.format === 'DXT1' && hasAlpha) ? texture.format : 'DXT5';
    // A full mip chain keeps the livery from shimmering at a distance.
    const levels = isEncodable(format) ? mipLevelsFor(format, image.width, image.height) : undefined;
    const reply = await hostRequest(
      { type: 'replaceTexture', requestId: newRequestId(), origin: texture.origin!, name: texture.name, width: image.width, height: image.height, format, levels, rgba: new Uint8Array(image.data) },
      'textureReplaced'
    );
    if (!reply.ok) {
      if (reply.error) this.host.setStatus(`Couldn't save: ${reply.error}`);
      return;
    }
    this.history.delete(key);
    if (e) {
      e.decals = [];
      e.dirty = false;
      // A followed image stays followed; otherwise the saved texture is now the base.
      if (!e.linkId) e.base = undefined;
    }
    this.selected = undefined;
    this.host.setStatus(`Saved ${texture.name} to ${reply.file}.`);
    await this.loadLiveries(true);
    this.updateOutline();
  }

  private discard(): void {
    const s = this.state;
    if (!s) return;
    const e = this.edits.get(s.current);
    if (e?.linkId) vscode.postMessage({ type: 'liveryUnlink', linkId: e.linkId });
    this.edits.delete(s.current);
    this.history.delete(s.current);
    this.selected = undefined;
    this.placing = undefined;
    this.host.store.setPreview(s.current, undefined);
    this.host.setStatus('');
    this.render();
    this.updateOutline();
  }

  /** Saves the livery (with decals) as a PNG, opens it in the default image app and follows it. */
  private async editExternally(): Promise<void> {
    const s = this.state;
    if (!s) return;
    const key = s.current;
    const e = this.edit(key);
    const composed = await this.composeFull(key, e);
    if (!composed) return;
    const png = await rgbaToPng(new Uint8Array(composed.image.data), composed.image.width, composed.image.height);
    const reply = await hostRequest({ type: 'liveryExport', requestId: newRequestId(), suggestedName: `${composed.texture.name}.png`, data: png }, 'liveryLinkReply');
    if (reply.error) return this.host.setStatus(`Couldn't export: ${reply.error}`);
    if (!reply.linkId) return;
    if (e.linkId) vscode.postMessage({ type: 'liveryUnlink', linkId: e.linkId });
    // The exported image now holds the decals.
    e.base = { canvas: rgbaCanvas(new Uint8Array(composed.image.data), composed.image.width, composed.image.height), name: reply.name ?? 'image' };
    e.decals = [];
    e.linkId = reply.linkId;
    e.linkName = reply.name;
    e.dirty = true;
    this.selected = undefined;
    this.host.setStatus(`Opened ${reply.name} in your image app. Save it there and the model updates here; then use "Save to ${this.ytdName()}".`);
    this.render();
    this.updateOutline();
    this.schedulePreview();
  }

  private async linkImage(): Promise<void> {
    const s = this.state;
    if (!s) return;
    const key = s.current;
    const reply = await hostRequest({ type: 'liveryLink', requestId: newRequestId(), suggestedName: key }, 'liveryLinkReply');
    if (reply.error) return this.host.setStatus(`Couldn't follow the image: ${reply.error}`);
    if (!reply.linkId || !reply.data || !reply.name) return;
    const e = this.edit(key);
    if (e.linkId) vscode.postMessage({ type: 'liveryUnlink', linkId: e.linkId });
    e.linkId = reply.linkId;
    e.linkName = reply.name;
    await this.onLinkedImage(reply.linkId, reply.name, reply.data);
  }

  private async onLinkedImage(linkId: number, name: string, data: Uint8Array): Promise<void> {
    const entry = [...this.edits.entries()].find(([, e]) => e.linkId === linkId);
    if (!entry) return;
    const [key, e] = entry;
    try {
      const img = await decodeImage(name, data);
      e.base = { canvas: img.canvas, name };
      e.dirty = true;
      const t = this.host.store.original(key);
      const note = t && (img.canvas.width !== t.width || img.canvas.height !== t.height)
        ? ` (${img.canvas.width}×${img.canvas.height}; ${isPow2(img.canvas.width) && isPow2(img.canvas.height) ? 'saved at that size' : `saved scaled to ${t.width}×${t.height}`})`
        : '';
      this.host.setStatus(`Showing ${name}${note}, updated ${new Date().toLocaleTimeString()}.`);
      this.render();
      this.schedulePreview();
    } catch (err) {
      this.host.setStatus(`Couldn't read ${name}: ${(err as Error).message}`);
    }
  }

  private unlink(): void {
    const e = this.currentEdit;
    if (!e?.linkId) return;
    vscode.postMessage({ type: 'liveryUnlink', linkId: e.linkId });
    e.linkId = undefined;
    e.linkName = undefined;
    this.render();
  }

  private ytdName(): string {
    const o = this.state?.origin;
    return o ? decodeURIComponent(o.slice(o.lastIndexOf('/') + 1)) : 'the .ytd';
  }

  // -- adding and removing liveries -------------------------------------------------

  /** Name for livery `n` following the dictionary's own spelling (e.g. `Navaho_sign_3`). */
  private nameFor(n: number): string {
    const s = this.state!;
    const sample = s.liveries[0]?.name;
    const prefix = sample ? sample.slice(0, s.set.prefix.length) : s.set.prefix;
    return `${prefix}${n}`;
  }

  private async addLivery(size: number, from: 'blank' | 'copy'): Promise<void> {
    const s = this.state;
    if (!s?.origin || !s.set.numbered) return;
    const n = Math.max(0, ...s.liveries.map((l) => l.index)) + 1;
    const name = this.nameFor(n);
    let rgba: Uint8Array = new Uint8Array(size * size * 4);
    if (from === 'copy') {
      const composed = await this.composeFull(s.current, this.edits.get(s.current));
      if (!composed) return;
      const c = rgbaCanvas(new Uint8Array(composed.image.data), composed.image.width, composed.image.height);
      rgba = canvasToRgba(resizeCanvas(c, size, size));
    }
    const reply = await hostRequest(
      {
        type: 'editYtd',
        requestId: newRequestId(),
        origin: s.origin,
        add: [{ name, width: size, height: size, format: 'DXT5', rgba }],
        note: `Adds livery ${n} to the vehicle${from === 'copy' ? `, starting as a copy of ${s.current}` : ' (transparent: only the paint shows)'}.`,
      },
      'ytdEdited'
    );
    if (!reply.ok) {
      if (reply.error) this.host.setStatus(`Couldn't add the livery: ${reply.error}`);
      return;
    }
    await this.loadLiveries(true);
    this.choose(name.toLowerCase());
    // Livery numbers are shared by every set on the vehicle.
    await this.syncMeta({ added: Math.max(n, ...this.sets.flatMap((x) => x.liveries.map((l) => l.index))) }, `Added ${name}.`);
  }

  private async deleteLivery(l: Livery): Promise<void> {
    const s = this.state;
    if (!s?.origin) return;
    const later = s.liveries.filter((x) => x.index > l.index).sort((a, b) => a.index - b.index);
    // Other sets on the vehicle keep their numbers, so its livery n still exists.
    const shared = this.sets.filter((x) => x !== s && x.liveries.some((o) => o.index === l.index)).map((x) => x.set.prefix);
    const temp = `${l.name}_removed`;
    const rename = later.length
      ? [{ from: l.name, to: temp }, ...later.map((x) => ({ from: x.name, to: this.nameFor(x.index - 1) }))]
      : [];
    const reply = await hostRequest(
      {
        type: 'editYtd',
        requestId: newRequestId(),
        origin: s.origin,
        rename,
        remove: [later.length ? temp : l.name],
        note: `Removes livery ${l.index}.${later.length ? ' Later liveries move down one number so the game still finds them all.' : ''}${
          shared.length ? ` The vehicle's other livery textures (${shared.map((p) => `${p}…`).join(', ')}) keep their numbers, so carvariations.meta is left as it is.` : ''
        }`,
      },
      'ytdEdited'
    );
    if (!reply.ok) {
      if (reply.error) this.host.setStatus(`Couldn't delete the livery: ${reply.error}`);
      return;
    }
    this.edits.delete(l.key);
    this.history.delete(l.key);
    for (const x of later) {
      // Unsaved edits (and their undo history) follow their livery to its new number.
      const to = this.nameFor(x.index - 1).toLowerCase();
      const e = this.edits.get(x.key);
      const hist = this.history.get(x.key);
      this.edits.delete(x.key);
      this.history.delete(x.key);
      if (e) this.edits.set(to, e);
      if (hist) this.history.set(to, hist);
    }
    await this.loadLiveries(true);
    // Show the livery that took its number (or the one before it).
    const next = s.liveries.find((x) => x.index === l.index) ?? [...s.liveries].reverse().find((x) => x.index < l.index) ?? s.liveries[0];
    this.choose(next?.key ?? s.set.reference);
    if (shared.length) this.host.setStatus(`Removed ${l.name}. carvariations.meta left as it is: ${shared.map((p) => `${p}${l.index}`).join(', ')} still make${shared.length === 1 ? 's' : ''} up livery ${l.index}.`);
    else await this.syncMeta({ removed: l.index }, `Removed ${l.name}.`);
  }

  private async syncMeta(change: { added: number } | { removed: number }, done: string): Promise<void> {
    const reply = await hostRequest({ type: 'liveryMeta', requestId: newRequestId(), change }, 'liveryMetaUpdated');
    const changed = reply.files.filter((f) => f.changed);
    const where = reply.manifest ? ` loaded by ${reply.manifest}` : ' nearby';
    const emptied = changed.reduce((n, f) => n + f.emptied, 0);
    const meta = reply.error
      ? ` carvariations.meta wasn't updated: ${reply.error}`
      : changed.length
        ? ` Updated ${changed.reduce((n, f) => n + f.changed, 0)} colour combination${changed.reduce((n, f) => n + f.changed, 0) === 1 ? '' : 's'} in ${changed.map((f) => f.file).join(', ')}.${
            emptied ? ` ${emptied} of them no longer allow${emptied === 1 ? 's' : ''} any livery when the vehicle spawns.` : ''
          }`
        : reply.files.length
          ? ` ${reply.files.map((f) => f.file).join(', ')} needed no change${'added' in change ? ' (its lists already have an entry for it)' : ''}.`
          : ` No carvariations.meta${where} lists this vehicle.`;
    this.host.setStatus(done + meta);
  }

  // -- UV template ------------------------------------------------------------------

  private async templateDialog(): Promise<void> {
    const s = this.state;
    if (!s) return;
    const t = this.host.store.original(s.current);
    const sizes = [512, 1024, 2048, 4096];
    const defaultSize = t && t.width >= 256 ? t.width : 2048;
    const size = h('select', null, [...new Set([defaultSize, ...sizes])].sort((a, b) => a - b).map((n) => h('option', { value: String(n), selected: n === defaultSize }, `${n}×${n}`)));
    const background = h(
      'select',
      null,
      h('option', { value: 'none' }, 'Transparent'),
      h('option', { value: 'white' }, 'White'),
      h('option', { value: 'livery', selected: true }, 'Current livery')
    );
    const fill = h('input', { type: 'checkbox', checked: true });
    const colour = h('input', { type: 'color', value: '#ff2d55' });
    const holder = h('div', { class: 'livery-template checker' });
    let liveryCanvas: HTMLCanvasElement | undefined;
    const draw = async (): Promise<HTMLCanvasElement> => {
      const n = Number(size.value);
      const c = document.createElement('canvas');
      c.width = c.height = n;
      const ctx = c.getContext('2d')!;
      if (background.value === 'white') {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, n, n);
      } else if (background.value === 'livery') {
        if (!liveryCanvas) {
          const composed = await this.composeFull(s.current, this.edits.get(s.current));
          if (composed) liveryCanvas = rgbaCanvas(new Uint8Array(composed.image.data), composed.image.width, composed.image.height);
        }
        if (liveryCanvas) ctx.drawImage(liveryCanvas, 0, 0, n, n);
      }
      drawUvLayout(ctx, n, this.meshes(), colour.value, fill.checked);
      return c;
    };
    const refresh = async () => {
      const c = await draw();
      c.style.width = '100%';
      holder.replaceChildren(c);
    };
    [size, background, fill, colour].forEach((x) => x.addEventListener('change', () => void refresh()));
    const save = h('button', { class: 'chip active' }, 'Save PNG…');
    save.onclick = async () => {
      const c = await draw();
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
      if (!blob) return;
      const reply = await hostRequest(
        { type: 'saveFile', requestId: newRequestId(), suggestedName: `${t?.name ?? s.current}_template.png`, data: new Uint8Array(await blob.arrayBuffer()), filterName: 'PNG image', extensions: ['png'] },
        'saved'
      );
      if (reply.path) {
        this.host.setStatus(`Saved the UV template to ${reply.path}.`);
        close();
      }
    };
    const close = () => {
      overlay.remove();
      window.removeEventListener('keydown', onKey);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    const overlay = h(
      'div',
      { class: 'lightbox', onclick: (e: Event) => e.target === overlay && close() },
      h(
        'div',
        { class: 'lightbox-panel livery-template-panel' },
        h('div', { class: 'lightbox-header' }, h('strong', null, `UV template · ${t?.name ?? s.current}`), h('button', { class: 'chip', onclick: close, title: 'Close (Esc)' }, '✕')),
        h(
          'div',
          { class: 'row' },
          h('label', { class: 'toggle' }, 'Size ', size),
          h('label', { class: 'toggle' }, 'Background ', background),
          h('label', { class: 'toggle' }, fill, 'Shade panels'),
          h('label', { class: 'toggle' }, 'Lines ', colour),
          h('span', { class: 'spacer' }),
          save
        ),
        h('div', { class: 'muted small' }, 'Where each panel of the bodywork falls on the livery texture. Paint over it in your image app, then use "Follow image…" to see it on the model as you save.'),
        holder
      )
    );
    window.addEventListener('keydown', onKey);
    document.body.append(overlay);
    await refresh();
  }

  // -- UI ---------------------------------------------------------------------------

  private statusLine = h('div', { class: 'muted small livery-hint' });

  private renderStatusLine(): void {
    const d = this.selectedDecal();
    this.statusLine.textContent =
      this.placing !== undefined
        ? 'Click on the bodywork to place the decal (Esc to cancel).'
        : d?.placed && d.mirror && Math.abs(d.position[0]) <= CENTRE_EPSILON
          ? 'On the centreline: one decal across the middle. Hold Alt while dragging to move it off.'
          : d?.placed
            ? 'Drag the decal on the model to move it. Orbit by dragging anywhere else.'
            : '';
  }

  render(): void {
    const s = this.state;
    if (!s) {
      this.el.replaceChildren();
      return;
    }
    const store = this.host.store;
    const edit = this.currentEdit;
    const rows: (HTMLElement | null)[] = [];

    if (this.sets.length > 1) {
      rows.push(
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'label' }, 'Set'),
          h(
            'select',
            {
              onchange: (e: Event) => {
                this.active = Number((e.target as HTMLSelectElement).value);
                this.selected = undefined;
                this.placing = undefined;
                this.meshCache.clear();
                this.render();
                this.updateOutline();
              },
            },
            this.sets.map((x, i) => h('option', { value: String(i), selected: i === this.active }, `${x.set.prefix}${x.set.numbered ? 'N' : ''} (${x.liveries.length})`))
          )
        )
      );
    }

    this.refreshThumbnails();
    const newSize = h('select', { title: 'Size of the new livery texture' }, [512, 1024, 2048, 4096].map((n) => h('option', { value: String(n), selected: n === 2048 }, `${n}`)));
    const newFrom = h('select', { title: 'What the new livery starts as' }, h('option', { value: 'blank' }, 'Blank'), h('option', { value: 'copy' }, 'Copy of current'));
    const canAdd = !!s.origin && s.set.numbered;
    rows.push(
      s.liveries.length
        ? this.thumbsEl
        : h('div', { class: 'warn small' }, s.searched ? `No textures named ${s.set.prefix}${s.set.numbered ? '1, 2, …' : ''} were found near this model.` : 'Looking for liveries…'),
      canAdd
        ? h(
            'div',
            { class: 'row livery-new' },
            h('button', { class: 'chip', title: `Add livery ${Math.max(0, ...s.liveries.map((l) => l.index)) + 1} to ${this.ytdName()}`, onclick: () => void this.addLivery(Number(newSize.value), newFrom.value as 'blank' | 'copy') }, '+ New livery'),
            newSize,
            newFrom
          )
        : null
    );

    // Current livery details and actions.
    const current = s.liveries.find((l) => l.key === s.current);
    const info = store.original(s.current);
    const gaps = s.liveries.some((l, i) => l.index !== i + 1);
    rows.push(
      h(
        'div',
        { class: 'livery-current' },
        h('strong', null, info?.name ?? s.current),
        info ? h('span', { class: 'muted small' }, ` ${info.width}×${info.height} ${info.format} · ${originName(info) || 'not found'}`) : h('span', { class: 'warn small' }, ' not found'),
        current && s.liveries.length > 1
          ? h('button', { class: 'chip mini', title: `Delete livery ${current.index} from ${this.ytdName()}`, onclick: () => void this.deleteLivery(current) }, 'Delete')
          : null
      ),
      gaps ? h('div', { class: 'warn small' }, 'Livery numbers should run 1, 2, 3… without gaps.') : null,
      s.origin && this.model && this.ytdName().replace(/\.ytd$/i, '').toLowerCase() !== this.model
        ? h(
            'div',
            { class: 'warn small' },
            `These liveries are in ${this.ytdName()}, not ${this.model}.ytd. In game a vehicle only finds them in its own dictionary, or one set as its parent (txdRelationships in vehicles.meta).`
          )
        : null,
      info && info.width < 128 ? h('div', { class: 'muted small' }, `This livery is a ${info.width}×${info.height} placeholder (often "no livery"). Use "+ New livery" for one to paint on.`) : null,
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'chip', title: 'Export a guide showing where each panel falls on the texture', onclick: () => void this.templateDialog() }, 'UV template…'),
        h('button', { class: 'chip', title: 'Save as PNG, open it in your image app and update the model whenever you save it there', disabled: !info?.origin, onclick: () => void this.editExternally() }, 'Edit in image app'),
        h('button', { class: 'chip', title: 'Use an image file as this livery, updating whenever the file is saved', disabled: !info?.origin, onclick: () => void this.linkImage() }, 'Follow image…')
      ),
      h(
        'div',
        { class: 'row livery-views' },
        h('span', { class: 'label' }, 'View'),
        VIEWS.map(([label, dir]) =>
          h(
            'button',
            {
              class: 'chip mini',
              title: `Look at the ${label.toLowerCase()} of the vehicle`,
              onclick: () => {
                this.host.viewer.setViewDirection(...dir);
                this.host.viewer.frame();
              },
            },
            label
          )
        )
      ),
      edit?.linkId
        ? h('div', { class: 'small livery-link' }, '⟳ Following ', h('strong', null, edit.linkName ?? 'image'), h('button', { class: 'chip mini', onclick: () => this.unlink() }, 'Stop'))
        : edit?.base
          ? h('div', { class: 'small muted' }, `Using ${edit.base.name}`)
          : null
    );

    // Paint colours.
    const d = this.drawableRef;
    const paints = d ? [...new Set(d.shaders.filter((x) => /^vehicle_paint/i.test(x.name)).map((x) => x.name.toLowerCase()))].sort() : [];
    if (paints.length) {
      rows.push(
        h('div', { class: 'pack-section' }, 'Paint'),
        h(
          'div',
          { class: 'livery-paints' },
          paints.map((p) => {
            const input = h('input', { type: 'color', value: hex(store.paintColour(p)) });
            input.addEventListener('input', () => {
              const c = parseInt(input.value.slice(1), 16);
              store.setPaint(p, c);
              setPref(`paint:${p}`, c);
              this.host.viewer.requestRender();
            });
            const role = paintRole(p);
            return h('label', { class: 'toggle', title: role ? `Usually the ${role} colour` : 'Paint colour' }, input, p.replace(/^vehicle_/, ''), role ? h('span', { class: 'muted small' }, ` ${role}`) : null);
          })
        )
      );
    }

    // Decals.
    const decals = edit?.decals ?? [];
    const symmetry = h('input', { type: 'checkbox', checked: this.symmetry });
    symmetry.addEventListener('change', () => this.setSymmetry(symmetry.checked));
    this.updateUndoButtons();
    rows.push(
      h('div', { class: 'pack-section livery-heading' }, h('span', null, 'Decals'), h('span', { class: 'spacer' }), this.undoBtn, this.redoBtn),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'chip', disabled: !info?.pixels, title: 'Place a logo or picture on the bodywork', onclick: () => void this.addImageDecal() }, '+ Image…'),
        h('button', { class: 'chip', disabled: !info?.pixels, title: 'Place text (a number, a name) on the bodywork', onclick: () => this.addTextDecal() }, '+ Text'),
        h(
          'label',
          { class: 'toggle', title: 'Mirror decals onto the other side of the vehicle, text kept readable. Applies to new decals, and to all of this livery\'s decals when switched.' },
          symmetry,
          'Symmetry'
        )
      ),
      !decals.length && info?.pixels
        ? h('div', { class: 'muted small' }, `Or drop an image file on the model to put it right there${IN_VSCODE ? ' (hold Shift while dropping)' : ''}, or paste one (${MOD} + V).`)
        : null,
      decals.length
        ? h(
            'div',
            { class: 'livery-decals' },
            decals.map((x) =>
              h(
                'div',
                {
                  class: `livery-decal${x.id === this.selected ? ' active' : ''}`,
                  onclick: () => {
                    this.selected = x.id;
                    this.render();
                    this.updateOutline();
                  },
                },
                h('span', null, x.label),
                x.placed ? (x.mirror ? h('span', { class: 'muted small' }, ' both sides') : null) : h('span', { class: 'warn small' }, ' not placed'),
                h('span', { class: 'spacer' }),
                h('button', { class: 'chip mini', title: 'Remove', onclick: (e: Event) => (e.stopPropagation(), this.removeDecal(x.id)) }, '✕')
              )
            )
          )
        : null,
      this.decalControls(),
      this.statusLine
    );
    this.renderStatusLine();

    // Save.
    const dirty = !!edit?.dirty;
    rows.push(
      h(
        'div',
        { class: 'row livery-save' },
        h('button', { class: 'chip active', disabled: !dirty, title: `Write this livery (with its decals) into ${this.ytdName()}`, onclick: () => void this.save() }, `Save to ${this.ytdName()}`),
        h('button', { class: 'chip', disabled: !edit, onclick: () => this.discard() }, 'Discard'),
        this.compareButton(!!edit && (!!edit.base || edit.decals.some((x) => x.placed)))
      )
    );
    this.el.replaceChildren(...rows.filter((x): x is HTMLElement => !!x));
  }

  private setSymmetry(on: boolean): void {
    this.symmetry = on;
    setPref('livery:symmetry', on);
    const e = this.currentEdit;
    if (e?.decals.some((d) => d.mirror !== on)) {
      this.checkpoint();
      e.decals.forEach((d) => (d.mirror = on));
      if (e.decals.some((d) => d.placed)) e.dirty = true;
      this.updateOutline();
      this.schedulePreview();
    }
    this.render();
  }

  /** Shows the livery as saved while held down. */
  private compareButton(enabled: boolean): HTMLElement {
    const b = h('button', { class: 'chip', disabled: !enabled, title: 'Hold to see the livery as it is saved, without your changes' }, 'Hold to compare');
    const stop = () => {
      if (!this.comparing) return;
      this.comparing = false;
      this.schedulePreview();
    };
    b.addEventListener('pointerdown', () => {
      const s = this.state;
      if (!s) return;
      this.comparing = true;
      this.host.store.setPreview(s.current, undefined);
      this.host.viewer.requestRender();
    });
    b.addEventListener('pointerup', stop);
    b.addEventListener('pointerleave', stop);
    return b;
  }

  /** Redraws only the livery thumbnails (as textures arrive or previews change). */
  refreshThumbnails(): void {
    const s = this.state;
    if (!s) return;
    const store = this.host.store;
    this.thumbsEl.replaceChildren(
      ...s.liveries.map((l) => {
        const info = store.info(l.key);
        const dirty = this.edits.get(l.key)?.dirty;
        return h(
          'div',
          {
            class: `livery-thumb${l.key === s.current ? ' active' : ''}`,
            title: `${l.name}${info ? `\n${textureDescription(info.data)}` : ''}${dirty ? '\nUnsaved changes' : ''}`,
            onclick: () => l.key !== s.current && this.choose(l.key),
          },
          h('div', { class: 'checker thumb-image' }, info?.data.pixels ? textureCanvas(info.data, 72) : h('span', { class: 'muted small' }, '…')),
          h('div', { class: 'thumb-name' }, `${l.index}${dirty ? ' •' : ''}`)
        );
      })
    );
  }

  private decalControls(): HTMLElement | null {
    const d = this.selectedDecal();
    if (!d) return null;
    const changed = (rerender = false) => {
      this.currentEdit!.dirty = true;
      this.updateOutline();
      this.schedulePreview();
      if (rerender) this.render();
    };
    const slider = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, unit: string) => {
      const out = h('span', { class: 'muted small livery-value' }, `${get()}${unit}`);
      const input = h('input', { type: 'range', min, max, step, value: get() });
      input.addEventListener('input', () => {
        this.checkpoint(`${label}:${d.id}`);
        set(Number(input.value));
        out.textContent = `${Number(input.value)}${unit}`;
        changed();
      });
      return h('label', { class: 'livery-slider' }, h('span', null, label), input, out);
    };
    const text = d.text;
    const textControls = text
      ? (() => {
          const update = () => {
            d.image = renderText(text);
            d.label = `"${text.text}"`;
            changed();
          };
          const input = h('input', { type: 'text', value: text.text, class: 'livery-text' });
          input.addEventListener('input', () => {
            this.checkpoint(`text:${d.id}`);
            text.text = input.value || ' ';
            update();
          });
          input.addEventListener('change', () => this.render());
          const fill = h('input', { type: 'color', value: text.colour, title: 'Text colour' });
          fill.addEventListener('input', () => (this.checkpoint(`fill:${d.id}`), (text.colour = fill.value), update()));
          const outline = h('input', { type: 'color', value: text.outline, title: 'Outline colour' });
          outline.addEventListener('input', () => (this.checkpoint(`outline:${d.id}`), (text.outline = outline.value), update()));
          const outlineOn = h('input', { type: 'checkbox', checked: text.outlineOn });
          outlineOn.addEventListener('change', () => (this.checkpoint(), (text.outlineOn = outlineOn.checked), update()));
          const font = h('select', null, FONTS.map((f) => h('option', { value: f.value, selected: f.value === text.font }, f.label)));
          font.addEventListener('change', () => (this.checkpoint(), (text.font = font.value), update()));
          return [h('div', { class: 'row' }, input), h('div', { class: 'row' }, font, fill, h('label', { class: 'toggle' }, outlineOn, 'Outline'), outline)];
        })()
      : [];
    const mirror = h('input', { type: 'checkbox', checked: d.mirror });
    mirror.addEventListener('change', () => (this.checkpoint(), (d.mirror = mirror.checked), changed(true)));
    const flip = h('input', { type: 'checkbox', checked: !!d.flip });
    flip.addEventListener('change', () => (this.checkpoint(), (d.flip = flip.checked), changed()));
    return h(
      'div',
      { class: 'livery-decal-controls' },
      ...textControls,
      sizeSlider(d, () => changed(), () => this.checkpoint(`size:${d.id}`)),
      slider('Rotation', -180, 180, 1, () => Math.round(d.rotation), (v) => (d.rotation = v), '°'),
      slider('Opacity', 0, 100, 1, () => Math.round(d.opacity * 100), (v) => (d.opacity = v / 100), '%'),
      slider('Depth', 0.01, 0.6, 0.01, () => d.depth, (v) => (d.depth = v), ' m'),
      h(
        'div',
        { class: 'row' },
        h('label', { class: 'toggle', title: 'Paint a copy on the other side of the vehicle (text stays readable). Set for new decals by Symmetry.' }, mirror, 'Both sides'),
        h('label', { class: 'toggle', title: 'Flip the image horizontally' }, flip, 'Flip'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'chip mini', onclick: () => this.duplicateDecal(d) }, 'Duplicate'),
        h(
          'button',
          {
            class: 'chip mini',
            title: 'Place it again by clicking on the model',
            onclick: () => {
              this.placing = d.id;
              this.renderStatusLine();
            },
          },
          'Re-place'
        )
      ),
      h('div', { class: 'muted small' }, 'Depth is how far it reaches into curved or recessed panels; lower it if it bleeds onto parts behind.'),
      h(
        'details',
        { class: 'small muted livery-keys' },
        h('summary', null, 'Mouse and keys'),
        h(
          'ul',
          null,
          [
            'Drag the decal to move it; drag elsewhere to orbit',
            'Shift + scroll: resize · Alt + scroll: rotate',
            'With both sides on, it snaps to the centreline; hold Alt while dragging to stop that',
            `Delete: remove · ${MOD} + D: duplicate · Esc: deselect`,
            `${MOD} + Z / ${MOD} + Shift + Z: undo / redo · ${MOD} + S: save`,
          ].map((t) => h('li', null, t))
        )
      )
    );
  }
}

const MIN_SIZE = 0.02;
const MOD = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';
/** VS Code only lets files be dropped into a webview while Shift is held. */
const IN_VSCODE = typeof (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi === 'function';
/** Camera directions (looking from) around a vehicle: GTA vehicles face +Y with +Z up. */
const VIEWS: [string, [number, number, number]][] = [
  ['Left', [-1, 0, 0]],
  ['Right', [1, 0, 0]],
  ['Front', [0, 1, 0]],
  ['Back', [0, -1, 0]],
  ['Top', [0, -0.02, 1]],
];
const MAX_SIZE = 4;

/** Size on a logarithmic scale, so small decals are as easy to set as big ones. */
function sizeSlider(d: Decal, changed: () => void, before: () => void): HTMLElement {
  const toSlider = (size: number) => Math.round((Math.log(size / MIN_SIZE) / Math.log(MAX_SIZE / MIN_SIZE)) * 1000);
  const fromSlider = (v: number) => MIN_SIZE * Math.pow(MAX_SIZE / MIN_SIZE, v / 1000);
  const label = (size: number) => (size < 1 ? `${Math.round(size * 100)} cm` : `${size.toFixed(2)} m`);
  const out = h('span', { class: 'muted small livery-value' }, label(d.size));
  const input = h('input', { type: 'range', min: 0, max: 1000, step: 1, value: toSlider(d.size) });
  input.addEventListener('input', () => {
    before();
    d.size = Number(fromSlider(Number(input.value)).toFixed(3));
    out.textContent = label(d.size);
    changed();
  });
  return h('label', { class: 'livery-slider', title: 'Width of the decal' }, h('span', null, 'Size'), input, out);
}

function isPow2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

function hex(c: number): string {
  return `#${c.toString(16).padStart(6, '0')}`;
}

/** Text drawn onto a transparent image, trimmed to the text (with outline). */
function renderText(t: TextDecal): RgbaImage {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = t.font;
  const m = ctx.measureText(t.text);
  const pad = 24;
  const ascent = m.actualBoundingBoxAscent || 100;
  const descent = m.actualBoundingBoxDescent || 24;
  c.width = Math.max(8, Math.ceil(m.width + pad * 2));
  c.height = Math.ceil(ascent + descent + pad * 2);
  ctx.font = t.font;
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  if (t.outlineOn) {
    ctx.strokeStyle = t.outline;
    ctx.lineWidth = 14;
    ctx.strokeText(t.text, pad, pad + ascent);
  }
  ctx.fillStyle = t.colour;
  ctx.fillText(t.text, pad, pad + ascent);
  return { width: c.width, height: c.height, data: canvasToRgba(c) };
}

/** Draws the livery UV layout: every triangle, moved into the 0–1 tile it mostly covers. */
export function drawUvLayout(ctx: CanvasRenderingContext2D, size: number, meshes: LiveryMesh[], colour: string, shade: boolean): void {
  ctx.save();
  ctx.lineWidth = Math.max(1, size / 1024);
  ctx.strokeStyle = colour;
  ctx.fillStyle = `${colour}33`;
  ctx.lineJoin = 'round';
  const path = new Path2D();
  for (const m of meshes) {
    const T = m.uvs;
    const I = m.indices;
    for (let t = 0; t + 2 < I.length; t += 3) {
      const a = I[t] * 2, b = I[t + 1] * 2, c = I[t + 2] * 2;
      const ou = Math.floor((T[a] + T[b] + T[c]) / 3);
      const ov = Math.floor((T[a + 1] + T[b + 1] + T[c + 1]) / 3);
      path.moveTo((T[a] - ou) * size, (T[a + 1] - ov) * size);
      path.lineTo((T[b] - ou) * size, (T[b + 1] - ov) * size);
      path.lineTo((T[c] - ou) * size, (T[c + 1] - ov) * size);
      path.closePath();
    }
  }
  if (shade) ctx.fill(path);
  ctx.stroke(path);
  ctx.restore();
}
