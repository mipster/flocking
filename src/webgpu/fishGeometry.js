// Low-poly fish, length 1 along local +x (head at +0.5), y up, z side.
// Flat shaded, ~70 triangles. Returns interleaved [px, py, pz, nx, ny, nz] per vertex.
export function buildFishVertices() {
  const SEG = 6;
  const tris = [];

  // [x, half-height, half-width]
  const stations = [
    [0.42, 0.06, 0.05],
    [0.25, 0.14, 0.09],
    [0.0, 0.18, 0.11],
    [-0.2, 0.13, 0.08],
    [-0.38, 0.05, 0.035],
  ];
  const rings = stations.map(([x, rh, rw]) =>
    Array.from({ length: SEG }, (_, k) => {
      const a = (k / SEG) * Math.PI * 2;
      return [x, rh * Math.cos(a), rw * Math.sin(a)];
    })
  );
  const nose = [0.5, 0, 0];
  const tailPoint = [-0.4, 0, 0];

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

  // orient a body triangle so its normal points away from the body axis
  const addBody = (a, b, c) => {
    const n = cross(sub(b, a), sub(c, a));
    const cy = (a[1] + b[1] + c[1]) / 3;
    const cz = (a[2] + b[2] + c[2]) / 3;
    tris.push(n[1] * cy + n[2] * cz >= 0 ? [a, b, c] : [a, c, b]);
  };
  const addFlat = (a, b, c) => tris.push([a, b, c]);

  for (let k = 0; k < SEG; k++) {
    const k1 = (k + 1) % SEG;
    addBody(nose, rings[0][k], rings[0][k1]);
    for (let r = 0; r < rings.length - 1; r++) {
      addBody(rings[r][k], rings[r + 1][k], rings[r + 1][k1]);
      addBody(rings[r][k], rings[r + 1][k1], rings[r][k1]);
    }
    addBody(rings[rings.length - 1][k], tailPoint, rings[rings.length - 1][k1]);
  }

  // forked tail fin and dorsal fin (flat; rendered double-sided)
  addFlat([-0.38, 0, 0], [-0.64, 0.22, 0], [-0.54, 0, 0]);
  addFlat([-0.38, 0, 0], [-0.54, 0, 0], [-0.64, -0.22, 0]);
  addFlat([0.12, 0.16, 0], [-0.1, 0.17, 0], [-0.14, 0.31, 0]);

  const out = new Float32Array(tris.length * 3 * 6);
  tris.forEach(([a, b, c], t) => {
    const n = cross(sub(b, a), sub(c, a));
    const l = Math.hypot(...n) || 1;
    [a, b, c].forEach((v, j) => out.set([...v, n[0] / l, n[1] / l, n[2] / l], (t * 3 + j) * 6));
  });
  return out;
}
