import { ResourceReader } from './reader';
import { readRsc7, ResourceError } from './rsc7';
import { HashNames } from './hash';
import { MetaDocument, MetaObject } from './meta';
import type { EntityData, Quat, Vec3 } from '../shared/model';

/** Structure, field and enum names that appear in .ytyp and .ymap files. */
export const META_NAMES = [
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
  // .ymap (CMapData)
  'CMapData', 'parent', 'contentFlags', 'streamingExtentsMin', 'streamingExtentsMax', 'entitiesExtentsMin',
  'entitiesExtentsMax', 'containerLods', 'boxOccluders', 'occludeModels', 'physicsDictionaries', 'instancedData',
  'carGenerators', 'LODLightsSOA', 'DistantLODLightsSOA', 'block', 'CMloInstanceDef', 'groupId', 'defaultEntitySets',
  'numExitPortals', 'MLOInstflags', 'CCarGen', 'orientX', 'orientY', 'perpendicularLength', 'carModel',
  'bodyColorRemap1', 'bodyColorRemap2', 'bodyColorRemap3', 'bodyColorRemap4', 'popGroup', 'livery',
  'CTimeCycleModifier', 'minExtents', 'maxExtents', 'CBlockDesc', 'version', 'exportedBy', 'owner', 'time',
  'CBoxOccluder', 'iCenterX', 'iCenterY', 'iCenterZ', 'iCosZ', 'iLength', 'iWidth', 'iHeight', 'iSinZ',
  'COccludeModel', 'bmin', 'bmax', 'dataSize', 'verts', 'numVertsInBytes', 'numTris', 'CContainerLodDef',
  'rage__fwInstancedMapData', 'ImapLink', 'PropInstanceList', 'GrassInstanceList', 'rage__fwGrassInstanceListDef',
  'BatchAABB', 'ScaleRange', 'LodFadeStartDist', 'LodInstFadeRange', 'OrientToTerrain', 'InstanceList',
  'rage__fwGrassInstanceListDef__InstanceData', 'Position', 'NormalX', 'NormalY', 'Color', 'Scale', 'Ao', 'Pad',
  'rage__spdAABB', 'min', 'max', 'CLODLight', 'direction', 'timeAndStateFlags', 'hash', 'coneOuterAngleOrCapExt',
  'CDistantLODLight', 'RGBI', 'numStreetLights', 'category', 'rage__fwPropInstanceListDef',
  // .ymt (ped variation)
  'CPedVariationInfo', 'bHasTexVariations', 'bHasDrawblVariations', 'bHasLowLODs', 'bIsSuperLOD', 'availComp',
  'aComponentData3', 'aSelectionSets', 'compInfos', 'propInfo', 'dlcName', 'CPVComponentData', 'numAvailTex',
  'aDrawblData3', 'CPVDrawblData', 'propMask', 'numAlternatives', 'aTexData', 'clothData',
  'CPVDrawblData__CPVClothComponentData', 'ownsCloth', 'CPVTextureData', 'texId', 'distribution', 'CComponentInfo',
  'inclusions', 'exclusions', 'pedXml_vfxComps', 'pedXml_flags', 'pedXml_compIdx', 'pedXml_drawblIdx',
  'pedXml_audioID', 'pedXml_audioID2', 'pedXml_expressionMods', 'CPedPropInfo', 'numAvailProps', 'aPropMetaData',
  'aAnchors', 'CPedPropMetaData', 'audioId', 'expressionMods', 'texData', 'renderFlags', 'propFlags', 'anchorId',
  'propId', 'stickyness', 'CPedPropTexData', 'inclusionId', 'exclusionId', 'CAnchorProps', 'props', 'anchor',
  'CPedSelectionSet', 'compDrawableId', 'compTexId', 'propAnchorId', 'propDrawableId', 'propTexId', 'ePedVarComp',
  'PV_COMP_HEAD', 'PV_COMP_BERD', 'PV_COMP_HAIR', 'PV_COMP_UPPR', 'PV_COMP_LOWR', 'PV_COMP_HAND', 'PV_COMP_FEET',
  'PV_COMP_TEEF', 'PV_COMP_ACCS', 'PV_COMP_TASK', 'PV_COMP_DECL', 'PV_COMP_JBIB', 'PV_COMP_MAX', 'eAnchorPoints',
  'ANCHOR_HEAD', 'ANCHOR_EYES', 'ANCHOR_EARS', 'ANCHOR_MOUTH', 'ANCHOR_LEFT_HAND', 'ANCHOR_RIGHT_HAND',
  'ANCHOR_LEFT_WRIST', 'ANCHOR_RIGHT_WRIST', 'ANCHOR_HIP', 'ANCHOR_LEFT_FOOT', 'ANCHOR_RIGHT_FOOT',
  'ANCHOR_PH_L_HAND', 'ANCHOR_PH_R_HAND', 'NUM_ANCHORS', 'ePropRenderFlags', 'PRF_ALPHA', 'PRF_DECAL', 'PRF_CUTOUT',
  'ePedCompFlags', 'eDrawableFlags',
  // .ymt (scenarios, common roots)
  'CScenarioPointRegion', 'VersionNumber', 'Points', 'EntityOverrides', 'ClusterPoints', 'LookUps', 'Clusters',
  'AccelGrid', 'Chains', 'CScenarioPointContainer', 'LoadSavePoints', 'MyPoints', 'CExtensionDefSpawnPoint',
  'CScenarioPoint', 'CScenarioEntityOverride', 'CScenarioChainingGraph', 'Nodes', 'Edges', 'ChainingEdges',
  'CScenarioChainingNode', 'CScenarioChainingEdge', 'CScenarioPointLookUps', 'TypeNames', 'PedModelSetNames',
  'VehicleModelSetNames', 'GroupNames', 'InteriorNames', 'RequiredIMapNames', 'rage__spdGrid2D', 'MinCellX',
  'MaxCellX', 'MinCellY', 'MaxCellY', 'CellDimX', 'CellDimY', 'CScenarioPointCluster', 'Points', 'ClusterSphere',
  'fNextSpawnAttemptDelay', 'bAllPointsRequiredForSpawn', 'iType', 'ModelSetId', 'iInterior', 'iRequiredIMapId',
  'iProbability', 'uAvailableInMpSp', 'iTimeStartOverride', 'iTimeEndOverride', 'iRadius', 'iTimeTillPedLeaves',
  'iScenarioGroup', 'Flags', 'vPositionAndDirection',
];


