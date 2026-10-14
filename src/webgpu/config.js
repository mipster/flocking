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

/** Species count; the shaders index uniform arrays by species id. */
export const SPECIES_COUNT = 3;

/** Fish tail motion (fraction of body length; radians per body length). */
export const TAIL = { amplitude: 0.14, wavenumber: 7.0 };

export const CAMERA = {
  fovDegrees: 55,
  near: 1,
  far: 3000,
  startDistance: 260,
  startPitch: 0.2,
  minDistance: 20,
  maxDistance: 700,
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

/** Multiplier on the absorption coefficients; the viewer exposes it as a slider. */
export const DEFAULT_MURKINESS = 1;

/** Sea floor mesh: covers `tiles` tank widths in each direction, one vertex every `spacing` units. */
export const FLOOR_MESH = { tiles: 3, spacing: 3, maxCells: 500 };

/** WGSL constants shared by the simulation and render shaders. */
export function wgslHeader() {
  return `
const TAIL_AMP = ${TAIL.amplitude};
const TAIL_K = ${TAIL.wavenumber};
const DEEP_FADE = ${WATER.deepFade};
const WATER_SCATTER = vec3f(${WATER.scatter.join(', ')});
const CLEARANCE_BASE = ${CLEARANCE.base};
const CLEARANCE_BELLY = ${CLEARANCE.belly};
const CLEARANCE_FIN = ${CLEARANCE.fin};
`;
}
