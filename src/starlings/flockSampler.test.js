import { describe, expect, it } from 'vitest';
import { meanXyz } from './flockSampler.js';

describe('meanXyz', () => {
  it('averages the xyz of the first n vec4s and ignores w and the rest', () => {
    const data = new Float32Array([1, 2, 3, 9, 3, 4, 5, 9, 100, 100, 100, 100]);
    expect(meanXyz(data, 2)).toEqual([2, 3, 4]);
  });

  it('returns zeros for an empty sample instead of NaN', () => {
    expect(meanXyz(new Float32Array(0), 0)).toEqual([0, 0, 0]);
  });
});
