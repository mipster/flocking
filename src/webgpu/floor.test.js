import { describe, expect, it } from 'vitest';
import { FLOOR, floorHeight, floorWGSL, floorY } from './floor.js';

const HALF = [120, 30, 80];

describe('floor height', () => {
  it('tiles with the tank, so wrapped fish see no seam', () => {
    for (const [x, z] of [
      [0, 0],
      [17.3, -42.1],
      [-99, 55],
    ]) {
      expect(floorHeight(x + 240, z, HALF)).toBeCloseTo(floorHeight(x, z, HALF), 6);
      expect(floorHeight(x, z + 160, HALF)).toBeCloseTo(floorHeight(x, z, HALF), 6);
    }
  });

  it('stays within the summed amplitudes', () => {
    const max = FLOOR.amplitudes.reduce((a, b) => a + b, 0);
    for (let x = -120; x <= 120; x += 7) {
      for (let z = -80; z <= 80; z += 7) {
        expect(Math.abs(floorHeight(x, z, HALF))).toBeLessThanOrEqual(max + 1e-9);
      }
    }
  });

  it('keeps the sand inside the tank, leaving room for fish', () => {
    const max = FLOOR.amplitudes.reduce((a, b) => a + b, 0);
    expect(-HALF[1] + FLOOR.lift - max).toBeGreaterThanOrEqual(-HALF[1]);
    expect(-HALF[1] + FLOOR.lift + max).toBeLessThan(0);
    expect(floorY(0, 0, HALF)).toBeCloseTo(-HALF[1] + FLOOR.lift + floorHeight(0, 0, HALF));
  });
});

describe('floorWGSL', () => {
  it('embeds the same coefficients as the JS reference', () => {
    for (const a of FLOOR.amplitudes) expect(floorWGSL).toContain(String(a));
    expect(floorWGSL).toContain(String(FLOOR.lift));
  });
});
