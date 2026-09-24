/**
 * Jenkins one-at-a-time hash as used by RAGE. Asset names are hashed
 * lower-case; meta structure/field names are hashed with their exact case.
 */
export function joaat(input: string, lower = true): number {
  const s = lower ? input.toLowerCase() : input;
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h + s.charCodeAt(i)) >>> 0;
    h = (h + (h << 10)) >>> 0;
    h = (h ^ (h >>> 6)) >>> 0;
  }
  h = (h + (h << 3)) >>> 0;
  h = (h ^ (h >>> 11)) >>> 0;
  h = (h + (h << 15)) >>> 0;
  return h;
}

/**
 * Reverse lookup table for hashes. Names are case-preserved for display but
 * hashed lower-case, matching the game.
 */
export class HashNames {
  private readonly map = new Map<number, string>();

  constructor(names: Iterable<string> = []) {
    this.addAll(names);
  }

  /** Registers both the exact-case and lower-case hash of `name`. */
  add(name: string): void {
    for (const h of [joaat(name, false), joaat(name, true)]) {
      if (!this.map.has(h)) this.map.set(h, name);
    }
  }

  addAll(names: Iterable<string>): void {
    for (const n of names) this.add(n);
  }

  has(hash: number): boolean {
    return this.map.has(hash >>> 0);
  }

  /** Returns the known name for a hash, or `hash_XXXXXXXX` when unknown. */
  get(hash: number): string {
    const h = hash >>> 0;
    if (h === 0) return '';
    return this.map.get(h) ?? `hash_${h.toString(16).toUpperCase().padStart(8, '0')}`;
  }
}

/** Shader parameter names worth resolving (samplers and common params). */
export const SHADER_PARAM_NAMES = [
  'DiffuseSampler', 'DiffuseSampler2', 'DiffuseSampler3', 'DiffuseTexSampler', 'DiffuseTextureSampler',
  'BumpSampler', 'BumpSampler2', 'BumpSampler3', 'NormalSampler', 'SpecSampler', 'SpecularSampler',
  'DetailSampler', 'DetailSampler2', 'DirtSampler', 'DamageSampler', 'EnvironmentSampler', 'PlateBgSampler',
  'PlateBgBumpSampler', 'TintPaletteSampler', 'TextureSamplerDiffPal', 'DistanceMapSampler', 'heightSampler',
  'heightMapSamplerLayer0', 'heightMapSamplerLayer1', 'heightMapSamplerLayer2', 'heightMapSamplerLayer3',
  'TextureSampler_layer0', 'TextureSampler_layer1', 'TextureSampler_layer2', 'TextureSampler_layer3',
  'BumpSampler_layer0', 'BumpSampler_layer1', 'BumpSampler_layer2', 'BumpSampler_layer3',
  'lookupSampler', 'WrinkleMaskSampler_0', 'WrinkleMaskSampler_1', 'WrinkleMaskSampler_2',
  'WrinkleMaskSampler_3', 'WrinkleMaskSampler_4', 'WrinkleMaskSampler_5', 'WrinkleSampler_A', 'WrinkleSampler_B',
  'DiffuseHfSampler', 'DiffuseNoiseSampler', 'StubbleSampler', 'NoiseSampler', 'FlowSampler', 'FoamSampler',
  'SnowSampler', 'SnowSampler0', 'SnowSampler1', 'AnisoNoiseSpecSampler', 'ComboHeightSamplerFur',
  'ComboHeightSamplerFur2', 'ComboHeightSamplerFur3', 'ComboHeightSamplerFur4', 'DiffuseExtraSampler',
  'MaskSampler', 'EmissiveSampler', 'ColorShiftSampler', 'OcclusionSampler', 'VolumeSampler', 'grassSampler',
  'MultiplicationSampler', 'DiffuseTexture', 'NormalTexture', 'SpecularTexture',
];

