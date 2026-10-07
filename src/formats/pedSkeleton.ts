/**
 * The standard GTA V ped skeleton (body and fingers), used to preview ped
 * animations without a ped model. Bones are identified by their tag (the id
 * animations use). Offsets are relative to the parent bone, in metres; the
 * rotations are a neutral standing pose used for bones a clip doesn't animate.
 * Bone chains run along each bone's local +X axis.
 */
export interface PedBone {
  tag: number;
  name: string;
  /** Parent bone tag, or -1 for the root. */
  parent: number;
  offset: [number, number, number];
  rotation: [number, number, number, number];
}

const TABLE: [number, string, number, [number, number, number], [number, number, number, number]][] = [
  [0, 'SKEL_ROOT', -1, [0, 0, 0], [0, 0, 0, 1]],
  [11816, 'SKEL_Pelvis', 0, [0, 0, 0], [0, 0.707, 0, 0.707]],
  [58271, 'SKEL_L_Thigh', 11816, [0.074, 0, -0.096], [-0.02, 0.061, -0.02, 0.998]],
  [63931, 'SKEL_L_Calf', 58271, [0.407, 0, 0], [0, 0, -0.021, 1]],
  [14201, 'SKEL_L_Foot', 63931, [0.415, 0, 0], [-0.193, 0.078, 0.593, 0.778]],
  [2108, 'SKEL_L_Toe0', 14201, [0.162, -0.002, 0], [0.994, 0.109, 0.008, 0.013]],
  [51826, 'SKEL_R_Thigh', 11816, [0.074, 0, 0.096], [0.02, -0.043, -0.02, 0.999]],
  [36864, 'SKEL_R_Calf', 51826, [0.407, 0, 0], [0, 0, -0.021, 1]],
  [52301, 'SKEL_R_Foot', 36864, [0.415, 0, 0], [0.183, -0.087, 0.592, 0.78]],
  [20781, 'SKEL_R_Toe0', 52301, [0.162, -0.002, 0], [-0.994, -0.108, 0.01, 0.026]],
  [57597, 'SKEL_Spine_Root', 0, [0, 0, 0], [0, -0.707, 0, 0.707]],
  [23553, 'SKEL_Spine0', 57597, [0.019, -0.01, 0], [0, 0, -0.048, 0.999]],
  [24816, 'SKEL_Spine1', 23553, [0.085, 0, 0], [0, 0, 0.044, 0.999]],
  [24817, 'SKEL_Spine2', 24816, [0.086, 0, 0], [0, 0, -0.024, 1]],
  [24818, 'SKEL_Spine3', 24817, [0.113, 0, 0], [0, 0, 0.033, 0.999]],
  [39317, 'SKEL_Neck_1', 24818, [0.248, 0, 0], [0, 0, 0.109, 0.994]],
  [31086, 'SKEL_Head', 39317, [0.113, 0, 0], [0, 0, -0.12, 0.993]],
  [64729, 'SKEL_L_Clavicle', 24818, [0.218, 0.036, 0.032], [0.063, -0.786, -0.057, 0.613]],
  [45509, 'SKEL_L_UpperArm', 64729, [0.182, 0, 0], [0.155, -0.515, 0.171, 0.826]],
  [61163, 'SKEL_L_Forearm', 45509, [0.274, 0, 0], [0.003, -0.087, 0.039, 0.995]],
  [18905, 'SKEL_L_Hand', 61163, [0.259, 0, 0], [0.22, 0, 0, 0.975]],
  [26610, 'SKEL_L_Finger00', 18905, [0.026, 0.023, 0.001], [-0.174, -0.067, 0.167, 0.968]],
  [4089, 'SKEL_L_Finger01', 26610, [0.056, 0, 0], [0.005, 0.012, -0.144, 0.989]],
  [4090, 'SKEL_L_Finger02', 4089, [0.036, 0, 0], [0.002, 0.01, -0.035, 0.999]],
  [26611, 'SKEL_L_Finger10', 18905, [0.107, 0.029, -0.021], [-0.566, -0.315, -0.338, 0.683]],
  [4169, 'SKEL_L_Finger11', 26611, [0.047, 0, 0], [-0.002, -0.035, -0.627, 0.778]],
  [4170, 'SKEL_L_Finger12', 4169, [0.024, 0, 0], [-0.001, -0.012, -0.536, 0.844]],
  [26612, 'SKEL_L_Finger20', 18905, [0.106, 0.005, -0.023], [-0.661, -0.256, -0.279, 0.648]],
  [4185, 'SKEL_L_Finger21', 26612, [0.052, 0, 0], [0.004, -0.016, -0.758, 0.652]],
  [4186, 'SKEL_L_Finger22', 4185, [0.033, 0, 0], [-0.001, -0.033, -0.646, 0.763]],
  [26613, 'SKEL_L_Finger30', 18905, [0.1, -0.018, -0.013], [-0.769, -0.156, -0.24, 0.572]],
  [4137, 'SKEL_L_Finger31', 26613, [0.045, 0, 0], [0.002, 0, -0.778, 0.629]],
  [4138, 'SKEL_L_Finger32', 4137, [0.031, 0, 0], [-0.02, -0.019, -0.716, 0.697]],
  [26614, 'SKEL_L_Finger40', 18905, [0.094, -0.034, 0.002], [-0.837, 0.004, -0.157, 0.525]],
  [4153, 'SKEL_L_Finger41', 26614, [0.038, 0, 0], [0.018, -0.018, -0.856, 0.517]],
  [4154, 'SKEL_L_Finger42', 4153, [0.023, 0, 0], [-0.012, -0.019, -0.68, 0.733]],
  [10706, 'SKEL_R_Clavicle', 24818, [0.218, 0.036, -0.032], [-0.032, 0.787, -0.033, 0.615]],
  [40269, 'SKEL_R_UpperArm', 10706, [0.182, 0, 0], [-0.2, 0.513, 0.199, 0.811]],
  [28252, 'SKEL_R_Forearm', 40269, [0.274, 0, 0], [-0.003, 0.07, 0.039, 0.997]],
  [57005, 'SKEL_R_Hand', 28252, [0.259, 0, 0], [-0.197, 0, 0, 0.98]],
  [58866, 'SKEL_R_Finger00', 57005, [0.026, 0.023, -0.001], [0.205, 0.026, 0.229, 0.951]],
  [64016, 'SKEL_R_Finger01', 58866, [0.056, 0, 0], [-0.006, -0.017, -0.144, 0.989]],
  [64017, 'SKEL_R_Finger02', 64016, [0.036, 0, 0], [-0.002, -0.01, -0.062, 0.998]],
  [58867, 'SKEL_R_Finger10', 57005, [0.107, 0.029, 0.021], [-0.689, 0.325, 0.304, 0.572]],
  [64096, 'SKEL_R_Finger11', 58867, [0.047, 0, 0], [0.002, -0.035, 0.631, 0.775]],
  [64097, 'SKEL_R_Finger12', 64096, [0.024, 0, 0], [0.002, -0.012, 0.478, 0.878]],
  [58868, 'SKEL_R_Finger20', 57005, [0.106, 0.005, 0.023], [-0.585, 0.393, 0.374, 0.603]],
  [64112, 'SKEL_R_Finger21', 58868, [0.052, 0, 0], [-0.003, -0.017, 0.717, 0.697]],
  [64113, 'SKEL_R_Finger22', 64112, [0.033, 0, 0], [0.008, -0.032, 0.443, 0.896]],
  [58869, 'SKEL_R_Finger30', 57005, [0.1, -0.018, 0.013], [-0.499, 0.369, 0.333, 0.71]],
  [64064, 'SKEL_R_Finger31', 58869, [0.045, 0, 0], [-0.002, 0, 0.718, 0.696]],
  [64065, 'SKEL_R_Finger32', 64064, [0.031, 0, 0], [0.024, -0.014, 0.531, 0.847]],
  [58870, 'SKEL_R_Finger40', 57005, [0.094, -0.034, -0.002], [-0.441, 0.326, 0.279, 0.789]],
  [64080, 'SKEL_R_Finger41', 58870, [0.038, 0, 0], [-0.013, -0.021, 0.703, 0.711]],
  [64081, 'SKEL_R_Finger42', 64080, [0.023, 0, 0], [0.013, -0.018, 0.64, 0.768]],
];

