import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MURKINESS,
  DEFAULT_SHAFT_STRENGTH,
  DEFAULT_SNOW_AMOUNT,
  DEFAULT_VIGNETTE,
  DEFAULT_WAVES,
  WAVE_SCALE_MAX,
} from './config.js';
import { DEFAULT_PRESET, PRESETS, PRESET_KEYS, PRESET_RANGES, applyPreset } from './presets.js';

describe('presets', () => {
  it('give every preset exactly the preset keys, as finite non-negative numbers', () => {
    for (const [name, p] of Object.entries(PRESETS)) {
      expect(Object.keys(p).sort(), name).toEqual([...PRESET_KEYS].sort());
      for (const v of Object.values(p)) {
        expect(Number.isFinite(v), name).toBe(true);
        expect(v, name).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('makes the default preset match the engine defaults', () => {
    expect(PRESETS[DEFAULT_PRESET]).toEqual({
      murkiness: DEFAULT_MURKINESS,
      shafts: DEFAULT_SHAFT_STRENGTH,
      snow: DEFAULT_SNOW_AMOUNT,
      vignette: DEFAULT_VIGNETTE,
      waveHeight: DEFAULT_WAVES.height,
      waveScale: DEFAULT_WAVES.scale,
      waveSpeed: DEFAULT_WAVES.speed,
    });
  });

  it('keeps every preset value inside its slider range', () => {
    expect(Object.keys(PRESET_RANGES).sort()).toEqual([...PRESET_KEYS].sort());
    for (const [name, p] of Object.entries(PRESETS)) {
      for (const key of PRESET_KEYS) {
        const [min, max] = PRESET_RANGES[key];
        expect(p[key], `${name}.${key}`).toBeGreaterThanOrEqual(min);
        expect(p[key], `${name}.${key}`).toBeLessThanOrEqual(max);
      }
    }
  });

  it('keeps wave scale within the mesh-safe limit', () => {
    for (const [name, p] of Object.entries(PRESETS)) {
      expect(p.waveScale, name).toBeLessThanOrEqual(WAVE_SCALE_MAX);
      expect(p.waveHeight, name).toBeGreaterThan(0);
    }
  });

  it('applies only the preset keys and rejects unknown names', () => {
    const settings = { total: 65536, murkiness: 1, shafts: 1, snow: 1, vignette: 0.5 };
    expect(applyPreset(settings, 'Murky bay')).toBe(true);
    expect(settings).toMatchObject({ total: 65536, ...PRESETS['Murky bay'] });
    expect(applyPreset(settings, 'nope')).toBe(false);
  });
});
