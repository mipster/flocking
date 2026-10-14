import { describe, expect, it } from 'vitest';
import { SPECIES } from '../species.js';
import {
  RENDER_SPECIES_STRIDE,
  RENDER_UNIFORM_FLOATS,
  SIM_PARAMS_FLOATS,
  SIM_SPECIES_STRIDE,
  hexToRgb,
  packRenderSpecies,
  packRenderUniforms,
  packSimParams,
  packSimSpecies,
} from './layout.js';

describe('packSimParams', () => {
  const base = {
    dt: 0.016,
    time: 2,
    count: 1000,
    maxPerCell: 8,
    half: [120, 30, 80],
    wallMargin: 10,
    cellSize: 8,
    dims: [30, 8, 20],
    wrap: true,
    smoothing: 0,
  };
  const p = packSimParams(base);

  it('fills exactly four vec4s', () => {
    expect(p.length).toBe(SIM_PARAMS_FLOATS);
    expect(SIM_PARAMS_FLOATS).toBe(16);
  });

  it('places fields where sim.wgsl reads them', () => {
    expect(Array.from(p.slice(0, 4))).toEqual([expect.closeTo(0.016, 5), 2, 1000, 8]); // a
    expect(Array.from(p.slice(4, 8))).toEqual([120, 30, 80, 10]); // bounds
    expect(Array.from(p.slice(8, 12))).toEqual([8, 30, 8, 20]); // grid
    expect(p[12]).toBe(1); // flags.x = wrap
  });

  it('encodes wrap off as 0', () => {
    expect(packSimParams({ ...base, wrap: false })[12]).toBe(0);
  });

  it('sends a blend of 1 (no smoothing) when the time constant is 0', () => {
    expect(p[13]).toBe(1);
  });

  it('converts the smoothing time constant into a per-step blend factor', () => {
    const q = packSimParams({ ...base, smoothing: 0.1 });
    expect(q[13]).toBeCloseTo(1 - Math.exp(-0.016 / 0.1), 6);
    expect(q[13]).toBeGreaterThan(0);
    expect(q[13]).toBeLessThan(1);
  });
});

describe('packSimSpecies', () => {
  const out = packSimSpecies(SPECIES);

  it('has a fixed stride per species', () => {
    expect(out.length).toBe(3 * SIM_SPECIES_STRIDE);
  });

  it('keeps each species in its own slot', () => {
    SPECIES.forEach((s, i) => {
      const o = i * SIM_SPECIES_STRIDE;
      expect(out[o]).toBeCloseTo(s.maxSpeed); // vec4 0: maxSpeed
      expect(out[o + 4]).toBeCloseTo(s.cohRadius); // vec4 1: cohRadius
      expect(out[o + 8]).toBeCloseTo(s.fearRadius); // vec4 2: fearRadius
      expect(out[o + 12]).toBeCloseTo(s.wander); // vec4 3: wander
      expect(out[o + 13]).toBeCloseTo(s.scale); // vec4 3: scale
    });
  });
});

describe('packRenderSpecies', () => {
  it('stores scale then colour per species', () => {
    const out = packRenderSpecies(SPECIES);
    expect(out.length).toBe(3 * RENDER_SPECIES_STRIDE);
    const [r, g, b] = hexToRgb(SPECIES[1].color);
    expect(out[RENDER_SPECIES_STRIDE]).toBeCloseTo(SPECIES[1].scale);
    expect(out[RENDER_SPECIES_STRIDE + 1]).toBeCloseTo(SPECIES[1].glint);
    expect(Array.from(out.slice(RENDER_SPECIES_STRIDE + 4, RENDER_SPECIES_STRIDE + 7))).toEqual([
      expect.closeTo(r, 5),
      expect.closeTo(g, 5),
      expect.closeTo(b, 5),
    ]);
  });
});

describe('hexToRgb', () => {
  it('parses #rrggbb into 0..1', () => {
    expect(hexToRgb('#ff8000')).toEqual([1, expect.closeTo(128 / 255, 5), 0]);
  });
});

describe('packRenderUniforms', () => {
  const args = {
    viewProj: new Float32Array(16).fill(1),
    light: [0, 3, 4],
    absorption: [0.01, 0.002, 0.001],
    half: [120, 30, 80],
    surfaceY: 31.8,
    time: 7.5,
    floorGrid: [240, 160, 720, 480],
    camera: {
      right: [1, 0, 0],
      up: [0, 1, 0],
      forward: [0, 0, -1],
      position: [5, 42, 9],
      tanHalfX: 0.8,
      tanHalfY: 0.5,
    },
  };
  const out = packRenderUniforms(args);

  it('is the size render.wgsl expects', () => {
    expect(out.length).toBe(RENDER_UNIFORM_FLOATS);
  });

  it('normalises the light direction', () => {
    expect(Array.from(out.slice(16, 19))).toEqual([0, expect.closeTo(0.6, 5), expect.closeTo(0.8, 5)]);
  });

  it('carries the culling and sand-caustic switches in the spare w components', () => {
    expect(out[19]).toBe(1); // light.w = frustum culling on by default
    expect(out[43]).toBe(1); // camFwd.w = sand caustics on by default
    expect(out[48]).toBe(0); // post.x = no vignette unless asked for
    expect(Array.from(out.slice(52, 56))).toEqual([1, 1, 0, 0]); // waves: unscaled, clock at 0
    const w = packRenderUniforms({ ...args, waves: { height: 2, scale: 0.5, clock: 12 } });
    expect(Array.from(w.slice(52, 56))).toEqual([2, 0.5, 0, 12]);
    expect(packRenderUniforms({ ...args, vignette: 0.6 })[48]).toBeCloseTo(0.6, 6);
    expect(out[23]).toBe(0); // absorb.w = light shafts off unless asked for
    expect(packRenderUniforms({ ...args, shaftStrength: 1.5 })[23]).toBe(1.5);
    const off = packRenderUniforms({ ...args, cull: false, floorCaustics: false });
    expect(off[19]).toBe(0);
    expect(off[43]).toBe(0);
  });

  it('places absorption, tank and floor grid', () => {
    expect(Array.from(out.slice(20, 24))).toEqual([
      expect.closeTo(0.01, 6),
      expect.closeTo(0.002, 6),
      expect.closeTo(0.001, 6),
      0,
    ]);
    expect(Array.from(out.slice(24, 28))).toEqual([120, 30, 80, expect.closeTo(31.8, 4)]);
    expect(Array.from(out.slice(28, 32))).toEqual([240, 160, 720, 480]);
  });

  it('places the camera basis, its field-of-view scales and its position', () => {
    expect(Array.from(out.slice(32, 36))).toEqual([1, 0, 0, expect.closeTo(0.8, 6)]);
    expect(Array.from(out.slice(36, 40))).toEqual([0, 1, 0, expect.closeTo(0.5, 6)]);
    expect(Array.from(out.slice(40, 44))).toEqual([0, 0, -1, 1]); // forward, sand caustics on
    expect(Array.from(out.slice(44, 48))).toEqual([5, 42, 9, 7.5]);
  });
});
