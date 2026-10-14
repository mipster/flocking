// Tuning constants for the WebGPU engine, in one place.
// Anything the shaders need is injected as WGSL `const`s by wgslHeader() so JS and WGSL
// can never drift apart.

/** Spatial grid cell edge, in world units. Neighbor search scans cells within the species' radius. */
export const CELL_SIZE = 8;

/** Compute workgroup size; must match `@workgroup_size` in sim.wgsl. */
export const WORKGROUP_SIZE = 64;

/** Distance from the tank edge where soft walls / the sea floor start pushing fish back. */
export const WALL_MARGIN = 10;

/**
 * How far above the sand / below the surface a fish centre may go, in world units:
 * base + fraction-of-body-length * species scale (belly under the fish, dorsal fin above).
 */
export const CLEARANCE = { base: 0.3, belly: 0.2, fin: 0.32 };

/** Default steering low-pass time constant in seconds (0 = off). Larger = calmer but slower to react. */
export const DEFAULT_STEERING_SMOOTHING = 0.1;

/**
 * Frames the viewer may have queued on the GPU at once. 1 makes CPU and GPU take turns; 2 lets the
 * CPU prepare the next frame while the GPU draws this one. More only adds input lag.
 */
export const FRAMES_IN_FLIGHT = 2;

/** Species count; the shaders index uniform arrays by species id. */
export const SPECIES_COUNT = 3;

/**
 * Fish are stored in species order, so the first `simpleSpecies` species (the small ones, which
 * are tiny on screen and make up nearly all the fish) are drawn with the light mesh.
 */
export const FISH_LOD = { simpleSpecies: 1 };

/** Radius of a sphere around a fish, in body lengths, used to cull fish outside the view. */
export const FISH_BOUNDING_RADIUS = 0.75;

/** Fish tail motion (fraction of body length; radians per body length). */
export const TAIL = { amplitude: 0.14, wavenumber: 7.0 };

/** Height of the point the camera looks at by default, a little under the tank top. */
export const DEFAULT_LOOK_HEIGHT = 25;

export const CAMERA = {
  fovDegrees: 55,
  near: 1,
  far: 3000,
  startDistance: 260,
  startPitch: -0.1, // camera starts below the surface, looking up through the flock at it
  minDistance: 20,
  maxDistance: 700,
  maxPitch: 1.5, // radians; stops just short of straight up or down
  dragSensitivity: 0.005, // radians per pixel dragged
  zoomSensitivity: 0.001, // log-distance per wheel delta unit
};

export const LIGHT_DIRECTION = [0.3, 1.0, 0.4]; // toward the sun, normalised on upload
/**
 * Water optics (Beer-Lambert). Light and view rays lose each colour channel at its own rate,
 * red first, so distance and depth push everything toward blue-green.
 */
export const WATER = {
  /** Extinction per world unit for (r, g, b) at murkiness 1. */
  absorption: [0.009, 0.0032, 0.0018],
  /** Colour of the veiling light (in-scatter) in clear water just under the surface. */
  scatter: [0.03, 0.2, 0.32],
  /** How quickly veiling light dims with depth, as a fraction of the absorption rate. */
  deepFade: 0.6,
};

/**
 * Surface waves (Gerstner). Directions are in the x/z plane; wavelength and amplitude in world
 * units. The mean water level sits above the tank top by the summed amplitude, so troughs never
 * dip below the height fish are allowed to reach.
 */
export const WAVES = [
  { direction: [1.0, 0.25], amplitude: 0.8, wavelength: 90 },
  { direction: [0.6, 0.8], amplitude: 0.5, wavelength: 55 },
  { direction: [-0.3, 1.0], amplitude: 0.3, wavelength: 31 },
  { direction: [-0.9, -0.4], amplitude: 0.2, wavelength: 19 },
];

/**
 * Fine ripples: too short for the 3-unit mesh, so they only shape normals and caustics (no
 * displacement). Their headings are spread out and their focusing strength (amplitude * k^2) is
 * similar, so the caustics form a web rather than parallel streaks.
 */
export const RIPPLES = [
  { direction: [0.7, -0.7], amplitude: 0.12, wavelength: 14 },
  { direction: [-0.5, 0.85], amplitude: 0.085, wavelength: 11 },
  { direction: [0.95, 0.3], amplitude: 0.055, wavelength: 8.5 },
  { direction: [-0.8, -0.6], amplitude: 0.042, wavelength: 7 },
  { direction: [0.1, 1.0], amplitude: 0.03, wavelength: 5.5 },
];
export const WAVE_STEEPNESS = 0.6; // 0 = sine waves, 1 = pointed crests that just stop looping
export const WAVE_AMPLITUDE_TOTAL = WAVES.reduce((sum, w) => sum + w.amplitude, 0);
const GRAVITY = 9.81;

