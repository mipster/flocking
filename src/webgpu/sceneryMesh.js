// Turns the scenery distance field into triangles and seaweed data for the GPU.
//
// Surface nets: sample the field on a grid, put one vertex in every cell the surface crosses
// (the average of its edge crossings), and join the vertices of the four cells around every grid
// edge that changes sign. It needs no lookup tables and gives smooth, evenly sized triangles.
// Normals come from the field's gradient, so shading never depends on triangle winding.
import { SCENERY_COLORS, SCENERY_MESH } from './config.js';
import { floorY } from './floor.js';
import { featureDistance } from './scenery.js';

/** Floats per drawn vertex: position, normal, colour. */
export const SCENERY_VERTEX_FLOATS = 9;

const CORNERS = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, 1],
];
const EDGES = [
  [0, 1],
  [2, 3],
  [4, 5],
  [6, 7],
  [0, 2],
  [1, 3],
  [4, 6],
  [5, 7],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

/** Indexed surface of one feature: { positions: number[], triangles: number[] } (world space). */
export function meshFeature(feature, width, half, cell, below = SCENERY_MESH.belowSand) {
  const ext = feature.radius + 2 * cell;
  const origin = [feature.c[0] - ext, feature.c[1] - below, feature.c[2] - ext];
  const nxz = Math.ceil((2 * ext) / cell) + 1;
  const ny = Math.ceil((feature.radius + below + 2 * cell) / cell) + 1;
  const at = (ix, iy, iz) => ix + nxz * (iy + ny * iz);

  const values = new Float32Array(nxz * ny * nxz);
  for (let iz = 0; iz < nxz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nxz; ix++) {
        const x = origin[0] + ix * cell;
        const y = origin[1] + iy * cell;
        const z = origin[2] + iz * cell;
        // everything deeper than `below` under the sand counts as outside: it is never seen
        values[at(ix, iy, iz)] =
          y < floorY(x, z, half) - below ? cell : featureDistance(feature, x, y, z, width);
      }
    }
  }

  const cellVertex = new Int32Array((nxz - 1) * (ny - 1) * (nxz - 1)).fill(-1);
  const cellAt = (cx, cy, cz) => cx + (nxz - 1) * (cy + (ny - 1) * cz);
  const positions = [];
  for (let cz = 0; cz < nxz - 1; cz++) {
    for (let cy = 0; cy < ny - 1; cy++) {
      for (let cx = 0; cx < nxz - 1; cx++) {
        const v = CORNERS.map(([dx, dy, dz]) => values[at(cx + dx, cy + dy, cz + dz)]);
        const inside = v.filter((d) => d < 0).length;
        if (inside === 0 || inside === 8) continue;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let crossings = 0;
        for (const [a, b] of EDGES) {
          if (v[a] < 0 === v[b] < 0) continue;
          const t = v[a] / (v[a] - v[b]);
          sx += CORNERS[a][0] + t * (CORNERS[b][0] - CORNERS[a][0]);
          sy += CORNERS[a][1] + t * (CORNERS[b][1] - CORNERS[a][1]);
          sz += CORNERS[a][2] + t * (CORNERS[b][2] - CORNERS[a][2]);
          crossings++;
        }
        cellVertex[cellAt(cx, cy, cz)] = positions.length / 3;
        positions.push(
          origin[0] + (cx + sx / crossings) * cell,
          origin[1] + (cy + sy / crossings) * cell,
          origin[2] + (cz + sz / crossings) * cell
        );
      }
    }
  }

  // one quad per sign-changing grid edge, joining the four cells that share it
  const triangles = [];
  const quad = (a, b, c, d) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    triangles.push(a, b, c, a, c, d);
  };
  for (let iz = 1; iz < nxz - 1; iz++) {
    for (let iy = 1; iy < ny - 1; iy++) {
      for (let ix = 1; ix < nxz - 1; ix++) {
        const here = values[at(ix, iy, iz)] < 0;
        const cv = (cx, cy, cz) => cellVertex[cellAt(cx, cy, cz)];
        if (here !== values[at(ix + 1, iy, iz)] < 0) {
          quad(cv(ix, iy - 1, iz - 1), cv(ix, iy, iz - 1), cv(ix, iy, iz), cv(ix, iy - 1, iz));
        }
        if (here !== values[at(ix, iy + 1, iz)] < 0) {
          quad(cv(ix - 1, iy, iz - 1), cv(ix, iy, iz - 1), cv(ix, iy, iz), cv(ix - 1, iy, iz));
        }
        if (here !== values[at(ix, iy, iz + 1)] < 0) {
          quad(cv(ix - 1, iy - 1, iz), cv(ix, iy - 1, iz), cv(ix, iy, iz), cv(ix - 1, iy, iz));
        }
      }
    }
  }
  return { positions, triangles };
}

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const smoothstep = (lo, hi, x) => {
  const t = Math.min(Math.max((x - lo) / (hi - lo), 0), 1);
  return t * t * (3 - 2 * t);
};
const ROCK_KINDS = new Set(['boulder', 'arch', 'cave']);

