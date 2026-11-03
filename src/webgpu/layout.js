// CPU-side packing of every GPU uniform block, with named fields.
// Each function documents the WGSL struct it feeds (sim.wgsl / render.wgsl); change both together.
// Floats only, in vec4 groups, so there is no padding to get wrong.
import { SPECIES_COUNT } from './config.js';

/** Per-step blend of an exponential low-pass with time constant `tau` seconds (0 = no smoothing). */
const expBlend = (dt, tau) => (tau > 0 ? 1 - Math.exp(-dt / tau) : 1);

/** Total floats in the simulation `Params` uniform (10 x vec4f). */
export const SIM_PARAMS_FLOATS = 40;

/**
 * sim.wgsl `Params`:
 *   a      = (delta, time, count, maxPerCell)
 *   bounds = (half.x, half.y, half.z, wallMargin)
 *   grid   = (cellSize, nx, ny, nz)
 *   flags  = (wrap, steering blend per step, minimum speed fraction, predator fear weight)
 *   home       = (centre xyz, pull strength; 0 = no home region)
 *   homeRadius = (ellipsoid radii xyz, 1 = roost mode)
 *   predator   = (position xyz, fear radius; 0 = no predator)
 *   flight     = (banked flight on, speed blend per step, cruise speed fraction, level-flight pull)
 *   predatorVel = (predator velocity xyz, look-ahead seconds)
 *   ground      = (flat ground height, 1 = use it instead of the sea floor, 0, 0)
 *
 * `home.roost`: instead of pulling back only from outside the ellipsoid, pull horizontally toward
 * the centre all the time, growing to full strength at the ellipsoid's edge (height is still kept
 * only from outside). With banked flight this makes birds circle the roost rather than bounce.
 *
 * `predator.velocity` / `predator.lookAhead`: animals flee from where the predator will pass
 * closest to them within the next `lookAhead` seconds, sideways out of its path, not just from
 * where it is now; without them the fear is radial from its current position.
 *
 * `ground` (a height, or null for the fish' sea floor): a flat bottom for the starlings' lake.
 *
 * `flight` ({ cruise, speedTime, level, rollTime }, or null for the fish) switches to a bird-like
 * model: steering only turns the heading, through the steering low-pass (GpuBoids sets its time
 * constant to `rollTime`, the time to roll into a turn), while speed eases back to `cruise` x maxSpeed with time constant `speedTime` seconds, and
 * vertical speed is damped by `level` per second so the flock flies flat and turns in wide loops.
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
  minSpeed = 0.4,
  home = null,
  predator = null,
  flight = null,
  ground = null,
}) {
  // exponential low-pass: fraction of the new force blended in each step (1 = smoothing off)
  const blend = expBlend(dt, smoothing);
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
    minSpeed,
    predator ? predator.weight : 0,
    ...(home ? [...home.center, home.strength] : [0, 0, 0, 0]),
    ...(home ? [...home.radius, home.roost ? 1 : 0] : [1, 1, 1, 0]),
    ...(predator ? [...predator.position, predator.radius] : [0, 0, 0, 0]),
    ...(flight ? [1, expBlend(dt, flight.speedTime), flight.cruise, flight.level] : [0, 1, 0, 0]),
    ...(predator?.velocity ? [...predator.velocity, predator.lookAhead ?? 0] : [0, 0, 0, 0]),
    ...(ground === null ? [0, 0, 0, 0] : [ground, 1, 0, 0]),
  ]);
}

/** Floats per species in the simulation `SPEC` array (4 x vec4f). */
export const SIM_SPECIES_STRIDE = 16;

/**
 * sim.wgsl `SPEC`, per species:
 *   [maxSpeed, maxForce, sepRadius, aliRadius]
 *   [cohRadius, sepWeight, aliWeight, cohWeight]
 *   [fearRadius, fearWeight, huntRadius, huntWeight]
 *   [wander, scale, farCohesion, neighbours]   (the last two are optional, default 0 = off)
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
        s.farCohesion ?? 0,
        s.neighbours ?? 0,
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

/** render.wgsl `SP`, per species: [scale, glint, 0, 0] then [r, g, b, 0]. */
export function packRenderSpecies(species) {
  const out = new Float32Array(SPECIES_COUNT * RENDER_SPECIES_STRIDE);
  species.forEach((s, i) => {
    out.set([s.scale, s.glint ?? 0, 0, 0], i * RENDER_SPECIES_STRIDE);
    out.set([...hexToRgb(s.color), 0], i * RENDER_SPECIES_STRIDE + 4);
  });
  return out;
}