/**
 * Per-wave shader constants: [dirX, dirZ, amplitude, k] and [angular speed, horizontal steepness].
 * Mesh waves come first, then ripples (which have zero horizontal steepness).
 */
export function waveTable() {
  const entry = (w, steepness) => {
    const len = Math.hypot(...w.direction);
    const k = (2 * Math.PI) / w.wavelength;
    return {
      shape: [w.direction[0] / len, w.direction[1] / len, w.amplitude, k],
      dynamics: [Math.sqrt(GRAVITY * k), steepness(k, w.amplitude)],
    };
  };
  return [
    ...WAVES.map((w) => entry(w, (k, a) => WAVE_STEEPNESS / (k * a * WAVES.length))),
    ...RIPPLES.map((w) => entry(w, () => 0)),
  ];
}
const WAVE_TOTAL = WAVES.length + RIPPLES.length;

/**
 * Caustics: sunlight focused by the wave surface onto whatever is below it.
 * - bend: how strongly a tilted wave facet deflects the refracted ray, per unit depth
 * - fade: how fast the pattern washes out with depth (per unit)
 * - base/gain: light = base + gain * focus, so un-focused areas stay lit and focus adds on top
 * - minDeterminant: floor on the lens Jacobian so focus stays finite on the caustic lines
 */
export const CAUSTICS = { bend: 0.18, fade: 0.015, base: 0.4, gain: 0.4, minDeterminant: 0.25 };
const WATER_REFRACTIVE_INDEX = 1.33;

/** Horizontal distance the refracted sun ray travels per unit of depth, as (x, z). */
export function sunTravelPerDepth() {
  const [lx, ly, lz] = LIGHT_DIRECTION;
  const horizontal = Math.hypot(lx, lz);
  if (horizontal === 0) return [0, 0];
  const sinIncident = horizontal / Math.hypot(horizontal, ly);
  const sinRefracted = sinIncident / WATER_REFRACTIVE_INDEX;
  const tanRefracted = sinRefracted / Math.sqrt(1 - sinRefracted * sinRefracted);
  // light travels away from the sun, i.e. opposite to the direction toward it
  return [(-lx / horizontal) * tanRefracted, (-lz / horizontal) * tanRefracted];
}

/**
 * Light shafts: sunlight scattered toward the camera by the water, integrated along each view ray
 * and modulated by the same wave focusing that makes the caustics, so beams sway with the waves.
 * - steps: samples per ray (jittered per pixel to hide banding)
 * - range: farthest distance marched, in world units
 * - waves: how many entries of the wave table shape the beams (finer ones would alias)
 * - scale: size of the shaft render target relative to the screen (it is soft, so half is fine)
 * - strength: overall brightness at slider value 1
 * - base/gain: density = base + gain * max(focus - 1, 0): a faint haze everywhere, beams where focused
 * - fade: how fast beam contrast washes out with depth (slower than the sand caustics)
 * - anisotropy: Henyey-Greenstein g; above 0 the haze is brighter looking toward the sun
 * - color: tint of the scattered light
 */
export const SHAFTS = {
  steps: 20,
  range: 220,
  waves: WAVES.length + 2, // mesh waves plus the two longest ripples
  scale: 0.5,
  strength: 0.008,
  base: 0.03,
  gain: 2.5,
  fade: 0.004,
  anisotropy: 0.35,
  color: [0.75, 0.95, 1.0],
};
export const DEFAULT_SHAFT_STRENGTH = 1;

/**
 * Patchy haze: the density the shafts scatter varies slowly in 3D, so the water is cloudy in
 * places and clear in others and beams look uneven.
 * - scale: size of a patch in world units
 * - drift: how fast the patches move sideways, in world units per second
 * - amount: 0 = uniform, 1 = patches range from clear to twice the average
 */
export const HAZE = { scale: 55, drift: 1.5, amount: 0.9 };

/**
 * Vignette: darkens the frame toward its corners, which frames the scene and draws the eye to
 * the middle. `inner`/`outer` are distances from the centre (0 = middle, 1 = corner) where the
 * darkening starts and reaches its full strength; the viewer's slider scales the strength.
 */
export const VIGNETTE = { inner: 0.4, outer: 1.0 };
export const DEFAULT_VIGNETTE = 0.5;

/**
 * Viewer-controlled scaling of the wave table (all three are 1 for the waves as listed in WAVES):
 * - height multiplies every amplitude (and so the mean water level above the tank top)
 * - scale multiplies every wavenumber (above 1 = shorter, choppier waves; keep it under
 *   WAVE_SCALE_MAX or the finest waves alias on the surface mesh)
 * - speed multiplies how fast the waves travel
 */
export const DEFAULT_WAVES = { height: 1, scale: 1, speed: 1 };
export const WAVE_SCALE_MAX = 1.5;