/**
 * All features as one non-indexed triangle list, SCENERY_VERTEX_FLOATS per vertex
 * (position, normal, colour). Returns { vertices: Float32Array, ranges } where each range
 * ({ first, count, c, radius }: vertex span and bounding sphere) is one feature, so the renderer can
 * skip the ones outside the view.
 */
export function buildSceneryMesh(scenery, half, mesh = SCENERY_MESH) {
  const width = half[0] * 2;
  const out = [];
  const ranges = [];
  for (const f of scenery.features) {
    const first = out.length / SCENERY_VERTEX_FLOATS;
    const cell = ROCK_KINDS.has(f.kind) ? mesh.rockCell : mesh.coralCell;
    const { positions, triangles } = meshFeature(f, width, half, cell, mesh.belowSand);
    const [lo, hi] = SCENERY_COLORS[f.kind];
    const base = mix(lo, hi, f.tone);
    const eps = cell * 0.5;
    // per unique vertex: gradient normal and colour
    const nrm = [];
    const col = [];
    for (let i = 0; i < positions.length; i += 3) {
      const [x, y, z] = [positions[i], positions[i + 1], positions[i + 2]];
      const g = [
        featureDistance(f, x + eps, y, z, width) - featureDistance(f, x - eps, y, z, width),
        featureDistance(f, x, y + eps, z, width) - featureDistance(f, x, y - eps, z, width),
        featureDistance(f, x, y, z + eps, width) - featureDistance(f, x, y, z - eps, width),
      ];
      const len = Math.hypot(...g) || 1;
      const nv = g.map((v) => v / len);
      nrm.push(...nv);
      col.push(
        ...(ROCK_KINDS.has(f.kind)
          ? mix(base, SCENERY_COLORS.algae, 0.6 * smoothstep(0.5, 0.95, nv[1]))
          : base)
      );
    }
    for (const idx of triangles) {
      out.push(
        positions[idx * 3],
        positions[idx * 3 + 1],
        positions[idx * 3 + 2],
        nrm[idx * 3],
        nrm[idx * 3 + 1],
        nrm[idx * 3 + 2],
        col[idx * 3],
        col[idx * 3 + 1],
        col[idx * 3 + 2]
      );
    }
    ranges.push({ first, count: out.length / SCENERY_VERTEX_FLOATS - first, c: f.c, radius: f.radius });
  }
  return { vertices: new Float32Array(out), ranges };
}

/** Seaweed plants as two vec4f each: [x, y, z, height] and [phase, 0, 0, 0]. */
export function buildSeaweedData(scenery) {
  const out = new Float32Array(scenery.seaweed.length * 8);
  scenery.seaweed.forEach((w, i) => out.set([w.x, w.y, w.z, w.height, w.phase, 0, 0, 0], i * 8));
  return out;
}