/** Parents always come before their children. */
export const PED_BONES: PedBone[] = TABLE.map(([tag, name, parent, offset, rotation]) => ({ tag, name, parent, offset, rotation }));

const BY_TAG = new Map(PED_BONES.map((b) => [b.tag, b]));

/** Other well-known ped bone tags, for naming tracks. */
const EXTRA_NAMES: Record<number, string> = {
  12844: 'IK_Head',
  65068: 'FACIAL_facialRoot',
  28422: 'PH_R_Hand',
  60309: 'PH_L_Hand',
  6286: 'IK_R_Hand',
  36029: 'IK_L_Hand',
  35502: 'IK_R_Foot',
  65245: 'IK_L_Foot',
  24806: 'PH_R_Foot',
  57717: 'PH_L_Foot',
  56604: 'IK_Root',
  2992: 'MH_R_Elbow',
  22711: 'MH_L_Elbow',
  16335: 'MH_R_Knee',
  46078: 'MH_L_Knee',
  43810: 'RB_R_ForeArmRoll',
  61007: 'RB_L_ForeArmRoll',
  37119: 'RB_R_ArmRoll',
  5232: 'RB_L_ArmRoll',
  6442: 'RB_R_ThighRoll',
  23639: 'RB_L_ThighRoll',
  35731: 'RB_Neck_1',
};

export function pedBone(tag: number): PedBone | undefined {
  return BY_TAG.get(tag);
}

export function pedBoneName(tag: number): string | undefined {
  return BY_TAG.get(tag)?.name ?? EXTRA_NAMES[tag];
}

/**
 * Whether bone tags look like a ped animation: they drive the pelvis, spine or
 * limbs of the standard skeleton (not just the root, which every clip has).
 */
export function isPedAnimation(boneTags: Iterable<number>): boolean {
  let hits = 0;
  for (const tag of boneTags) if (tag !== 0 && (BY_TAG.has(tag) || tag in EXTRA_NAMES)) hits++;
  return hits >= 3;
}
