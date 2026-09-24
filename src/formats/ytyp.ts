import { ResourceReader } from './reader';
import { readRsc7, ResourceError } from './rsc7';
import { HashNames } from './hash';
import { MetaDocument, MetaObject } from './meta';
import type { ArchetypeData, EntityData, Quat, Vec3, YtypData } from '../shared/model';

/** Structure, field and enum names that appear in .ytyp files. */
export const YTYP_NAMES = [
  // structures
  'CMapTypes', 'CBaseArchetypeDef', 'CTimeArchetypeDef', 'CMloArchetypeDef', 'CEntityDef', 'CMloInstanceDef',
  'CMloRoomDef', 'CMloPortalDef', 'CMloEntitySet', 'CMloTimeCycleModifier', 'CCompositeEntityType',
  'CCompositeEntityTypeAnim', 'CExtensionDefLightEffect', 'CLightAttrDef', 'CExtensionDefParticleEffect',
  'CExtensionDefAudioEmitter', 'CExtensionDefAudioCollisionSettings', 'CExtensionDefBuoyancy', 'CExtensionDefDoor',
  'CExtensionDefExplosionEffect', 'CExtensionDefExpression', 'CExtensionDefLadder', 'CExtensionDefLightShaft',
  'CExtensionDefProcObject', 'CExtensionDefSpawnPoint', 'CExtensionDefSpawnPointOverride',
  'CExtensionDefWindDisturbance', 'CExtensionDefDestruction', 'CExtensionDefLightOccluder',
  // CMapTypes
  'extensions', 'archetypes', 'name', 'dependencies', 'compositeEntityTypes',
  // CBaseArchetypeDef / CTimeArchetypeDef / CMloArchetypeDef
  'lodDist', 'flags', 'specialAttribute', 'bbMin', 'bbMax', 'bsCentre', 'bsRadius', 'hdTextureDist',
  'textureDictionary', 'clipDictionary', 'drawableDictionary', 'physicsDictionary', 'assetType', 'assetName',
  'timeFlags', 'mloFlags', 'entities', 'rooms', 'portals', 'entitySets', 'timeCycleModifiers',
  // CEntityDef
  'archetypeName', 'guid', 'position', 'rotation', 'scaleXY', 'scaleZ', 'parentIndex', 'childLodDist', 'lodLevel',
  'numChildren', 'priorityLevel', 'ambientOcclusionMultiplier', 'artificialAmbientOcclusion', 'tintValue',
  // rooms / portals / sets / tcmods
  'blend', 'timecycleName', 'secondaryTimecycleName', 'portalCount', 'floorId', 'exteriorVisibiltyDepth',
  'attachedObjects', 'roomFrom', 'roomTo', 'mirrorPriority', 'opacity', 'audioOcclusion', 'corners', 'locations',
  'sphere', 'percentage', 'range', 'startHour', 'endHour',
  // composite entity types
  'Name', 'StartModel', 'EndModel', 'StartImapFile', 'EndImapFile', 'PtFxAssetName', 'Animations', 'AnimDict',
  'AnimName', 'AnimatedModel', 'punchInPhase', 'punchOutPhase', 'effectsData',
  // extensions
  'offsetPosition', 'offsetRotation', 'instances', 'fxName', 'fxType', 'boneTag', 'scale', 'probability', 'color',
  'effectHash', 'enableLimitAngle', 'startsLocked', 'canBreak', 'limitAngle', 'doorTargetRatio', 'audioHash',
  'expressionDictionaryName', 'expressionName', 'creatureMetadataName', 'initialiseOnCollision', 'spawnType',
  'pedType', 'group', 'interior', 'requiredImap', 'availableInMpSp', 'timeTillPedLeaves', 'radius', 'start', 'end',
  'scenarioFlags', 'highPri', 'extendedRange', 'shortRange', 'top', 'bottom', 'normal', 'materialType', 'template',
  'canGetOffAtTop', 'cornerA', 'cornerB', 'cornerC', 'cornerD', 'direction', 'densityType', 'volumeType', 'softness',
  'scaleByColor', 'scaleByIntensity', 'fadeInTimeStart', 'fadeInTimeEnd', 'fadeOutTimeStart', 'fadeOutTimeEnd',
  'fadeDistanceStart', 'fadeDistanceEnd', 'flashiness', 'lightType', 'intensity', 'posn', 'colour', 'groupId',
  'falloff', 'falloffExponent', 'cullingPlane', 'shadowBlur', 'padding1', 'padding2', 'padding3', 'volIntensity',
  'volSizeScale', 'volOuterColour', 'lightHash', 'volOuterIntensity', 'coronaSize', 'volOuterExponent',
  'lightFadeDistance', 'shadowFadeDistance', 'specularFadeDistance', 'volumetricFadeDistance', 'shadowNearClip',
  'coronaIntensity', 'coronaZBias', 'tangent', 'coneInnerAngle', 'coneOuterAngle', 'extents', 'projectedTextureKey',
  'windType', 'strength', 'objectHash', 'spacing', 'minXRotation', 'maxXRotation', 'minZRotation', 'maxZRotation',
  'minScale', 'maxScale', 'minScaleZ', 'maxScaleZ', 'zOffsetMin', 'zOffsetMax', 'isAligned', 'explosionTag',
  'explosionType', 'ignoreDamageModel', 'playOnParent', 'onlyOnDamageModel', 'allowRubberBulletShotFx',
  'allowElectricBulletShotFx', 'decalId', 'localPosition', 'localRotation',
  // enums
  'fwArchetypeDef__eAssetType', 'ASSET_TYPE_UNINITIALIZED', 'ASSET_TYPE_FRAGMENT', 'ASSET_TYPE_DRAWABLE',
  'ASSET_TYPE_DRAWABLEDICTIONARY', 'ASSET_TYPE_ASSETLESS', 'rage__eLodType', 'LODTYPES_DEPTH_HD',
  'LODTYPES_DEPTH_LOD', 'LODTYPES_DEPTH_SLOD1', 'LODTYPES_DEPTH_SLOD2', 'LODTYPES_DEPTH_SLOD3',
  'LODTYPES_DEPTH_ORPHANHD', 'LODTYPES_DEPTH_SLOD4', 'rage__ePriorityLevel', 'PRI_REQUIRED', 'PRI_OPTIONAL_HIGH',
  'PRI_OPTIONAL_MEDIUM', 'PRI_OPTIONAL_LOW', 'CLightAttrDef__eLightType', 'LIGHT_TYPE_POINT', 'LIGHT_TYPE_SPOT',
  'LIGHT_TYPE_CAPSULE', 'CExtensionDefParticleEffect__eFxType', 'CExtensionDefSpawnPoint__eAvailableInMpSp',
  'CSpawnPoint__eAvailableInMpSp', 'kBoth', 'kOnlySp', 'kOnlyMp',
];

