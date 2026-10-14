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
 *   flags  = (wrap, 0, 0, 0)
 */
export function packSimParams({ dt, time, count, maxPerCell, half, wallMargin, cellSize, dims, wrap }) {
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
    0,
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

/** Floats in the render `RU` uniform (mat4 + 4 x vec4f). */
export const RENDER_UNIFORM_FLOATS = 32;

/**
 * render.wgsl `RU`:
 *   viewProj  : mat4x4f (column-major)
 *   light     = (direction toward light xyz, 0)
 *   fog       = (rgb, density)
 *   tank      = (half.x, half.y, half.z, 0)
 *   floorGrid = (cols, rows, world span x, world span z)
 */
export function packRenderUniforms({ viewProj, light, fogColor, fogDensity, half, floorGrid }) {
  const out = new Float32Array(RENDER_UNIFORM_FLOATS);
  const l = Math.hypot(...light);
  out.set(viewProj, 0);
  out.set([light[0] / l, light[1] / l, light[2] / l, 0], 16);
  out.set([...fogColor, fogDensity], 20);
  out.set([half[0], half[1], half[2], 0], 24);
  out.set(floorGrid, 28);
  return out;
}
