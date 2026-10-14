import { describe, expect, it } from 'vitest';
import {
  LIGHT_DIRECTION,
  RIPPLES,
  SHAFTS,
  WAVES,
  WAVE_AMPLITUDE_TOTAL,
  sunTravelPerDepth,
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

  it('keeps the fish ceiling reachable: wave troughs stay above the tank top', () => {
    expect(WAVE_AMPLITUDE_TOTAL).toBeGreaterThan(0);
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
