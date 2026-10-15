import { describe, expect, it } from 'vitest';
import { sphereInFrustum } from './frustum.js';

// identity viewProj: the visible box is x,y in [-1, 1], z in [0, 1] (w = 1)
const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

describe('sphereInFrustum', () => {
  it('accepts spheres inside or straddling the box', () => {
    expect(sphereInFrustum(identity, [0, 0, 0.5], 0.1)).toBe(true);
    expect(sphereInFrustum(identity, [1.2, 0, 0.5], 0.3)).toBe(true);
  });

  it('rejects spheres fully outside any plane', () => {
    expect(sphereInFrustum(identity, [3, 0, 0.5], 0.5)).toBe(false);
    expect(sphereInFrustum(identity, [0, 0, -2], 0.5)).toBe(false);
    expect(sphereInFrustum(identity, [0, 0, 3], 0.5)).toBe(false);
  });
});
