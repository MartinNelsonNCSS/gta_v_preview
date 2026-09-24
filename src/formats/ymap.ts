import { arr, num, readMeta, str, toEntity, vec3 } from './mapShared';
import type { MetaObject } from './meta';
import type { YmapData } from '../shared/model';

export interface YmapOptions {
  /** Extra strings (e.g. file names in the workspace) used to resolve hashes. */
  knownNames?: Iterable<string>;
}

/** Parses a .ymap file (CMapData). */
export function parseYmap(file: Uint8Array, opts: YmapOptions = {}): YmapData {
  const { root, doc } = readMeta(file, 'CMapData', opts.knownNames);
  const block = root.block as MetaObject | undefined;
  const instanced = root.instancedData as MetaObject | undefined;
  return {
    name: str(root.name) || doc.name || '',
    parent: str(root.parent),
    flags: num(root.flags),
    contentFlags: num(root.contentFlags),
    streamingExtents: [vec3(root.streamingExtentsMin), vec3(root.streamingExtentsMax)],
    entitiesExtents: [vec3(root.entitiesExtentsMin), vec3(root.entitiesExtentsMax)],
    entities: arr(root.entities).map(toEntity),
    carGenerators: arr(root.carGenerators).map((c) => ({
      position: vec3(c.position),
      orientX: num(c.orientX),
      orientY: num(c.orientY),
      perpendicularLength: num(c.perpendicularLength),
      model: str(c.carModel),
      flags: num(c.flags),
      popGroup: str(c.popGroup),
      livery: num(c.livery, -1),
    })),
    timecycleModifiers: arr(root.timeCycleModifiers).map((t) => ({ name: str(t.name), min: vec3(t.minExtents), max: vec3(t.maxExtents) })),
    physicsDictionaries: arr(root.physicsDictionaries).map(String),
    boxOccluders: arr(root.boxOccluders).length,
    occludeModels: arr(root.occludeModels).length,
    grassBatches: instanced ? arr(instanced.GrassInstanceList).length : 0,
    lodLights: countSoa(root.LODLightsSOA),
    block: block
      ? { name: str(block.name), exportedBy: str(block.exportedBy), owner: str(block.owner), time: str(block.time) }
      : undefined,
    raw: root,
  };
}

function countSoa(v: unknown): number {
  const soa = v as MetaObject | undefined;
  return soa ? arr(soa.direction).length : 0;
}
