import { ResourceReader } from './reader';
import { readRsc7 } from './rsc7';
import type { BoundsData, CollisionPrimitive, Vec3 } from '../shared/model';

/**
 * Collision bounds (phBound): the root of a .ybn, and optionally embedded in
 * drawables. Composites are flattened; every child transform is baked into
 * the output so the result is in the root's space.
 */

const enum BoundType {
  Sphere = 0,
  Capsule = 1,
  Box = 3,
  Geometry = 4,
  GeometryBVH = 8,
  Composite = 10,
  Disc = 12,
  Cylinder = 13,
  Cloth = 15,
}

const enum PolyType {
  Triangle = 0,
  Sphere = 1,
  Capsule = 2,
  Box = 3,
  Cylinder = 4,
}

/** Standard GTA V collision material names (materials.dat order). */
export const MATERIAL_NAMES = [
  'DEFAULT', 'CONCRETE', 'CONCRETE_POROUS', 'CONCRETE_PAVEMENT', 'CONCRETE_DUSTY', 'TARMAC', 'TARMAC_PAINTED',
  'TARMAC_POTHOLE', 'ROCK', 'ROCK_MOSSY', 'STONE', 'COBBLESTONE', 'BRICK', 'MARBLE', 'PAVING_SLAB',
  'SANDSTONE_SOLID', 'SANDSTONE_BRITTLE', 'SAND_LOOSE', 'SAND_COMPACT', 'SAND_WET', 'SAND_TRACK',
  'SAND_UNDERWATER', 'SAND_DRY_DEEP', 'SAND_WET_DEEP', 'ICE', 'ICE_TARMAC', 'SNOW_LOOSE', 'SNOW_COMPACT',
  'SNOW_DEEP', 'SNOW_TARMAC', 'GRAVEL_SMALL', 'GRAVEL_LARGE', 'GRAVEL_DEEP', 'GRAVEL_TRAIN_TRACK', 'DIRT_TRACK',
  'MUD_HARD', 'MUD_POTHOLE', 'MUD_SOFT', 'MUD_UNDERWATER', 'MUD_DEEP', 'MARSH', 'MARSH_DEEP', 'SOIL', 'CLAY_HARD',
  'CLAY_SOFT', 'GRASS_LONG', 'GRASS', 'GRASS_SHORT', 'HAY', 'BUSHES', 'TWIGS', 'LEAVES', 'WOODCHIPS', 'TREE_BARK',
  'METAL_SOLID_SMALL', 'METAL_SOLID_MEDIUM', 'METAL_SOLID_LARGE', 'METAL_HOLLOW_SMALL', 'METAL_HOLLOW_MEDIUM',
  'METAL_HOLLOW_LARGE', 'METAL_CHAINLINK_SMALL', 'METAL_CHAINLINK_LARGE', 'METAL_CORRUGATED_IRON', 'METAL_GRILLE',
  'METAL_RAILING', 'METAL_DUCT', 'METAL_GARAGE_DOOR', 'METAL_MANHOLE', 'WOOD_SOLID_SMALL', 'WOOD_SOLID_MEDIUM',
  'WOOD_SOLID_LARGE', 'WOOD_SOLID_POLISHED', 'WOOD_FLOOR_DUSTY', 'WOOD_HOLLOW_SMALL', 'WOOD_HOLLOW_MEDIUM',
  'WOOD_HOLLOW_LARGE', 'WOOD_CHIPBOARD', 'WOOD_OLD_CREAKY', 'WOOD_HIGH_DENSITY', 'WOOD_LATTICE', 'CERAMIC',
  'ROOF_TILE', 'ROOF_FELT', 'FIBREGLASS', 'TARPAULIN', 'PLASTIC', 'PLASTIC_HOLLOW', 'PLASTIC_HIGH_DENSITY',
  'PLASTIC_CLEAR', 'PLASTIC_HOLLOW_CLEAR', 'PLASTIC_HIGH_DENSITY_CLEAR', 'FIBREGLASS_HOLLOW', 'RUBBER',
  'RUBBER_HOLLOW', 'LINOLEUM', 'LAMINATE', 'CARPET_SOLID', 'CARPET_SOLID_DUSTY', 'CARPET_FLOORBOARD', 'CLOTH',
  'PLASTER_SOLID', 'PLASTER_BRITTLE', 'CARDBOARD_SHEET', 'CARDBOARD_BOX', 'PAPER', 'FOAM', 'FEATHER_PILLOW',
  'POLYSTYRENE', 'LEATHER', 'TVSCREEN', 'SLATTED_BLINDS', 'GLASS_SHOOT_THROUGH', 'GLASS_BULLETPROOF',
  'GLASS_OPAQUE', 'PERSPEX', 'CAR_METAL', 'CAR_PLASTIC', 'CAR_SOFTTOP', 'CAR_SOFTTOP_CLEAR', 'CAR_GLASS_WEAK',
  'CAR_GLASS_MEDIUM', 'CAR_GLASS_STRONG', 'CAR_GLASS_BULLETPROOF', 'CAR_GLASS_OPAQUE', 'WATER', 'BLOOD', 'OIL',
  'PETROL', 'FRESH_MEAT', 'DRIED_MEAT', 'EMISSIVE_GLASS', 'EMISSIVE_PLASTIC', 'VFX_METAL_ELECTRIFIED',
  'VFX_METAL_WATER_TOWER', 'VFX_METAL_STEAM', 'VFX_METAL_FLAME', 'PHYS_NO_FRICTION', 'PHYS_GOLF_BALL',
  'PHYS_TENNIS_BALL', 'PHYS_CASTER', 'PHYS_CASTER_RUSTY', 'PHYS_CAR_VOID', 'PHYS_PED_CAPSULE',
  'PHYS_ELECTRIC_FENCE', 'PHYS_ELECTRIC_METAL', 'PHYS_BARBED_WIRE', 'PHYS_POOLTABLE_SURFACE',
  'PHYS_POOLTABLE_CUSHION', 'PHYS_POOLTABLE_BALL', 'BUTTOCKS', 'THIGH_LEFT', 'SHIN_LEFT', 'FOOT_LEFT',
  'THIGH_RIGHT', 'SHIN_RIGHT', 'FOOT_RIGHT', 'SPINE0', 'SPINE1', 'SPINE2', 'SPINE3', 'CLAVICLE_LEFT',
  'UPPER_ARM_LEFT', 'LOWER_ARM_LEFT', 'HAND_LEFT', 'CLAVICLE_RIGHT', 'UPPER_ARM_RIGHT', 'LOWER_ARM_RIGHT',
  'HAND_RIGHT', 'NECK', 'HEAD', 'ANIMAL_DEFAULT', 'CAR_ENGINE', 'PUDDLE', 'CONCRETE_PAVEMENT_DUSTY',
  'BRICK_PAVEMENT', 'PHYS_DYNAMIC_COVER_BOUND', 'VFX_WOOD_BEER_BARREL', 'WOOD_HIGH_FRICTION', 'ROCK_NOINST',
  'BUSHES_NOINST', 'METAL_SOLID_ROAD_SURFACE', 'STUNT_RAMP_SURFACE', 'TEMP_01', 'TEMP_02', 'TEMP_03', 'TEMP_04',
  'TEMP_05', 'TEMP_06', 'TEMP_07', 'TEMP_08', 'TEMP_09', 'TEMP_10', 'TEMP_11', 'TEMP_12', 'TEMP_13', 'TEMP_14',
  'TEMP_15', 'TEMP_16', 'TEMP_17', 'TEMP_18', 'TEMP_19', 'TEMP_20', 'TEMP_21', 'TEMP_22', 'TEMP_23', 'TEMP_24',
  'TEMP_25', 'TEMP_26', 'TEMP_27', 'TEMP_28', 'TEMP_29', 'TEMP_30',
];