export interface YtypOptions {
  /** Extra strings (e.g. file names in the workspace) used to resolve hashes. */
  knownNames?: Iterable<string>;
}

/** Parses a .ytyp file. */
export function parseYtyp(file: Uint8Array, opts: YtypOptions = {}): YtypData {
  if (file[0] === 0x3c /* '<' */) {
    throw new ResourceError('This .ytyp is XML; open it as text (XML .ytyp previews are not supported yet).');
  }
  if (file[0] === 0x50 && file[1] === 0x53 && file[2] === 0x49 && file[3] === 0x4e) {
    throw new ResourceError('PSO-format .ytyp files are not supported yet.');
  }
  const names = new HashNames(YTYP_NAMES);
  if (opts.knownNames) names.addAll(opts.knownNames);
  const r = new ResourceReader(readRsc7(file));
  const doc = new MetaDocument(r, names);
  const root = doc.decodeRoot();
  if (!root || root._type !== 'CMapTypes') {
    throw new ResourceError(`Unexpected meta root type: ${root?._type ?? 'none'}`);
  }

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

function toEntity(o: MetaObject): EntityData {
  const scaleXY = num(o.scaleXY, 1);
  return {
    archetype: str(o.archetypeName),
    position: vec3(o.position),
    rotation: quat(o.rotation),
    scale: [scaleXY, scaleXY, num(o.scaleZ, 1)],
    lodDist: num(o.lodDist),
    flags: num(o.flags),
  };
}

function arr(v: unknown): MetaObject[] {
  return Array.isArray(v) ? (v.filter((x) => x !== null && x !== undefined) as MetaObject[]) : [];
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}
function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function vec3(v: unknown): Vec3 {
  return Array.isArray(v) ? [num(v[0]), num(v[1]), num(v[2])] : [0, 0, 0];
}
function quat(v: unknown): Quat {
  return Array.isArray(v) ? [num(v[0]), num(v[1]), num(v[2]), num(v[3], 1)] : [0, 0, 0, 1];
}
