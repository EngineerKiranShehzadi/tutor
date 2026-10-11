// Avatar configuration. Change AVATAR_MODEL_URL to use a different VRM
// (check its license — see public/avatar/ATTRIBUTION.md).
export const AVATAR_MODEL_URL = '/avatar/teacher.vrm';

// The model faces +Z in VRM 1.0. These signs map the *semantic* arm pose used
// by the animation driver onto the VRM normalised-humanoid bone axes.
export const ARM_AXIS = {
  // upperArm.rotation.z that lowers the arm from the T-pose (left arm is on +X)
  lowerSignLeft: -1,
  lowerSignRight: 1,
  // upperArm.rotation.x that swings the (lowered) arm forward
  forwardSign: -1,
  // lowerArm.rotation.y that bends the elbow so the hand comes forward
  elbowSignLeft: -1,
  elbowSignRight: 1,
  // hand twist
  wristSignLeft: -1,
  wristSignRight: 1,
} as const;

// Arms hang straight down along the body in every state (idle, listening,
// thinking, speaking). Set to true to re-enable the small procedural
// hand/arm gestures while speaking (head nods and breathing are unaffected).
export const ARM_GESTURES_ENABLED = false;

// ── Avatar presentation mode ─────────────────────────────────────────────
// 'portrait' — the supplied Pixar-style teacher illustration, animated in 2D
//              (breathing, head movement, blinking, speech-driven mouth).
//              NOT a 3D model.
// 'vrm'      — a rigged 3D VRM model (AVATAR_MODEL_URL) rendered with WebGL.
export type AvatarMode = 'portrait' | 'vrm';
export const AVATAR_MODE: AvatarMode = 'portrait';

// Available portraits. Positions are the facial features' centres as a
// percentage of that image's width/height.
export const PORTRAITS = {
  // The institute's instructor (photo cut-out, background removed) on a drawn
  // cream kurta. Two layers: the body stays still and only the head moves,
  // pivoting at the neck, so the figure does not look like it is floating.
  instructor: {
    url: '/avatar/teacher-instructor.png',
    headUrl: '/avatar/teacher-instructor-head.png',
    bodyUrl: '/avatar/teacher-instructor-body.png',
    headPivot: { x: 48, y: 61 },
    blink: true,
    // iris centres behind the glasses; lids are kept small so the frames stay visible
    eyeLeft:  { x: 41.0, y: 30.4 },
    eyeRight: { x: 52.3, y: 31.4 },
    eyeWidthPct: 7.6,
    eyeHeightPct: 3.4,
    mouth:    { x: 46.3, y: 43.4 },
    mouthWidthPct: 10.4,
    mouthMaxOpenPct: 4.4,
    jawDropPct: 3.6,       // lower face drop at full mouth opening (% of image height)
    eyelidLeft:  { top: '#a07f73', bottom: '#b79284' },
    eyelidRight: { top: '#9a786b', bottom: '#b08c7e' },
  },
  // Pixar-style illustration supplied as a look reference.
  cartoon: {
    url: '/avatar/teacher-portrait.png',
    headUrl: undefined,
    bodyUrl: undefined,
    headPivot: { x: 50, y: 78 },
    blink: true,
    eyeLeft:  { x: 44.2, y: 33.2 },
    eyeRight: { x: 63.3, y: 34.5 },
    eyeWidthPct: 9.6,
    eyeHeightPct: 3.8,
    mouth:    { x: 51.8, y: 50.4 },
    mouthWidthPct: 9.6,
    mouthMaxOpenPct: 6.0,
    jawDropPct: 0,
    // skin tones sampled around each eye in the illustration (left eye sits in shadow)
    eyelidLeft:  { top: '#c68665', bottom: '#d5906d' },
    eyelidRight: { top: '#daa480', bottom: '#eab08a' },
  },
} as const;

export type PortraitKey = keyof typeof PORTRAITS;
export const ACTIVE_PORTRAIT: PortraitKey = 'instructor';

export const PORTRAIT_LAYOUT = {
  ...PORTRAITS[ACTIVE_PORTRAIT],
  // colours shared by both portraits
  mouthInner: '#3b1512',
  lipEdge: '#a8554d',
  // head movement strength (px at the source image size)
  moveYawPx: 38,
  movePitchPx: 34,
  rollDegPerRad: 36,
} as const;

export const PORTRAIT_IMAGE_URL = PORTRAIT_LAYOUT.url;