export function materialName(index: number): string {
  return MATERIAL_NAMES[index] ?? `material ${index}`;
}

/** Parses a .ybn file. */
export function parseYbn(file: Uint8Array): BoundsData {
  const r = new ResourceReader(readRsc7(file));
  // A .ybn root is a pgBase (0x10 bytes) wrapper around the bound in older files;
  // modern ones start directly with the bound. Detect by the type byte.
  return readBounds(r, 0x50000000);
}

/** Reads a phBound tree at `ptr` and flattens it into meshes and primitives. */
export function readBounds(r: ResourceReader, ptr: number): BoundsData {
  const out: Builder = { positions: [], materials: [], primitives: [], counts: {}, materialCounts: new Map() };
  readBound(r, ptr, IDENTITY, out, 0);
  const positions = new Float32Array(out.positions);
  return {
    bbMin: r.vec3(ptr + 0x30),
    bbMax: r.vec3(ptr + 0x20),
    triangles: positions.length / 9,
    positions,
    triangleMaterials: Uint8Array.from(out.materials),
    // Drop anything with non-finite numbers rather than poisoning the whole scene.
    primitives: out.primitives.filter(isFinitePrimitive),
    typeCounts: out.counts,
    materials: [...out.materialCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([index, count]) => ({ index, name: materialName(index), count })),
  };
}

