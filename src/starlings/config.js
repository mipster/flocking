// Tuning constants for the starling murmuration page (starlings.html). Units are roughly metres.
import { vecConsts } from '../webgpu/config.js';

/**
 * Half extents of the simulated sky box; the home region keeps the flock well inside it. The sim's
 * floor barrier (the sea-floor function, about 50 m below the box centre) doubles as the lake: the
 * camera sits just above it, so birds never dip below the horizon.
 */
export const SKY_BOX = [128, 64, 128];
const WATER_Y = -46;

/** Bird counts offered in the panel, and the default. */
export const BIRD_COUNTS = { '16k': 16384, '32k': 32768, '65k': 65536, '131k': 131072 };
export const DEFAULT_BIRDS = 32768;

/** Starlings never hover: the slowest they fly, as a fraction of their top speed. */
export const MIN_SPEED = 0.75;

/** Neighbour samples per grid cell (see GpuBoids `maxPerCell`). */
export const SAMPLES_PER_CELL = 12;

/**
 * Home region: a soft ellipsoid the flock is pulled back into. Its centre drifts slowly
 * (amplitude `drift`, one period in seconds per axis) so the flock keeps streaming and folding.
 */
export const HOME = {
  center: [0, WATER_Y + 28, 0],
  radius: [50, 14, 22],
  strength: 2,
  drift: [26, 6, 16],
  periods: [71, 43, 53],
};

/**
 * Hawk: flies a curved pass through the flock, then waits `interval` seconds (random in the range)
 * before the next. `approach` is how far from its aim point it starts and ends, `height` how much
 * higher it starts (it dives in), `aimJitter` how far from the flock centre it aims.
 * Starlings within `fearRadius` flee with strength `fearWeight` (x their maxForce).
 */
export const HAWK = {
  speed: 30,
  approach: 110,
  height: 26,
  aimJitter: 10,
  interval: [8, 15],
  firstDelay: 5,
  fearRadius: 16,
  fearWeight: 5,
  wingspan: 1.4,
  flapRate: 7,
};

/**
 * Fixed viewpoint near the water, looking up at the flock. There are deliberately no view controls:
 * the page is a painting-like view, with the flock simulated in 3D only for depth and density.
 */
export const VIEW = {
  position: [0, WATER_Y + 2, 175],
  target: [0, WATER_Y + 22, 0],
  fov: 46,
  near: 0.5,
  far: 3000,
};

/**
 * Birds are drawn as dark soft specks: `wingspan` and `thickness` in metres, never smaller than
 * `minPixels` on screen (then fainter instead, so distant birds don't look heavier than they are).
 * Wings flap at the sim's swim phase; `glide` is the share of birds gliding at any moment.
 * `haze` blends distant birds toward the sky behind them.
 */
export const BIRD_LOOK = {
  color: [0.09, 0.07, 0.12],
  wingspan: 0.55,
  thickness: 0.2,
  minPixels: 1.3,
  opacity: 0.9,
  flap: 0.55,
  glide: 0.4,
  haze: 0.0016,
};

/**
 * Dusk scene painted behind the flock, as a function of view direction: sky gradient, low sun,
 * two ranges of hills, a calm lake reflecting them, and reeds in the foreground.
 * Angles are radians: azimuth 0 looks down -z, elevation 0 is the horizon.
 */
export const SCENE = {
  zenith: [0.15, 0.12, 0.26],
  mid: [0.44, 0.33, 0.47],
  horizon: [0.97, 0.72, 0.48],
  sunAzimuth: 0.2,
  sunElevation: 0.022,
  sunSize: 0.022,
  sunColor: [1.0, 0.96, 0.84],
  glowColor: [1.0, 0.7, 0.42],
  farHills: [0.5, 0.38, 0.5],
  nearHills: [0.32, 0.23, 0.35],
  water: [0.78, 0.72, 0.82],
  reeds: [0.05, 0.04, 0.07],
  reedTop: 0.02,
  reedSparse: 0.62,
  reedWidth: 0.0006,
  reedSway: 0.004,
};

/** World-space direction toward the sun. */
export function sunDirection() {
  const { sunAzimuth: a, sunElevation: e } = SCENE;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
}

/** WGSL constants for starlings.wgsl. */
export function starlingHeader() {
  return `
${vecConsts('BIRD', BIRD_LOOK)}
${vecConsts('SCENE', SCENE)}
const SUN_DIR = vec3f(${sunDirection().join(', ')});
const HAWK_WINGSPAN = ${HAWK.wingspan};
`;
}
