import { describe, expect, it } from 'vitest';
import { SPECIES } from '../species.js';
import {
  BANK_PARAMS_FLOATS,
  RENDER_SPECIES_STRIDE,
  RENDER_UNIFORM_FLOATS,
  STARLING_UNIFORM_FLOATS,
  packBankParams,
  packStarlingUniforms,
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

  it('fills exactly eleven vec4s', () => {
    expect(p.length).toBe(SIM_PARAMS_FLOATS);
    expect(SIM_PARAMS_FLOATS).toBe(44);
  });

  it('defaults to the fish behaviour: 40% minimum speed, no home, predator or banked flight', () => {
    expect(p[14]).toBeCloseTo(0.4, 6); // flags.z
    expect(p[15]).toBe(0); // flags.w
    expect(p[19]).toBe(0); // home.w = off
    expect(Array.from(p.slice(20, 23))).toEqual([1, 1, 1]); // homeRadius never divides by zero
    expect(p[27]).toBe(0); // predator.w = none
    expect(Array.from(p.slice(28, 32))).toEqual([0, 1, 0, 0]); // flight off
    expect(Array.from(p.slice(32, 36))).toEqual([0, 0, 0, 0]); // predator standing still
    expect(Array.from(p.slice(36, 40))).toEqual([0, 0, 0, 0]); // sea floor, not flat ground
    expect(Array.from(p.slice(40, 44))).toEqual([0, 0, 0, 0]); // no turn or panic copying
  });

  it('packs the turn copying as a blend, the reaction time as is, and a per-step fade', () => {
    const waves = { turnCopy: 0.2, panicCopy: 0.9, panicReact: 0.1, panicFade: 0.8 };
    const flight = { cruise: 0.85, speedTime: 0.5, level: 1 };
    expect(
      packSimParams({ ...base, waves })
        .slice(40, 44)
        .every((v) => v === 0)
    ).toBe(true);
    expect(Array.from(packSimParams({ ...base, flight, waves }).slice(40, 44))).toEqual([
      expect.closeTo(1 - Math.exp(-0.016 / 0.2), 6),
      expect.closeTo(0.9, 6),
      expect.closeTo(0.1, 6),
      expect.closeTo(Math.exp(-0.016 / 0.8), 6),
    ]);
  });

  it('packs a flat ground height, including 0', () => {
    expect(Array.from(packSimParams({ ...base, ground: -46 }).slice(36, 40))).toEqual([-46, 1, 0, 0]);
    expect(Array.from(packSimParams({ ...base, ground: 0 }).slice(36, 40))).toEqual([0, 1, 0, 0]);
  });

  it('packs roost mode and the predator velocity with its look-ahead', () => {
    const q = packSimParams({
      ...base,
      home: { center: [0, 0, 0], radius: [50, 14, 22], strength: 1, roost: true },
      predator: { position: [0, 0, 0], radius: 16, weight: 5, velocity: [30, -2, 0], lookAhead: 1.2 },
    });
    expect(q[23]).toBe(1);
    expect(Array.from(q.slice(32, 36))).toEqual([30, -2, 0, expect.closeTo(1.2, 6)]);
  });

  it('packs banked flight with its speed time constant as a per-step blend', () => {
    const q = packSimParams({ ...base, flight: { cruise: 0.85, speedTime: 0.5, level: 1.5 } });
    expect(Array.from(q.slice(28, 32))).toEqual([
      1,
      expect.closeTo(1 - Math.exp(-0.016 / 0.5), 6),
      expect.closeTo(0.85, 6),
      1.5,
    ]);
  });

  it('places the home region, predator and minimum speed', () => {
    const q = packSimParams({
      ...base,
      minSpeed: 0.75,
      home: { center: [1, 2, 3], radius: [40, 15, 30], strength: 0.8 },
      predator: { position: [5, 6, 7], radius: 14, weight: 4 },
    });
    expect(q[14]).toBeCloseTo(0.75, 6);
    expect(q[15]).toBe(4);
    expect(Array.from(q.slice(16, 20))).toEqual([1, 2, 3, expect.closeTo(0.8, 6)]);
    expect(Array.from(q.slice(20, 24))).toEqual([40, 15, 30, 0]);
    expect(Array.from(q.slice(24, 28))).toEqual([5, 6, 7, 14]);
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
      expect(out[o + 14]).toBe(s.farCohesion ?? 0); // vec4 3: far cohesion, off for fish
      expect(out[o + 15]).toBe(s.neighbours ?? 0); // vec4 3: topological neighbours, off for fish
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

describe('packStarlingUniforms', () => {
  const camera = {
    right: [1, 0, 0],
    up: [0, 1, 0],
    forward: [0, 0, -1],
    position: [0, 2, 175],
    tanHalfX: 0.7,
    tanHalfY: 0.4,
  };
  const args = { viewProj: new Float32Array(16).fill(2), camera, time: 3.5, viewportHeight: 900 };

  it('is the size starlings.wgsl expects, with the camera where it reads it', () => {
    const out = packStarlingUniforms(args);
    expect(out.length).toBe(STARLING_UNIFORM_FLOATS);
    expect(out[0]).toBe(2);
    expect(Array.from(out.slice(16, 20))).toEqual([1, 0, 0, expect.closeTo(0.7, 6)]);
    expect(Array.from(out.slice(20, 24))).toEqual([0, 1, 0, expect.closeTo(0.4, 6)]);
    expect(Array.from(out.slice(24, 28))).toEqual([0, 0, -1, 3.5]);
    expect(Array.from(out.slice(28, 32))).toEqual([0, 2, 175, 900]);
  });

  it('marks the hawk absent unless it is flying', () => {
    expect(packStarlingUniforms(args)[35]).toBe(0);
    const out = packStarlingUniforms({
      ...args,
      hawk: { position: [4, 5, 6], direction: [0, 0, 1], phase: 2 },
    });
    expect(Array.from(out.slice(32, 40))).toEqual([4, 5, 6, 1, 0, 0, 1, 2]);
  });
});

describe('packBankParams', () => {
  it('blends by 1 - exp(-dt / smoothing) and carries the bird count', () => {
    const p = packBankParams({ dt: 0.2, smoothing: 0.2, count: 4096 });
    expect(p.length).toBe(BANK_PARAMS_FLOATS);
    expect(p[0]).toBeCloseTo(1 - Math.exp(-1), 6);
    expect(p[1]).toBe(4096);
  });
});

describe('packSimSpecies with optional bird fields', () => {
  it('packs far cohesion and topological neighbours when a species has them', () => {
    const bird = { ...SPECIES[0], farCohesion: 0.8, neighbours: 7 };
    const out = packSimSpecies([bird, bird, bird]);
    expect(out[14]).toBeCloseTo(0.8, 6);
    expect(out[15]).toBe(7);
  });
});