/** Decodes an RSC7 meta file and (optionally) checks its root structure type. */
export function readMeta(file: Uint8Array, rootType: string | undefined, knownNames?: Iterable<string>): { root: MetaObject; doc: MetaDocument } {
  if (file[0] === 0x3c /* '<' */) {
    throw new ResourceError('This file is XML; open it as text (XML previews are not supported yet).');
  }
  if (file[0] === 0x50 && file[1] === 0x53 && file[2] === 0x49 && file[3] === 0x4e) {
    throw new ResourceError('This is a PSO-format (binary "PSIN") file, which is not supported yet. RSC7 and XML files are.');
  }
  const names = new HashNames(META_NAMES);
  if (knownNames) names.addAll(knownNames);
  const doc = new MetaDocument(new ResourceReader(readRsc7(file)), names);
  const root = doc.decodeRoot();
  if (!root || (rootType && root._type !== rootType)) {
    throw new ResourceError(`Unexpected meta root type: ${root?._type ?? 'none'} (expected ${rootType})`);
  }
  return { root, doc };
}

export function toEntity(o: MetaObject): EntityData {
  const scaleXY = num(o.scaleXY, 1);
  return {
    archetype: str(o.archetypeName),
    position: vec3(o.position),
    rotation: quat(o.rotation),
    scale: [scaleXY, scaleXY, num(o.scaleZ, 1)],
    lodDist: num(o.lodDist),
    flags: num(o.flags),
    guid: num(o.guid),
    lodLevel: o.lodLevel === undefined ? undefined : String(o.lodLevel),
    parentIndex: num(o.parentIndex, -1),
    isMloInstance: o._type === 'CMloInstanceDef' || undefined,
  };
}

export function arr(v: unknown): MetaObject[] {
  return Array.isArray(v) ? (v.filter((x) => x !== null && x !== undefined) as MetaObject[]) : [];
}
export function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}
export function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
export function vec3(v: unknown): Vec3 {
  return Array.isArray(v) ? [num(v[0]), num(v[1]), num(v[2])] : [0, 0, 0];
}
export function quat(v: unknown): Quat {
  return Array.isArray(v) ? [num(v[0]), num(v[1]), num(v[2]), num(v[3], 1)] : [0, 0, 0, 1];
}
