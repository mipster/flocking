import { describe, expect, it } from 'vitest';
import { floorY } from './floor.js';
import { SCENERY_MESH } from './config.js';
import { generateScenery } from './scenery.js';
import { SCENERY_VERTEX_FLOATS, buildSceneryMesh, buildSeaweedData, meshFeature } from './sceneryMesh.js';

const HALF = [120, 30, 80];
const world = generateScenery(HALF);
const width = HALF[0] * 2;

describe('meshFeature', () => {
  for (const kind of ['boulder', 'arch', 'cave', 'branching', 'fan']) {
    it(`puts ${kind} vertices on its surface`, () => {
      const f = world.features.find((x) => x.kind === kind);
      const cell = kind === 'branching' || kind === 'fan' ? SCENERY_MESH.coralCell : SCENERY_MESH.rockCell;
      const { positions, triangles } = meshFeature(f, width, HALF, cell);
      expect(triangles.length).toBeGreaterThan(0);
      expect(triangles.length % 3).toBe(0);
      let worst = 0;
      for (let i = 0; i < positions.length; i += 3) {
        const [x, y, z] = positions.slice(i, i + 3);
        if (y < floorY(x, z, HALF)) continue; // the hidden skin under the sand is not the surface
        worst = Math.max(worst, Math.abs(world.distance(x, y, z)));
      }
      expect(worst).toBeLessThan(cell); // within one cell of the true surface
    });
  }
});

describe('buildSceneryMesh', () => {
  const { vertices: mesh, ranges } = buildSceneryMesh(world, HALF);

  it('is a whole number of triangles with unit normals and colours in range', () => {
    expect(mesh.length % (SCENERY_VERTEX_FLOATS * 3)).toBe(0);
    for (let i = 0; i < mesh.length; i += SCENERY_VERTEX_FLOATS * 97) {
      expect(Math.hypot(mesh[i + 3], mesh[i + 4], mesh[i + 5])).toBeCloseTo(1, 4);
      for (const c of mesh.slice(i + 6, i + 9)) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });

  it('has one contiguous range per feature that tiles the whole buffer', () => {
    expect(ranges).toHaveLength(world.features.length);
    let next = 0;
    for (const r of ranges) {
      expect(r.first).toBe(next);
      next += r.count;
    }
    expect(next * SCENERY_VERTEX_FLOATS).toBe(mesh.length);
  });

  it('stays a sensible size for the default tank', () => {
    const triangles = mesh.length / SCENERY_VERTEX_FLOATS / 3;
    expect(triangles).toBeGreaterThan(1000);
    expect(triangles).toBeLessThan(600000);
  });
});

describe('buildSeaweedData', () => {
  it('packs two vec4s per plant', () => {
    const data = buildSeaweedData(world);
    expect(data.length).toBe(world.seaweed.length * 8);
    const w = world.seaweed[3];
    expect(Array.from(data.slice(24, 28))).toEqual([
      expect.closeTo(w.x, 4),
      expect.closeTo(w.y, 4),
      expect.closeTo(w.z, 4),
      expect.closeTo(w.height, 4),
    ]);
  });
});
