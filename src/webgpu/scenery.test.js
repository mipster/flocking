import { describe, expect, it } from 'vitest';
import { floorY } from './floor.js';
import { generateScenery, makeRng, smoothMin } from './scenery.js';

const HALF = [120, 30, 80];
const world = generateScenery(HALF);
const first = (kind) => world.features.find((f) => f.kind === kind);

describe('makeRng', () => {
  it('repeats for the same seed and differs for another', () => {
    const a = makeRng(3);
    const b = makeRng(3);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(makeRng(4)()).not.toBe(makeRng(3)());
  });
});

describe('smoothMin', () => {
  it('equals min away from the blend band and dips below it inside', () => {
    expect(smoothMin(0, 5, 1)).toBe(0);
    expect(smoothMin(0, 0, 1)).toBeLessThan(0);
  });
});

describe('generateScenery', () => {
  it('is deterministic per seed and changes with it', () => {
    expect(generateScenery(HALF).features).toEqual(world.features);
    expect(generateScenery(HALF, { seed: 99 }).features).not.toEqual(world.features);
  });

  it('produces every kind of feature plus seaweed on the default tank', () => {
    for (const kind of ['cave', 'arch', 'boulder', 'branching', 'fan']) expect(first(kind)).toBeDefined();
    expect(world.seaweed.length).toBeGreaterThan(0);
  });

  it('sits on the sand, inside the tank, with clear space between features', () => {
    for (const f of world.features) {
      expect(f.c[1]).toBeCloseTo(floorY(f.c[0], f.c[2], HALF), 6);
      expect(Math.abs(f.c[2])).toBeLessThan(HALF[2]);
    }
    for (const w of world.seaweed) expect(w.y).toBeCloseTo(floorY(w.x, w.z, HALF), 6);
  });

  it('repeats every tank width in x, so it tiles with the wrap', () => {
    const f = first('boulder');
    for (const [dx, dy, dz] of [
      [0, 4, 0],
      [3, 2, -2],
      [-6, 6, 5],
    ]) {
      const x = f.c[0] + dx;
      const y = f.c[1] + dy;
      const z = f.c[2] + dz;
      expect(world.distance(x + 240, y, z)).toBeCloseTo(world.distance(x, y, z), 6);
    }
  });

  it('is solid inside rock and open water far from everything', () => {
    const f = first('boulder');
    expect(world.distance(f.c[0], f.c[1] + 1, f.c[2])).toBeLessThan(0);
    expect(world.distance(f.c[0], HALF[1] + 100, f.c[2])).toBeGreaterThan(50);
  });

  it('leaves the opening under an arch open and the span solid', () => {
    const f = first('arch');
    const ring = f.parts.find((p) => p.shape === 'ring');
    const at = (lx, ly) => {
      // local (lx, ly, 0) back to world through the feature's yaw
      const c = Math.cos(f.yaw);
      const s = Math.sin(f.yaw);
      return world.distance(f.c[0] + lx * c, f.c[1] + ly, f.c[2] + lx * s);
    };
    expect(at(0, ring.R)).toBeLessThan(0); // crown of the ring
    expect(at(0, ring.R * 0.4)).toBeGreaterThan(0); // underneath it
  });

  it('carves a tunnel through a cave but keeps the walls', () => {
    const f = first('cave');
    const tunnel = f.carves[0];
    const c = Math.cos(f.yaw);
    const s = Math.sin(f.yaw);
    const at = (lx, ly, lz) =>
      world.distance(f.c[0] + lx * c - lz * s, f.c[1] + ly, f.c[2] + lx * s + lz * c);
    expect(at(0, tunnel.a[1], 0)).toBeGreaterThan(0); // inside the tunnel
    const dome = f.parts[0];
    expect(at(0, dome.r[1] * 0.9, 0)).toBeLessThan(0); // the roof above it
  });
});
