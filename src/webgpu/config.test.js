import { describe, expect, it } from 'vitest';
import { TANK_HALF } from '../species.js';
import {
  BUBBLES,
  CELL_SIZE,
  LIGHT_DIRECTION,
  RIPPLES,
  SHAFTS,
  SPECIES_COUNT,
  TANK_LIMITS,
  WAVES,
  WAVE_AMPLITUDE_TOTAL,
  sunTravelPerDepth,
  vecConsts,
  wgslHeader,
  waveTable,
} from './config.js';

describe('waveTable', () => {
  const table = waveTable();

  it('has one entry per wave with finite shader constants', () => {
    expect(table).toHaveLength(WAVES.length + RIPPLES.length);
    for (const w of table) {
      for (const v of [...w.shape, ...w.dynamics]) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('normalises wave directions', () => {
    for (const w of table) expect(Math.hypot(w.shape[0], w.shape[1])).toBeCloseTo(1, 6);
  });

  it('keeps total crest steepness within one so surfaces do not loop', () => {
    // sum of q * k * A over waves is the steepness the Gerstner model needs to stay <= 1
    const steepness = table.reduce((sum, w) => sum + w.dynamics[1] * w.shape[3] * w.shape[2], 0);
    expect(steepness).toBeLessThanOrEqual(1 + 1e-9);
  });
});

describe('wgslHeader', () => {
  const header = wgslHeader();

  it('declares the wave tables with matching lengths', () => {
    const total = WAVES.length + RIPPLES.length;
    expect(header).toContain(`const WAVE_COUNT = ${total}u;`);
    expect(header).toContain(`const WAVE_MESH_COUNT = ${WAVES.length}u;`);
    expect(header).toContain(`array<vec4f, ${total}>`);
    expect(header).toContain(`array<vec2f, ${total}>`);
  });

  it('never emits NaN or undefined into the shader', () => {
    expect(header).not.toMatch(/NaN|undefined|Infinity/);
  });

  it('sums the mesh waves for the water level, so troughs reach no lower than the tank top', () => {
    // the surface sits WAVE_AMPLITUDE_TOTAL above the tank top and no wave dips further than its amplitude
    expect(WAVE_AMPLITUDE_TOTAL).toBeCloseTo(
      WAVES.reduce((sum, w) => sum + w.amplitude, 0),
      9
    );
    expect(WAVE_AMPLITUDE_TOTAL).toBeGreaterThan(0);
  });

  it('injects the species count and refractive index the shaders rely on', () => {
    expect(header).toContain('const SPECIES_COUNT = 3u;');
    expect(header).toContain('const WATER_IOR = 1.33;');
    expect(header).toContain(`const BUBBLE_VENTS = ${BUBBLES.vents}u;`);
  });
});

describe('TANK_LIMITS', () => {
  it('bounds the grid size so the single-thread prefix sum stays small', () => {
    const cells =
      Math.ceil(TANK_LIMITS.maxWidth / CELL_SIZE) *
      Math.ceil((2 * TANK_HALF[1]) / CELL_SIZE) *
      Math.ceil(TANK_LIMITS.maxDepth / CELL_SIZE);
    expect(cells * SPECIES_COUNT).toBeLessThanOrEqual(65536);
  });

  it('keeps the default tank inside the limits', () => {
    expect(2 * TANK_HALF[0]).toBeGreaterThanOrEqual(TANK_LIMITS.min);
    expect(2 * TANK_HALF[0]).toBeLessThanOrEqual(TANK_LIMITS.maxWidth);
    expect(2 * TANK_HALF[2]).toBeLessThanOrEqual(TANK_LIMITS.maxDepth);
  });
});

describe('sunTravelPerDepth', () => {
  const [x, z] = sunTravelPerDepth();

  it('points away from the sun, horizontally', () => {
    expect(Math.sign(x)).toBe(-Math.sign(LIGHT_DIRECTION[0]));
    expect(Math.sign(z)).toBe(-Math.sign(LIGHT_DIRECTION[2]));
  });

  it('bends toward vertical: refracted travel is shorter than in air', () => {
    const air = Math.hypot(LIGHT_DIRECTION[0], LIGHT_DIRECTION[2]) / LIGHT_DIRECTION[1];
    expect(Math.hypot(x, z)).toBeLessThan(air);
    expect(Math.hypot(x, z)).toBeGreaterThan(0);
  });
});

describe('SHAFTS', () => {
  it('uses a valid number of waves and a sane step count', () => {
    expect(SHAFTS.waves).toBeGreaterThanOrEqual(WAVES.length);
    expect(SHAFTS.waves).toBeLessThanOrEqual(WAVES.length + RIPPLES.length);
    expect(SHAFTS.steps).toBeGreaterThan(0);
    expect(wgslHeader()).toContain(`const SHAFT_WAVES = ${SHAFTS.waves}u;`);
  });
});

describe('mesh waves and ripples', () => {
  it('lists mesh waves first and gives ripples no horizontal displacement', () => {
    const table = waveTable();
    table.forEach((w, i) => {
      if (i < WAVES.length) expect(w.dynamics[1]).toBeGreaterThan(0);
      else expect(w.dynamics[1]).toBe(0);
    });
  });
});

describe('vecConsts', () => {
  it('emits floats, vectors and snake-case names', () => {
    const out = vecConsts('SAND', { rippleTilt: 0.14, dark: [0.6, 0.5, 0.33], direction: [0.9, 0.4] });
    expect(out).toContain('const SAND_RIPPLE_TILT = 0.14;');
    expect(out).toContain('const SAND_DARK = vec3f(0.6, 0.5, 0.33);');
    expect(out).toContain('const SAND_DIRECTION = vec2f(0.9, 0.4);');
  });

  it('injects every look setting the shaders use', () => {
    const header = wgslHeader();
    for (const name of ['FISH_AMBIENT', 'SAND_DARK', 'BACKDROP_SUN_CORE', 'SKY_ZENITH', 'FRESNEL_F0']) {
      expect(header).toContain(`const ${name} =`);
    }
  });
});
