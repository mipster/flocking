// CPU-side packing of every GPU uniform block, with named fields.
// Each function documents the WGSL struct it feeds (sim.wgsl / render.wgsl); change both together.
// Floats only, in vec4 groups, so there is no padding to get wrong.
import { SPECIES_COUNT } from './config.js';

/** Total floats in the simulation `Params` uniform (4 x vec4f). */
export const SIM_PARAMS_FLOATS = 16;

/**
 * sim.wgsl `Params`:
 *   a      = (delta, time, count, maxPerCell)
 *   bounds = (half.x, half.y, half.z, wallMargin)
 *   grid   = (cellSize, nx, ny, nz)
 *   flags  = (wrap, steering blend per step, 0, 0)
 */
export function packSimParams({
  dt,
  time,
  count,
  maxPerCell,
  half,
  wallMargin,
  cellSize,
  dims,
  wrap,
  smoothing,
}) {
  // exponential low-pass: fraction of the new force blended in each step (1 = smoothing off)
  const blend = smoothing > 0 ? 1 - Math.exp(-dt / smoothing) : 1;
  return new Float32Array([
    dt,
    time,
    count,
    maxPerCell,
    half[0],
    half[1],
    half[2],
    wallMargin,
    cellSize,
    dims[0],
    dims[1],
    dims[2],
    wrap ? 1 : 0,
    blend,
    0,
    0,
  ]);
}

/** Floats per species in the simulation `SPEC` array (4 x vec4f). */
export const SIM_SPECIES_STRIDE = 16;

/**
 * sim.wgsl `SPEC`, per species:
 *   [maxSpeed, maxForce, sepRadius, aliRadius]
 *   [cohRadius, sepWeight, aliWeight, cohWeight]
 *   [fearRadius, fearWeight, huntRadius, huntWeight]
 *   [wander, scale, 0, 0]
 */
export function packSimSpecies(species) {
  const out = new Float32Array(SPECIES_COUNT * SIM_SPECIES_STRIDE);
  species.forEach((s, i) => {
    out.set(
      [
        s.maxSpeed,
        s.maxForce,
        s.sepRadius,
        s.aliRadius,
        s.cohRadius,
        s.sepWeight,
        s.aliWeight,
        s.cohWeight,
        s.fearRadius,
        s.fearWeight,
        s.huntRadius,
        s.huntWeight,
        s.wander,
        s.scale,
        0,
        0,
      ],
      i * SIM_SPECIES_STRIDE
    );
  });
  return out;
}

/** '#rrggbb' -> [r, g, b] in 0..1 (raw sRGB; the shaders write straight to an sRGB-encoded canvas). */
export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Floats per species in the render `SP` array (2 x vec4f). */
export const RENDER_SPECIES_STRIDE = 8;

/** render.wgsl `SP`, per species: [scale, 0, 0, 0] then [r, g, b, 0]. */
export function packRenderSpecies(species) {
  const out = new Float32Array(SPECIES_COUNT * RENDER_SPECIES_STRIDE);
  species.forEach((s, i) => {
    out.set([s.scale, 0, 0, 0], i * RENDER_SPECIES_STRIDE);
    out.set([...hexToRgb(s.color), 0], i * RENDER_SPECIES_STRIDE + 4);
  });
  return out;
}

/** Floats in the render `RU` uniform (mat4 + 8 x vec4f). */
export const RENDER_UNIFORM_FLOATS = 48;

/**
 * render.wgsl `RU`:
 *   viewProj  : mat4x4f (column-major)
 *   light     = (direction toward the sun xyz, 0)
 *   absorb    = (extinction rgb per unit, 0)
 *   tank      = (half.x, half.y, half.z, mean water surface height)
 *   floorGrid = (cols, rows, world span x, world span z)
 *   camRight  = (right xyz, tan(fov/2) * aspect)
 *   camUp     = (up xyz, tan(fov/2))
 *   camFwd    = (forward xyz, 0)
 *   camPos    = (camera world position xyz, time in seconds)
 */
export function packRenderUniforms({ viewProj, light, absorption, half, surfaceY, floorGrid, time, camera }) {
  const out = new Float32Array(RENDER_UNIFORM_FLOATS);
  const l = Math.hypot(...light);
  out.set(viewProj, 0);
  out.set([light[0] / l, light[1] / l, light[2] / l, 0], 16);
  out.set([...absorption, 0], 20);
  out.set([half[0], half[1], half[2], surfaceY], 24);
  out.set(floorGrid, 28);
  out.set([...camera.right, camera.tanHalfX], 32);
  out.set([...camera.up, camera.tanHalfY], 36);
  out.set([...camera.forward, 0], 40);
  out.set([...camera.position, time], 44);
  return out;
}
