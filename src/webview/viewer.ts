import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// GTA V is Z-up.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

/** A three.js canvas with orbit controls, lighting, grid and on-demand rendering. */
export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  /** Everything the user loaded lives under this group. */
  readonly content = new THREE.Group();
  /** Helpers (bounds, portals, selection) that are excluded from framing. */
  readonly overlay = new THREE.Group();
  private readonly grid: THREE.GridHelper;
  private readonly axes: THREE.AxesHelper;
  private readonly resizeObserver: ResizeObserver;
  private frameRequested = false;
  private disposed = false;
  /** True once the user has moved the camera; auto-framing stops after that. */
  userMoved = false;
  private lastFramed?: THREE.Box3;
  private framed = false;
  private readonly clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);

  constructor(readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 10000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(3, -4, 2);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => this.requestRender());
    this.controls.addEventListener('start', () => (this.userMoved = true));

    const hemi = new THREE.HemisphereLight(0xffffff, 0x60646c, 1.6);
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(0.4, -0.6, 1);
    // A light that follows the camera keeps every face readable.
    const head = new THREE.DirectionalLight(0xffffff, 0.8);
    head.position.set(0, 0, 1);
    this.camera.add(head);
    this.scene.add(hemi, sun, this.camera, this.content, this.overlay);

    this.grid = new THREE.GridHelper(20, 20, 0x888888, 0x555555);
    this.grid.rotation.x = Math.PI / 2;
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.35;
    this.axes = new THREE.AxesHelper(1);
    this.scene.add(this.grid, this.axes);

    this.applyTheme();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    // VS Code theme changes swap body classes.
    new MutationObserver(() => this.applyTheme()).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    this.resize();
    // Debugging aid: inspect viewers from the webview developer tools.
    ((window as unknown as { __gtaViewers?: Viewer[] }).__gtaViewers ??= []).push(this);
  }

  applyTheme(): void {
    const bg = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim() || '#1e1e1e';
    this.scene.background = new THREE.Color(bg);
    this.requestRender();
  }

  setGridVisible(v: boolean): void {
    this.grid.visible = v;
    this.axes.visible = v;
    this.requestRender();
  }

  /** Hides everything above height `z` (useful for looking into interiors); null disables. */
  setCutHeight(z: number | null): void {
    if (z === null) {
      this.renderer.clippingPlanes = [];
    } else {
      this.clipPlane.constant = z;
      this.renderer.clippingPlanes = [this.clipPlane];
    }
    this.requestRender();
  }

  /** Replaces the displayed content. Old geometry/materials are disposed. */
  setContent(...objects: THREE.Object3D[]): void {
    disposeTree(this.content);
    this.content.clear();
    this.content.add(...objects);
    this.requestRender();
  }

  clearOverlay(): void {
    disposeTree(this.overlay);
    this.overlay.clear();
    this.requestRender();
  }

  /** Points the camera at `box` (defaults to all content). */
  frame(box?: THREE.Box3): void {
    const b = box ?? new THREE.Box3().setFromObject(this.content);
    if (b.isEmpty() || ![...b.min.toArray(), ...b.max.toArray()].every(Number.isFinite)) return;
    this.lastFramed = box ? b.clone() : undefined;
    this.userMoved = false;
    const size = b.getSize(new THREE.Vector3());
    const center = b.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 0.05);
    // Fit the bounding sphere within both the vertical and horizontal field of view.
    const vfov = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const hfov = Math.atan(Math.tan(vfov) * this.camera.aspect);
    const dist = radius / Math.sin(Math.min(vfov, hfov));
    const dir = new THREE.Vector3(0.9, -1.4, 0.8).normalize();
    this.camera.position.copy(center).addScaledVector(dir, dist * 1.05);
    this.camera.near = Math.max(dist / 1000, 0.005);
    this.camera.far = dist * 100 + radius * 10;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    this.framed = true;

    // Size the grid to the content.
    // 20 cells of a power-of-ten size, covering at least twice the content.
    const extent = Math.max(size.x, size.y, 0.01);
    const step = Math.pow(10, Math.ceil(Math.log10(extent / 10)));
    this.grid.scale.set(step, 1, step);
    this.grid.position.set(center.x, center.y, b.min.z);
    this.axes.scale.setScalar(Math.max(extent * 0.15, 0.1));
    this.requestRender();
  }

  /** Returns the first content object under the given client coordinates. */
  pick(clientX: number, clientY: number): THREE.Intersection | undefined {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    // Lines (placeholder boxes) are picked within a few pixels, not the default 1 unit.
    const distance = this.camera.position.distanceTo(this.controls.target);
    ray.params.Line = { threshold: (distance * 4) / rect.height };
    return ray.intersectObject(this.content, true).find((i) => i.object.visible && isVisible(i.object));
  }

  requestRender(): void {
    if (this.frameRequested || this.disposed) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      // Damping keeps moving the camera for a few frames after input stops.
      if (this.controls.update()) this.requestRender();
      this.renderer.render(this.scene, this.camera);
    });
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Views are often framed before layout settles; refit until the user takes over.
    if (this.framed && !this.userMoved) this.frame(this.lastFramed);
    this.requestRender();
  }

  dispose(): void {
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.controls.dispose();
    disposeTree(this.scene);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

function isVisible(o: THREE.Object3D | null): boolean {
  for (; o; o = o.parent) if (!o.visible) return false;
  return true;
}

/** Disposes geometries and materials (but not shared textures) under `root`. */
export function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose();
  });
}
