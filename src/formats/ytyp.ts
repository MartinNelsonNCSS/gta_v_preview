import { MetaObject } from './meta';
import { arr, num, readMeta, str, toEntity, vec3 } from './mapShared';
import type { ArchetypeData, YtypData } from '../shared/model';

export interface YtypOptions {
  /** Extra strings (e.g. file names in the workspace) used to resolve hashes. */
  knownNames?: Iterable<string>;
}

/** Parses a .ytyp file. */
export function parseYtyp(file: Uint8Array, opts: YtypOptions = {}): YtypData {
  const { root, doc } = readMeta(file, 'CMapTypes', opts.knownNames);

  const archetypes = arr(root.archetypes).map(toArchetype);
  return {
    name: str(root.name) || doc.name || '',
    archetypes,
    dependencies: arr(root.dependencies).map(String),
    raw: root,
  };
}

function toArchetype(o: MetaObject): ArchetypeData {
  const a: ArchetypeData = {
    type: o._type,
    name: str(o.name),
    assetName: str(o.assetName),
    textureDictionary: str(o.textureDictionary),
    drawableDictionary: str(o.drawableDictionary),
    physicsDictionary: str(o.physicsDictionary),
    clipDictionary: str(o.clipDictionary),
    assetType: String(o.assetType ?? ''),
    lodDist: num(o.lodDist),
    flags: num(o.flags),
    specialAttribute: num(o.specialAttribute),
    bbMin: vec3(o.bbMin),
    bbMax: vec3(o.bbMax),
    bsCentre: vec3(o.bsCentre),
    bsRadius: num(o.bsRadius),
  };
  if (o._type === 'CTimeArchetypeDef') a.timeFlags = num(o.timeFlags);
  if (o._type === 'CMloArchetypeDef') {
    const entities = arr(o.entities).map(toEntity);
    const rooms = arr(o.rooms).map((room) => {
      const indices = arr(room.attachedObjects).map(num);
      for (const i of indices) if (entities[i] && !entities[i].room) entities[i].room = str(room.name);
      return {
        name: str(room.name),
        bbMin: vec3(room.bbMin),
        bbMax: vec3(room.bbMax),
        timecycle: str(room.timecycleName),
        entityIndices: indices,
      };
    });
    const portals = arr(o.portals).map((p) => ({
      roomFrom: num(p.roomFrom),
      roomTo: num(p.roomTo),
      flags: num(p.flags),
      corners: arr(p.corners).map(vec3),
    }));
    // Entity sets hold extra entities (toggled by scripts); include them tagged.
    const entitySets = arr(o.entitySets).map((set) => {
      const setEntities = arr(set.entities).map(toEntity);
      for (const e of setEntities) {
        e.entitySet = str(set.name);
        entities.push(e);
      }
      return { name: str(set.name), entityCount: setEntities.length };
    });
    a.mlo = { entities, rooms, portals, entitySets };
  }
  return a;
}

