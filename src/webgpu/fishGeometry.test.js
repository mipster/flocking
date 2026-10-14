import { describe, expect, it } from 'vitest';
import { buildFishVertices } from './fishGeometry.js';

describe('buildFishVertices', () => {
  const v = buildFishVertices();
  const vertexCount = v.length / 6;

  it('is whole triangles of interleaved position + normal', () => {
    expect(v.length % 6).toBe(0);
    expect(vertexCount % 3).toBe(0);
  });

  it('is a low-poly mesh', () => {
    const tris = vertexCount / 3;
    expect(tris).toBeGreaterThan(40);
    expect(tris).toBeLessThan(120);
  });

  it('has a much lighter simple variant that spans the same length', () => {
    const simple = buildFishVertices('simple');
    expect(simple.length / 18).toBeLessThan(vertexCount / 3 / 2);
    let max = -Infinity;
    for (let i = 0; i < simple.length / 6; i++) max = Math.max(max, simple[i * 6]);
    expect(max).toBeCloseTo(0.5, 5);
  });

  it('has finite values and unit normals', () => {
    for (let i = 0; i < vertexCount; i++) {
      const o = i * 6;
      for (let k = 0; k < 6; k++) expect(Number.isFinite(v[o + k])).toBe(true);
      expect(Math.hypot(v[o + 3], v[o + 4], v[o + 5])).toBeCloseTo(1, 4);
    }
  });

  it('spans one body length along +x with the head at +0.5', () => {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < vertexCount; i++) {
      min = Math.min(min, v[i * 6]);
      max = Math.max(max, v[i * 6]);
    }
    expect(max).toBeCloseTo(0.5, 5);
    expect(min).toBeGreaterThan(-0.7);
  });
});
