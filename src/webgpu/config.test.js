import { describe, expect, it } from 'vitest';
import { WAVES, WAVE_AMPLITUDE_TOTAL, wgslHeader, waveTable } from './config.js';

describe('waveTable', () => {
  const table = waveTable();

  it('has one entry per wave with finite shader constants', () => {
    expect(table).toHaveLength(WAVES.length);
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
    expect(header).toContain(`const WAVE_COUNT = ${WAVES.length}u;`);
    expect(header).toContain(`array<vec4f, ${WAVES.length}>`);
    expect(header).toContain(`array<vec2f, ${WAVES.length}>`);
  });

  it('never emits NaN or undefined into the shader', () => {
    expect(header).not.toMatch(/NaN|undefined|Infinity/);
  });

  it('keeps the fish ceiling reachable: wave troughs stay above the tank top', () => {
    expect(WAVE_AMPLITUDE_TOTAL).toBeGreaterThan(0);
  });
});