interface Builder {
  /** Non-indexed triangle soup, 9 floats per triangle. */
  positions: number[];
  /** Material type per triangle. */
  materials: number[];
  primitives: CollisionPrimitive[];
  counts: Record<string, number>;
  materialCounts: Map<number, number>;
}

type Mat = number[]; // column-major 4x4
const IDENTITY: Mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function transform(m: Mat, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
  ];
}
function transformDir(m: Mat, v: Vec3): Vec3 {
  return [m[0] * v[0] + m[4] * v[1] + m[8] * v[2], m[1] * v[0] + m[5] * v[1] + m[9] * v[2], m[2] * v[0] + m[6] * v[1] + m[10] * v[2]];
}
function mul(a: Mat, b: Mat): Mat {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) for (let k = 0; k < 4; k++) o[c * 4 + rr] += a[k * 4 + rr] * b[c * 4 + k];
  return o;
}
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];

function count(out: Builder, key: string) {
  out.counts[key] = (out.counts[key] ?? 0) + 1;
}
function countMaterial(out: Builder, m: number, n = 1) {
  out.materialCounts.set(m, (out.materialCounts.get(m) ?? 0) + n);
}

function readBound(r: ResourceReader, ptr: number, m: Mat, out: Builder, depth: number): void {
  if (!r.isValid(ptr) || depth > 8) return;
  const type = r.u8(ptr + 0x10);
  const radius = r.f32(ptr + 0x14);
  const bbMax = r.vec3(ptr + 0x20);
  const bbMin = r.vec3(ptr + 0x30);
  const boxCenter = r.vec3(ptr + 0x40);
  const material = r.u8(ptr + 0x4c);
  const sphereCenter = r.vec3(ptr + 0x50);
  const half = scale(sub(bbMax, bbMin), 0.5);

  switch (type) {
    case BoundType.Composite: {
      count(out, 'composite');
      const children = r.ptr(ptr + 0x70);
      const xforms = r.ptr(ptr + 0x78);
      const n = r.u16(ptr + 0xa0);
      for (let i = 0; i < n; i++) {
        const child = r.ptr(children + i * 8);
        let local = IDENTITY;
        if (r.isValid(xforms)) {
          // Row-major D3D matrices; the 4th column holds padding (NaN), so rebuild it.
          local = Array.from({ length: 16 }, (_, k) => r.f32(xforms + i * 64 + k * 4));
          local[3] = local[7] = local[11] = 0;
          local[15] = 1;
        }
        readBound(r, child, mul(m, local), out, depth + 1);
      }
      break;
    }
    case BoundType.Geometry:
    case BoundType.GeometryBVH:
      count(out, type === BoundType.GeometryBVH ? 'bvh' : 'geometry');
      readGeometry(r, ptr, m, out);
      break;
    case BoundType.Sphere:
      count(out, 'sphere');
      countMaterial(out, material);
      out.primitives.push({ kind: 'sphere', material, center: transform(m, sphereCenter), radius });
      break;
    case BoundType.Box:
      count(out, 'box');
      countMaterial(out, material);
      out.primitives.push({
        kind: 'box',
        material,
        center: transform(m, boxCenter),
        axes: [transformDir(m, [half[0], 0, 0]), transformDir(m, [0, half[1], 0]), transformDir(m, [0, 0, half[2]])],
      });
      break;
    case BoundType.Capsule:
    case BoundType.Cylinder: {
      // Both are aligned to the bound's local Y axis.
      count(out, type === BoundType.Capsule ? 'capsule' : 'cylinder');
      countMaterial(out, material);
      const rad = half[0];
      const len = type === BoundType.Capsule ? Math.max(0, half[1] - rad) : half[1];
      out.primitives.push({
        kind: type === BoundType.Capsule ? 'capsule' : 'cylinder',
        material,
        a: transform(m, add(boxCenter, [0, -len, 0])),
        b: transform(m, add(boxCenter, [0, len, 0])),
        radius: rad,
      });
      break;
    }
    case BoundType.Disc: {
      // A thin cylinder around the local X axis.
      count(out, 'disc');
      countMaterial(out, material);
      out.primitives.push({
        kind: 'cylinder',
        material,
        a: transform(m, add(sphereCenter, [-half[0], 0, 0])),
        b: transform(m, add(sphereCenter, [half[0], 0, 0])),
        radius,
      });
      break;
    }
    default:
      count(out, `type ${type}`);
  }
}

