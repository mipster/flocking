// Tuning constants for the WebGPU engine, in one place.
// Anything the shaders need is injected as WGSL `const`s by wgslHeader() so JS and WGSL
// can never drift apart.

/** Spatial grid cell edge, in world units. Neighbor search scans cells within the species' radius. */
export const CELL_SIZE = 8;

/** Compute workgroup size; must match `@workgroup_size` in sim.wgsl. */
export const WORKGROUP_SIZE = 64;

/** Distance from the tank edge where soft walls / the sea floor start pushing fish back. */
export const WALL_MARGIN = 10;

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
export const FOG_COLOR = [4 / 255, 18 / 255, 31 / 255];
export const DEFAULT_FOG_DENSITY = 0.003;

/** Sea floor mesh: covers `tiles` tank widths in each direction, one vertex every `spacing` units. */
export const FLOOR_MESH = { tiles: 3, spacing: 3, maxCells: 500 };

/** WGSL constants shared by the simulation and render shaders. */
export function wgslHeader() {
  return `
const TAIL_AMP = ${TAIL.amplitude};
const TAIL_K = ${TAIL.wavenumber};
`;
}
