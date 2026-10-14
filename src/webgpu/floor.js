// Sea floor height. One set of coefficients drives both the JS reference (tests, tooling)
// and the generated WGSL used by the simulation (fish barrier) and the renderer (mesh, shading).
//
// The floor is a sum of sine harmonics of the tank size, so it tiles seamlessly across the
// tank edges, which matters when fish wrap around.

export const FLOOR = {
  /** Amplitudes of the three harmonics, world units. */
  amplitudes: [3.4, 1.8, 0.9],
  /** Height of the mean sand level above the tank bottom. */
  lift: 8.0,
};

const TAU = Math.PI * 2;

/** Height variation at world (x, z) for a tank with half extents `half`. */
export function floorHeight(x, z, half) {
  const u = x / (half[0] * 2); // 1.0 == one tank width
  const w = z / (half[2] * 2);
  const [a, b, c] = FLOOR.amplitudes;
  return (
    a * Math.sin(TAU * (2 * u + 0.15 * Math.sin(TAU * w))) +
    b * Math.sin(TAU * (3 * w + u) + 1.7) +
    c * Math.sin(TAU * (5 * u - 4 * w) + 0.4)
  );
}

/** World-space y of the sand surface at (x, z). */
export function floorY(x, z, half) {
  return -half[1] + FLOOR.lift + floorHeight(x, z, half);
}

/** WGSL twin of floorHeight / floorY. Keep the formula in step with the JS above. */
export const floorWGSL = `
const TAU_F = 6.283185307;

fn floorHeight(p: vec2f, half: vec3f) -> f32 {
  let u = p.x / (half.x * 2.0);
  let w = p.y / (half.z * 2.0);
  let a = sin(TAU_F * (2.0 * u + 0.15 * sin(TAU_F * w)));
  let b = sin(TAU_F * (3.0 * w + u) + 1.7);
  let c = sin(TAU_F * (5.0 * u - 4.0 * w) + 0.4);
  return ${FLOOR.amplitudes[0]} * a + ${FLOOR.amplitudes[1]} * b + ${FLOOR.amplitudes[2]} * c;
}

fn floorY(p: vec2f, half: vec3f) -> f32 {
  return -half.y + ${FLOOR.lift} + floorHeight(p, half);
}
`;

/**
 * Grid for the floor and water-surface meshes. They cover `tiles` tank widths in each direction,
 * but never more than `maxCells` cells, and when a wide tank hits that cap the span shrinks instead
 * of the cells growing: vertex spacing stays `spacing`, which is what lets the shortest mesh wave
 * be sampled without aliasing.
 */
export function floorMeshGrid(half, { tiles, spacing, maxCells }) {
  const span = (h) => Math.min(h * 2 * tiles, maxCells * spacing);
  const spanX = span(half[0]);
  const spanZ = span(half[2]);
  return {
    cols: Math.ceil(spanX / spacing),
    rows: Math.ceil(spanZ / spacing),
    spanX,
    spanZ,
  };
}