function readGeometry(r: ResourceReader, ptr: number, m: Mat, out: Builder): void {
  const polysPtr = r.ptr(ptr + 0x88);
  const quantum = r.vec3(ptr + 0x90);
  const center = r.vec3(ptr + 0xa0);
  const vertsPtr = r.ptr(ptr + 0xb0);
  const vertCount = r.u32(ptr + 0xd0);
  const polyCount = r.u32(ptr + 0xd4);
  const materialsPtr = r.ptr(ptr + 0xf0);
  const polyMatPtr = r.ptr(ptr + 0x118);
  const materialCount = r.u8(ptr + 0x120);
  if (!r.isValid(polysPtr) || !r.isValid(vertsPtr)) return;

  const verts: Vec3[] = new Array(vertCount);
  for (let i = 0; i < vertCount; i++) {
    const p = vertsPtr + i * 6;
    verts[i] = transform(m, [r.i16(p) * quantum[0] + center[0], r.i16(p + 2) * quantum[1] + center[1], r.i16(p + 4) * quantum[2] + center[2]]);
  }
  const materials: number[] = [];
  for (let i = 0; i < materialCount; i++) materials.push(r.u8(materialsPtr + i * 8));
  const polyMaterial = (i: number) => {
    const idx = r.isValid(polyMatPtr) ? r.u8(polyMatPtr + i) : 0;
    return materials[idx] ?? materials[0] ?? 0;
  };
  const vert = (i: number) => verts[i & 0x7fff] ?? verts[0];
  // Primitive sizes are in local units; scale radii by the transform's scale.
  const radiusScale = Math.hypot(m[0], m[1], m[2]) || 1;

  for (let i = 0; i < polyCount; i++) {
    const p = polysPtr + i * 16;
    const type = r.u8(p) & 7;
    const material = polyMaterial(i);
    countMaterial(out, material);
    switch (type) {
      case PolyType.Triangle: {
        const a = vert(r.u16(p + 4));
        const b = vert(r.u16(p + 6));
        const c = vert(r.u16(p + 8));
        out.positions.push(...a, ...b, ...c);
        out.materials.push(material);
        break;
      }
      case PolyType.Sphere:
        out.primitives.push({ kind: 'sphere', material, center: vert(r.u16(p + 2)), radius: r.f32(p + 4) * radiusScale });
        count(out, 'sphere');
        break;
      case PolyType.Capsule:
      case PolyType.Cylinder:
        out.primitives.push({
          kind: type === PolyType.Capsule ? 'capsule' : 'cylinder',
          material,
          a: vert(r.u16(p + 2)),
          b: vert(r.u16(p + 8)),
          radius: r.f32(p + 4) * radiusScale,
        });
        count(out, type === PolyType.Capsule ? 'capsule' : 'cylinder');
        break;
      case PolyType.Box: {
        // Four alternating corners of the box; recover its centre and half-axes.
        const [v1, v2, v3, v4] = [4, 6, 8, 10].map((o) => vert(r.u16(p + o)));
        const c = scale(add(add(v1, v2), add(v3, v4)), 0.25);
        out.primitives.push({
          kind: 'box',
          material,
          center: c,
          axes: [
            scale(sub(add(v1, v2), add(v3, v4)), 0.25),
            scale(sub(add(v1, v3), add(v2, v4)), 0.25),
            scale(sub(add(v1, v4), add(v2, v3)), 0.25),
          ],
        });
        count(out, 'box');
        break;
      }
    }
  }
}

function isFinitePrimitive(p: CollisionPrimitive): boolean {
  const values = Object.values(p).flatMap((v) => (typeof v === 'number' ? [v] : Array.isArray(v) ? (v.flat() as number[]) : []));
  return values.every(Number.isFinite);
}