/**
 * Marine snow: drifting specks that give the water scale and depth. Each speck's position is a
 * pure function of its index and the time (no simulation), wrapped inside a box that follows the
 * camera, and lit like everything else, brighter where it crosses a beam.
 * - count: specks at slider value 1
 * - box: edge of the camera-following cube, in world units
 * - size: speck radius in world units; minAngle keeps far specks at least this many radians wide
 * - fall: average sinking speed in world units per second
 * - sway: how far a speck wanders sideways around its path (world units, bounded)
 * - bob: up-and-down wave motion near the surface; fades with depth
 * - brightness / beam: base brightness, and how much a focused beam adds
 */
export const SNOW = {
  count: 24000,
  box: 170,
  size: 0.11,
  minAngle: 0.0011,
  fall: 0.5,
  sway: 2.5,
  bob: 0.6,
  brightness: 1.3,
  beam: 1.2,
};
export const DEFAULT_SNOW_AMOUNT = 1;

/**
 * Sun glint on fish scales: a tight specular flash from the flanks, scaled per species by its
 * `glint` setting. It rides on the fish's caustic-lit sunlight, so it pulses with the caustics.
 */
export const GLINT = { sharpness: 40, color: [1.0, 0.95, 0.8] };

/** Multiplier on the absorption coefficients; the viewer exposes it as a slider. */
export const DEFAULT_MURKINESS = 1;

/** Sea floor mesh: covers `tiles` tank widths in each direction, one vertex every `spacing` units. */
export const FLOOR_MESH = { tiles: 3, spacing: 3, maxCells: 500 };

/** WGSL constants shared by the simulation and render shaders. */
export function wgslHeader() {
  const table = waveTable();
  return `
const WORKGROUP_SIZE = ${WORKGROUP_SIZE}u;
const SIMPLE_SPECIES = ${FISH_LOD.simpleSpecies}u;
const FISH_RADIUS = ${FISH_BOUNDING_RADIUS};
const TAIL_AMP = ${TAIL.amplitude};
const TAIL_K = ${TAIL.wavenumber};
const DEEP_FADE = ${WATER.deepFade};
const WATER_SCATTER = vec3f(${WATER.scatter.join(', ')});
const CLEARANCE_BASE = ${CLEARANCE.base};
const CLEARANCE_BELLY = ${CLEARANCE.belly};
const CLEARANCE_FIN = ${CLEARANCE.fin};
const WAVE_COUNT = ${WAVE_TOTAL}u;
const WAVE_MESH_COUNT = ${WAVES.length}u;
const GLINT_SHARPNESS = ${GLINT.sharpness};
const GLINT_COLOR = vec3f(${GLINT.color.join(', ')});
const CAUSTIC_BEND = ${CAUSTICS.bend};
const CAUSTIC_FADE = ${CAUSTICS.fade};
const CAUSTIC_BASE = ${CAUSTICS.base};
const CAUSTIC_GAIN = ${CAUSTICS.gain};
const CAUSTIC_MIN_DET = ${CAUSTICS.minDeterminant};
const VIGNETTE_INNER = ${VIGNETTE.inner};
const VIGNETTE_OUTER = ${VIGNETTE.outer};
const HAZE_SCALE = ${HAZE.scale};
const HAZE_DRIFT = ${HAZE.drift};
const HAZE_AMOUNT = ${HAZE.amount};
const SNOW_BOX = ${SNOW.box};
const SNOW_SIZE = ${SNOW.size};
const SNOW_MIN_ANGLE = ${SNOW.minAngle};
const SNOW_FALL = ${SNOW.fall};
const SNOW_SWAY = ${SNOW.sway};
const SNOW_BOB = ${SNOW.bob};
const SNOW_BRIGHTNESS = ${SNOW.brightness};
const SNOW_BEAM = ${SNOW.beam};
const SHAFT_STEPS = ${SHAFTS.steps};
const SHAFT_WAVES = ${SHAFTS.waves}u;
const SHAFT_RANGE = ${SHAFTS.range};
const SHAFT_STRENGTH = ${SHAFTS.strength};
const SHAFT_BASE = ${SHAFTS.base};
const SHAFT_GAIN = ${SHAFTS.gain};
const SHAFT_FADE = ${SHAFTS.fade};
const SHAFT_G = ${SHAFTS.anisotropy};
const SHAFT_COLOR = vec3f(${SHAFTS.color.join(', ')});
const SUN_TRAVEL = vec2f(${sunTravelPerDepth().join(', ')});
const WAVES = array<vec4f, ${WAVE_TOTAL}>(${table.map((w) => `vec4f(${w.shape.join(', ')})`).join(', ')});
const WAVE_DYNAMICS = array<vec2f, ${WAVE_TOTAL}>(${table.map((w) => `vec2f(${w.dynamics.join(', ')})`).join(', ')});
`;
}