/** GTA V shader names (the .sps presets). */
export const SHADER_NAMES = [
  'default', 'default_detail', 'default_noedge', 'default_spec', 'default_terrain_wet', 'default_um', 'default_tnt',
  'normal', 'normal_alpha', 'normal_cubemap_reflect', 'normal_decal', 'normal_decal_pxm', 'normal_decal_pxm_tnt',
  'normal_decal_tnt', 'normal_detail', 'normal_detail_dpm', 'normal_detail_dpm_tnt', 'normal_detail_dpm_wrap',
  'normal_diffspec', 'normal_diffspec_detail', 'normal_diffspec_detail_dpm', 'normal_diffspec_detail_dpm_tnt',
  'normal_diffspec_detail_dpm_wrap', 'normal_diffspec_detail_tnt', 'normal_diffspec_tnt', 'normal_pxm',
  'normal_pxm_tnt', 'normal_reflect', 'normal_reflect_alpha', 'normal_reflect_decal', 'normal_screendooralpha',
  'normal_spec', 'normal_spec_alpha', 'normal_spec_batch', 'normal_spec_cubemap_reflect', 'normal_spec_decal',
  'normal_spec_decal_detail', 'normal_spec_decal_nopuddle', 'normal_spec_decal_pxm', 'normal_spec_decal_tnt',
  'normal_spec_detail', 'normal_spec_detail_dpm', 'normal_spec_detail_dpm_tnt', 'normal_spec_detail_dpm_texture_tnt',
  'normal_spec_detail_dpm_vertdecal_tnt', 'normal_spec_detail_tnt', 'normal_spec_dpm', 'normal_spec_emissive',
  'normal_spec_pxm', 'normal_spec_pxm_tnt', 'normal_spec_reflect', 'normal_spec_reflect_alpha',
  'normal_spec_reflect_decal', 'normal_spec_reflect_emissivenight', 'normal_spec_reflect_emissivenight_alpha',
  'normal_spec_screendooralpha', 'normal_spec_tnt', 'normal_spec_twiddle', 'normal_spec_um', 'normal_spec_wrinkle',
  'normal_terrain_wet', 'normal_tnt', 'normal_tnt_alpha', 'normal_tnt_pxm', 'normal_um', 'normal_um_tnt',
  'normal_wind', 'spec', 'spec_alpha', 'spec_const', 'spec_decal', 'spec_reflect', 'spec_reflect_alpha',
  'spec_reflect_decal', 'spec_screendooralpha', 'spec_tnt', 'spec_twiddle_tnt', 'emissive', 'emissive_additive_alpha',
  'emissive_additive_uv_alpha', 'emissive_alpha', 'emissive_alpha_tnt', 'emissive_clip', 'emissive_speclum',
  'emissive_tnt', 'emissivenight', 'emissivenight_alpha', 'emissivenight_geomnightonly', 'emissivestrong',
  'emissivestrong_alpha', 'alpha', 'cutout', 'cutout_fence', 'cutout_fence_normal', 'cutout_hard', 'cutout_spec_tnt',
  'cutout_tnt', 'cutout_um', 'decal', 'decal_amb_only', 'decal_diff_only_um', 'decal_dirt', 'decal_emissive_only',
  'decal_emissivenight_only', 'decal_glue', 'decal_normal_blend_2lyr', 'decal_normal_only', 'decal_normal_spec_um',
  'decal_shadow_only', 'decal_spec_only', 'decal_tnt', 'glass', 'glass_breakable', 'glass_breakable_screendooralpha',
  'glass_displacement', 'glass_emissive', 'glass_emissive_alpha', 'glass_emissivenight', 'glass_emissivenight_alpha',
  'glass_env', 'glass_normal_spec_reflect', 'glass_pv', 'glass_pv_env', 'glass_reflect', 'glass_spec',
  'grass', 'grass_batch', 'grass_camera_aligned', 'grass_fur', 'grass_fur_mask', 'grass_fur_tnt', 'gta_alpha',
  'gta_cutout', 'gta_decal', 'gta_default', 'gta_emissive', 'gta_emissivenight', 'gta_normal', 'gta_spec',
  'mirror_crack', 'mirror_decal', 'mirror_default', 'ped', 'ped_alpha', 'ped_cloth', 'ped_cloth_enveff',
  'ped_decal', 'ped_decal_decoration', 'ped_decal_expensive', 'ped_decal_medals', 'ped_decal_nodiff',
  'ped_default', 'ped_default_cloth', 'ped_default_enveff', 'ped_default_mp', 'ped_default_palette',
  'ped_emissive', 'ped_enveff', 'ped_fur', 'ped_hair_cutout_alpha', 'ped_hair_spiked', 'ped_nopeddamagedecals',
  'ped_palette', 'ped_wrinkle', 'ped_wrinkle_cloth', 'ped_wrinkle_cloth_enveff', 'ped_wrinkle_cs',
  'ped_wrinkle_enveff', 'parallax', 'parallax_specmap', 'parallax_steep', 'radar', 'reflect', 'reflect_alpha',
  'reflect_decal', 'sky_system', 'terrain_cb_4lyr', 'terrain_cb_4lyr_2tex', 'terrain_cb_4lyr_2tex_blend',
  'terrain_cb_4lyr_2tex_blend_lod', 'terrain_cb_4lyr_2tex_blend_pxm', 'terrain_cb_4lyr_2tex_blend_pxm_spm',
  'terrain_cb_4lyr_2tex_pxm', 'terrain_cb_4lyr_cm', 'terrain_cb_4lyr_cm_pxm', 'terrain_cb_4lyr_cm_pxm_tnt',
  'terrain_cb_4lyr_cm_tnt', 'terrain_cb_4lyr_lod', 'terrain_cb_4lyr_pxm', 'terrain_cb_4lyr_pxm_spm',
  'terrain_cb_4lyr_spec', 'terrain_cb_4lyr_spec_int', 'terrain_cb_4lyr_spec_int_pxm', 'terrain_cb_4lyr_spec_pxm',
  'terrain_cb_w_4lyr', 'terrain_cb_w_4lyr_2tex', 'terrain_cb_w_4lyr_2tex_blend', 'terrain_cb_w_4lyr_2tex_blend_lod',
  'terrain_cb_w_4lyr_2tex_blend_pxm', 'terrain_cb_w_4lyr_2tex_blend_pxm_spm', 'terrain_cb_w_4lyr_2tex_pxm',
  'terrain_cb_w_4lyr_cm', 'terrain_cb_w_4lyr_cm_pxm', 'terrain_cb_w_4lyr_cm_pxm_tnt', 'terrain_cb_w_4lyr_cm_tnt',
  'terrain_cb_w_4lyr_lod', 'terrain_cb_w_4lyr_pxm', 'terrain_cb_w_4lyr_pxm_spm', 'terrain_cb_w_4lyr_spec',
  'terrain_cb_w_4lyr_spec_int', 'terrain_cb_w_4lyr_spec_int_pxm', 'terrain_cb_w_4lyr_spec_pxm', 'trees',
  'trees_camera_aligned', 'trees_camera_facing', 'trees_lod', 'trees_lod2', 'trees_lod_tnt', 'trees_normal',
  'trees_normal_diffspec', 'trees_normal_diffspec_tnt', 'trees_normal_spec', 'trees_normal_spec_camera_aligned',
  'trees_normal_spec_camera_aligned_tnt', 'trees_normal_spec_camera_facing', 'trees_normal_spec_camera_facing_tnt',
  'trees_normal_spec_tnt', 'trees_normal_spec_wind', 'trees_shadow_proxy', 'trees_tnt', 'vehicle_badges',
  'vehicle_basic', 'vehicle_blurredrotor', 'vehicle_blurredrotor_emissive', 'vehicle_cloth', 'vehicle_cloth2',
  'vehicle_cutout', 'vehicle_dash_emissive', 'vehicle_dash_emissive_opaque', 'vehicle_decal', 'vehicle_decal2',
  'vehicle_detail', 'vehicle_detail2', 'vehicle_emissive_alpha', 'vehicle_emissive_opaque', 'vehicle_generic',
  'vehicle_interior', 'vehicle_interior2', 'vehicle_licenseplate', 'vehicle_lights', 'vehicle_lightsemissive',
  'vehicle_lightsemissive_siren', 'vehicle_mesh', 'vehicle_mesh2_enveff', 'vehicle_mesh_enveff', 'vehicle_paint1',
  'vehicle_paint1_enveff', 'vehicle_paint2', 'vehicle_paint2_enveff', 'vehicle_paint3', 'vehicle_paint3_enveff',
  'vehicle_paint3_lvr', 'vehicle_paint4', 'vehicle_paint4_emissive', 'vehicle_paint4_enveff', 'vehicle_paint5_enveff',
  'vehicle_paint6', 'vehicle_paint6_enveff', 'vehicle_paint7', 'vehicle_paint7_enveff', 'vehicle_paint8',
  'vehicle_paint9', 'vehicle_shuts', 'vehicle_tire', 'vehicle_tire_emissive', 'vehicle_track', 'vehicle_track2',
  'vehicle_track2_emissive', 'vehicle_track_ammo', 'vehicle_track_emissive', 'vehicle_track_siren',
  'vehicle_vehglass', 'vehicle_vehglass_inner', 'water_decal', 'water_foam', 'water_fountain', 'water_mesh',
  'water_poolenv', 'water_river', 'water_riverfoam', 'water_riverlod', 'water_riverocean', 'water_rivershallow',
  'water_shallow', 'water_terrainfoam', 'weapon_emissive_tnt', 'weapon_emissivestrong_alpha',
  'weapon_normal_spec_alpha', 'weapon_normal_spec_cutout_palette', 'weapon_normal_spec_detail_palette',
  'weapon_normal_spec_detail_tnt', 'weapon_normal_spec_palette', 'weapon_normal_spec_tnt', 'cable', 'clouds_altitude',
  'clouds_anim', 'clouds_animsoft', 'clouds_fast', 'clouds_fog', 'clouds_soft', 'distance_map', 'minimap',
  'ptfx_model', 'billboard_nobump', 'blend_2lyr', 'normal_decal_pxm', 'custom',
];

export const SHADER_FILE_NAMES = SHADER_NAMES.map((n) => `${n}.sps`);
