/**
 * Is a sphere (centre `c`, radius `r`) at least partly inside the view frustum of `viewProj`
 * (column-major, WebGPU clip space: -w <= x,y <= w, 0 <= z <= w)? The CPU twin of `inFrustum` in
 * render.wgsl; both read the planes straight from the matrix rows.
 */
export function sphereInFrustum(viewProj, c, r) {
  const row = (i) => [viewProj[i], viewProj[4 + i], viewProj[8 + i], viewProj[12 + i]];
  const [r0, r1, r2, r3] = [row(0), row(1), row(2), row(3)];
  const add = (a, b) => a.map((v, i) => v + b[i]);
  const sub = (a, b) => a.map((v, i) => v - b[i]);
  for (const pl of [add(r3, r0), sub(r3, r0), add(r3, r1), sub(r3, r1), r2, sub(r3, r2)]) {
    const len = Math.hypot(pl[0], pl[1], pl[2]);
    if (pl[0] * c[0] + pl[1] * c[1] + pl[2] * c[2] + pl[3] < -r * len) return false;
  }
  return true;
}