/** Floats in the render `RU` uniform (mat4 + 10 x vec4f). */
export const RENDER_UNIFORM_FLOATS = 56;

/**
 * render.wgsl `RU`:
 *   viewProj  : mat4x4f (column-major)
 *   light     = (direction toward the sun xyz, frustum culling on = 1 / off = 0)
 *   absorb    = (extinction rgb per unit, light shaft strength)
 *   tank      = (half.x, half.y, half.z, mean water surface height)
 *   floorGrid = (cols, rows, world span x, world span z)
 *   camRight  = (right xyz, tan(fov/2) * aspect)
 *   camUp     = (up xyz, tan(fov/2))
 *   camFwd    = (forward xyz, sand caustics on = 1 / off = 0)
 *   camPos    = (camera world position xyz, time in seconds)
 *   post      = (vignette strength 0..1, 0, 0, 0)
 *   waves     = (wave height scale, wavenumber scale, 0, wave clock in seconds)
 */
export function packRenderUniforms({
  viewProj,
  light,
  absorption,
  half,
  surfaceY,
  floorGrid,
  time,
  camera,
  floorCaustics = true,
  cull = true,
  shaftStrength = 0,
  vignette = 0,
  waves = { height: 1, scale: 1, clock: 0 },
}) {
  const out = new Float32Array(RENDER_UNIFORM_FLOATS);
  const l = Math.hypot(...light);
  out.set(viewProj, 0);
  out.set([light[0] / l, light[1] / l, light[2] / l, cull ? 1 : 0], 16);
  out.set([...absorption, shaftStrength], 20);
  out.set([half[0], half[1], half[2], surfaceY], 24);
  out.set(floorGrid, 28);
  out.set([...camera.right, camera.tanHalfX], 32);
  out.set([...camera.up, camera.tanHalfY], 36);
  out.set([...camera.forward, floorCaustics ? 1 : 0], 40);
  out.set([...camera.position, time], 44);
  out.set([vignette, 0, 0, 0], 48);
  out.set([waves.height, waves.scale, 0, waves.clock], 52);
  return out;
}

/** Floats in the starling page's `SU` uniform (mat4 + 6 x vec4f). */
export const STARLING_UNIFORM_FLOATS = 40;

/**
 * starlings.wgsl `SU`:
 *   viewProj : mat4x4f (column-major)
 *   camRight = (right xyz, tan(fov/2) * aspect)
 *   camUp    = (up xyz, tan(fov/2))
 *   camFwd   = (forward xyz, time in seconds)
 *   camPos   = (camera position xyz, viewport height in pixels)
 *   hawk     = (position xyz, 1 while flying / 0)
 *   hawkDir  = (unit heading xyz, wing phase in radians)
 */
export function packStarlingUniforms({ viewProj, camera, time, viewportHeight, hawk = null }) {
  const out = new Float32Array(STARLING_UNIFORM_FLOATS);
  out.set(viewProj, 0);
  out.set([...camera.right, camera.tanHalfX], 16);
  out.set([...camera.up, camera.tanHalfY], 20);
  out.set([...camera.forward, time], 24);
  out.set([...camera.position, viewportHeight], 28);
  if (hawk) {
    out.set([...hawk.position, 1], 32);
    out.set([...hawk.direction, hawk.phase], 36);
  }
  return out;
}

/** Floats in bank.wgsl `BankParams`. */
export const BANK_PARAMS_FLOATS = 4;

/**
 * bank.wgsl `BankParams`: a = (blend toward the current velocity, bird count, 0, 0).
 * The blend makes the average an exponential one with time constant `smoothing`, whatever dt is.
 */
export function packBankParams({ dt, smoothing, count }) {
  return new Float32Array([expBlend(dt, smoothing), count, 0, 0]);
}
