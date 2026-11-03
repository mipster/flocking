import { describe, expect, it } from 'vitest';
import { lookAt, mul, perspective } from './mat4.js';

// column-major: element (row r, column c) is m[c * 4 + r]
const apply = (m, [x, y, z]) => [0, 1, 2, 3].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r]);

describe('mat4', () => {
  it('maps a point straight ahead to the centre of clip space with z between 0 and 1', () => {
    const vp = mul(perspective(Math.PI / 3, 1.5, 0.5, 1000), lookAt([0, 0, 10], [0, 0, 0], [0, 1, 0]));
    const [x, y, z, w] = apply(vp, [0, 0, 0]);
    expect(x / w).toBeCloseTo(0, 6);
    expect(y / w).toBeCloseTo(0, 6);
    expect(z / w).toBeGreaterThan(0);
    expect(z / w).toBeLessThan(1);
  });

  it('puts points above the eye line in the upper half of the screen', () => {
    const vp = mul(perspective(Math.PI / 3, 1, 0.5, 1000), lookAt([0, 0, 10], [0, 0, 0], [0, 1, 0]));
    const [, y, , w] = apply(vp, [0, 2, 0]);
    expect(y / w).toBeGreaterThan(0);
  });
});
