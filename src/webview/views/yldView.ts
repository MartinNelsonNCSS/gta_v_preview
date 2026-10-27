import * as THREE from 'three';
import type { ClothData, DrawableData, TextureData, YldData } from '../../shared/model';
import { pedBoneName } from '../../formats/pedSkeleton';
import { PedRig } from '../animation';
import { buildCollision } from '../collision';
import { availableLod, buildDrawable, TextureStore } from '../scene';
import { checkbox, fmt, h, pref } from '../ui';
import { Viewer } from '../viewer';
import { fetchTextures, kv, renderOptions, section } from './modelPanel';

const PINNED = 0xff5a5a;
const FREE = 0x4fc3f7;
const CLOTH = 0xf0b44c;

/**
 * Preview for .yld cloth dictionaries: the simulated cloth mesh (pinned and
 * free vertices, links) over its clothing model, with the collision shapes
 * it reacts to placed on a faint reference ped.
 */
export function yldView(file: string, yld: YldData, model?: { file: string; drawables: DrawableData[] }, variation?: TextureData): HTMLElement {
  const status = h('div', { class: 'status' });
  const stage = h('div', { class: 'stage' }, status);
  const sidebar = h('div', { class: 'sidebar' });
  const toolbar = h('div', { class: 'toolbar' });
  const root = h('div', { class: 'model-panel' }, toolbar, h('div', { class: 'model-body' }, stage, sidebar));
  const viewer = new Viewer(stage);
  viewer.setGridVisible(pref('grid', true));
  viewer.setViewDirection(0.9, 1.6, 0.5); // peds face +Y
  if (!yld.cloths.length) {
    status.textContent = 'This cloth dictionary is empty.';
    return root;
  }

  const store = new TextureStore();
  const opts = renderOptions();
  for (const d of model?.drawables ?? []) store.add(d.textures, 'embedded');
  let index = 0;
  const show = {
    model: pref('yldModel', true),
    mesh: pref('yldMesh', true),
    links: pref('yldLinks', true),
    collision: pref('yldCollision', true),
    body: pref('yldBody', true),
  };
  const layers: Record<keyof typeof show, THREE.Object3D[]> = { model: [], mesh: [], links: [], collision: [], body: [] };
  const applyVisibility = () => {
    for (const k of Object.keys(show) as (keyof typeof show)[]) layers[k].forEach((o) => (o.visible = show[k]));
    viewer.requestRender();
  };

  const drawableFor = (c: ClothData) => model?.drawables.find((d) => d.name.toLowerCase() === c.name.toLowerCase()) ?? (model?.drawables.length === 1 ? model.drawables[0] : undefined);

  const build = (reframe: boolean) => {
    const c = yld.cloths[index];
    for (const k of Object.keys(layers) as (keyof typeof layers)[]) layers[k] = [];

    // Reference ped with the collision shapes on its bones.
    const rig = new PedRig({ ghost: true });
    layers.body.push(...rig.object.children);
    let unplaced = 0;
    for (const col of c.colliders) {
      const bone = rig.bone(col.boneTag);
      if (!bone) {
        unplaced++;
        continue;
      }
      const shape = buildCollision(col.bounds, { wireframe: false, triangles: true, primitives: true, overlay: true });
      // Faint, so the cloth and model stay readable through the body volumes.
      shape.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (m) m.opacity = 0.18;
      });
      shape.matrixAutoUpdate = false;
      shape.matrix.fromArray(col.matrix);
      bone.add(shape);
      layers.collision.push(shape);
    }
    rig.object.updateMatrixWorld(true);
    // The skeleton's nodes are in the rig; keep the shapes visible even when the body is hidden.
    const collisionRoot = new THREE.Group();
    for (const shape of layers.collision) {
      const world = shape.matrixWorld.clone();
      shape.parent?.remove(shape);
      shape.matrix.copy(world);
      collisionRoot.add(shape);
    }

    // Clothing model, with the first texture variation as its diffuse.
    const d = drawableFor(c);
    const objects: THREE.Object3D[] = [rig.object, collisionRoot];
    if (d) {
      if (variation) for (const s of d.shaders) if (s.diffuse) store.add([{ ...variation, name: s.diffuse }], 'variation');
      const g = buildDrawable(d, availableLod(d, 'high'), store, opts);
      layers.model.push(g);
      objects.push(g);
      const names = d.shaders.flatMap((s) => s.textures.map((t) => t.texture));
      void fetchTextures(store, names, [d.name], (s) => (status.textContent = s));
    }

    // The cloth itself.
    const cloth = new THREE.Group();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(c.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(c.indices, 1));
    geometry.computeVertexNormals();
    const surface = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: CLOTH, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false, roughness: 0.8 })
    );
    const wire = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: CLOTH, wireframe: true, transparent: true, opacity: 0.5 }));
    layers.mesh.push(surface, wire);
    const linkGeometry = new THREE.BufferGeometry();
    linkGeometry.setAttribute('position', new THREE.BufferAttribute(c.positions, 3));
    linkGeometry.setIndex(new THREE.BufferAttribute(new Uint16Array([...c.edges, ...c.bendEdges]), 1));
    const links = new THREE.LineSegments(linkGeometry, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }));
    layers.links.push(links);
    const colors = new Float32Array(c.positions.length);
    const pinned = new THREE.Color(PINNED);
    const free = new THREE.Color(FREE);
    for (let i = 0; i < c.positions.length / 3; i++) (i < c.pinned ? pinned : free).toArray(colors, i * 3);
    const pointGeometry = new THREE.BufferGeometry();
    pointGeometry.setAttribute('position', new THREE.BufferAttribute(c.positions, 3));
    pointGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const points = new THREE.Points(pointGeometry, new THREE.PointsMaterial({ size: 6, sizeAttenuation: false, vertexColors: true, depthTest: false }));
    points.renderOrder = 10;
    layers.mesh.push(points);
    cloth.add(surface, wire, links, points);
    objects.push(cloth);

    viewer.setContent(...objects);
    applyVisibility();
    if (reframe) {
      // Frame the cloth and its model rather than the whole reference body.
      const box = new THREE.Box3().setFromObject(cloth);
      for (const g of layers.model) box.union(new THREE.Box3().setFromObject(g));
      box.expandByScalar(0.3);
      viewer.frame(box);
    }
    renderSidebar(c, d, unplaced);
  };

  const renderSidebar = (c: ClothData, d: DrawableData | undefined, unplaced: number) => {
    const vertices = c.positions.length / 3;
    const size = c.bbMax.map((v, i) => v - c.bbMin[i]);
    const byBone = new Map<number, number>();
    for (const col of c.colliders) byBone.set(col.boneTag, (byBone.get(col.boneTag) ?? 0) + col.bounds.primitives.length + col.bounds.triangles);
    const boneName = (t: number) => pedBoneName(t) ?? `bone ${t}`;
    sidebar.replaceChildren(
      section(
        'Cloth',
        true,
        kv('Name', c.name || '—'),
        kv('Vertices', `${fmt(vertices)} (${fmt(c.pinned)} pinned, ${fmt(vertices - c.pinned)} free)`),
        kv('Triangles', fmt(c.indices.length / 3)),
        kv('Links', fmt(c.edges.length / 2)),
        ...(c.bendEdges.length ? [kv('Bend links', fmt(c.bendEdges.length / 2))] : []),
        kv('Size', `${size.map((v) => fmt(v)).join(' × ')} m`),
        kv('Pinned to', c.boneTags.map(boneName).join(', ') || '—'),
        h(
          'div',
          { class: 'legend' },
          h('span', null, h('span', { class: 'swatch', style: `background:#${PINNED.toString(16)}` }), ' pinned (follows the body)'),
          h('span', null, h('span', { class: 'swatch', style: `background:#${FREE.toString(16)}` }), ' free (simulated)')
        )
      ),
      section(
        'Model',
        true,
        d
          ? h('div', null, kv('File', model!.file), kv('Drawable', d.name), ...(variation ? [kv('Texture', variation.name)] : []))
          : h('div', { class: 'muted' }, model ? `${model.file} has no drawable named ${c.name}.` : 'No .ydd with the same name was found next to this file.')
      ),
      section(
        `Collision (${c.colliders.length})`,
        true,
        h('div', { class: 'muted' }, 'Shapes the cloth collides with, shown on a reference ped in a standing pose (approximate).'),
        ...[...byBone].map(([t, n]) => kv(boneName(t), `${n} shape${n === 1 ? '' : 's'}`)),
        unplaced ? h('div', { class: 'muted' }, `${unplaced} on bones the built-in skeleton doesn’t have (not shown).`) : null
      )
    );
  };

  const toggles = [
    checkbox('Model', 'yldModel', true, (v) => ((show.model = v), applyVisibility())),
    checkbox('Cloth', 'yldMesh', true, (v) => ((show.mesh = v), applyVisibility())),
    checkbox('Links', 'yldLinks', true, (v) => ((show.links = v), applyVisibility())),
    checkbox('Collision', 'yldCollision', true, (v) => ((show.collision = v), applyVisibility())),
    checkbox('Body', 'yldBody', true, (v) => ((show.body = v), applyVisibility())),
    checkbox('Grid', 'grid', true, (v) => viewer.setGridVisible(v)),
  ];
  const picker =
    yld.cloths.length > 1
      ? h(
          'label',
          { class: 'toggle' },
          'Cloth',
          h(
            'select',
            { onchange: (e: Event) => ((index = Number((e.target as HTMLSelectElement).value)), build(true)) },
            yld.cloths.map((c, i) => h('option', { value: String(i) }, c.name || `cloth ${i + 1}`))
          )
        )
      : null;
  toolbar.append(h('strong', null, file), h('span', { class: 'sep' }), ...(picker ? [picker] : []), ...toggles, h('span', { class: 'spacer' }), h('button', { class: 'chip', onclick: () => build(true) }, 'Frame'));

  build(true);
  return root;
}
