// Tuning constants for the starling murmuration page (starlings.html). Units are roughly metres.
import { vecConsts } from '../webgpu/config.js';

/**
 * Half extents of the simulated sky box; the roost keeps the flock well inside it. The lake surface
 * at WATER_Y is the sim's flat ground: birds are pushed up within the wall margin (10 m) of it and
 * can never go below it. The camera sits just above it, so birds never dip below the horizon.
 */
export const SKY_BOX = [128, 64, 128];
export const WATER_Y = -46;

/** Bird counts offered in the panel, and the default. */
export const BIRD_COUNTS = { '16k': 16384, '32k': 32768, '65k': 65536, '131k': 131072 };
export const DEFAULT_BIRDS = 32768;

/** Starlings never hover: the slowest they fly, as a fraction of their top speed. */
export const MIN_SPEED = 0.75;

/**
 * Neighbour grid: cell edge in metres and samples per cell (see GpuBoids). In the dense core a
 * starling's 7 nearest neighbours are within about 1.5 m, so cells must be small enough that the
 * samples taken from them are mostly those neighbours.
 */
export const GRID = { cellSize: 3, samplesPerCell: 16 };

/**
 * Banked flight (see packSimParams `flight`): birds cruise at `cruise` x top speed, take `rollTime`
 * seconds to roll into a turn, and `level` (1/s) damps climbing and diving so the flock flies flat.
 */
export const FLIGHT = { cruise: 0.85, speedTime: 0.6, level: 3, rollTime: 0.25 };

/**
 * Roost: the flock is always drawn horizontally toward the centre (full strength at the ellipsoid's
 * edge) and kept within its height; with banked flight the birds circle it. The centre drifts
 * slowly (amplitude `drift`, one period in seconds per axis) so the circling keeps changing shape.
 */
export const HOME = {
  center: [0, WATER_Y + 28, 0],
  radius: [50, 14, 22],
  strength: 2.5,
  drift: [26, 6, 16],
  periods: [71, 43, 53],
};

/**
 * Hawk: flies a curved pass through the flock, then waits `interval` seconds (random in the range)
 * before the next. `approach` is how far from its aim point it starts and ends, `height` how much
 * higher it starts (it dives in), `aimJitter` how far from the flock centre it aims.
 * Starlings the hawk will pass within `fearRadius` of in the next `warning` seconds dodge out of
 * its path with strength `fearWeight` (x their maxForce).
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
  warning: 1.2, // seconds ahead starlings judge the hawk's path (it covers speed x warning metres)
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
  thickness: 0.2, // wing chord: how deep a bird looks seen face-on, from above or below
  edgeThickness: 0.05, // the same seen edge-on, wings level with the line of sight
  // turns are banked: lift tilts toward the turn by atan(lateral acceleration / gravity), so tight
  // turns roll wings toward or away from the camera and dark bands sweep through the flock
  bankGravity: 9.8,
  bankSmoothing: 0.2, // seconds of velocity history the turn rate is measured over
  minPixels: 1.3,
  opacity: 0.9,
  flap: 0.55,
  glide: 0.4,
  haze: 0.0016,
};

/**
 * Reflection of the flock in the lake: the birds are drawn again mirrored in the water plane into a
 * texture at `scale` x the screen size, as plain coverage, then the lake samples it through its
 * ripples. Each speck is at least `minTexels` of that texture across (and fainter to match): a
 * speck under about one texel pops on and off as it moves, which makes the reflection flicker.
 * `strength` is a gain on that coverage (capped at fully dark); `ripple` the sideways wobble and `streak` the
 * vertical smear, both as fractions of the screen.
 */
export const REFLECTION = {
  scale: 0.25,
  minTexels: 3,
  strength: 1,
  ripple: 0.006,
  streak: 0.006,
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
  const { scale, minTexels, strength, ripple, streak } = REFLECTION;
  return `
${vecConsts('BIRD', BIRD_LOOK)}
${vecConsts('SCENE', SCENE)}
const SUN_DIR = vec3f(${sunDirection().join(', ')});
const HAWK_WINGSPAN = ${HAWK.wingspan};
const WATER_Y = ${WATER_Y};
${vecConsts('REFLECT', { strength, ripple, streak })}
const REFLECT_MIN_PIXELS = ${minTexels / scale}; // in screen pixels
`;
}
