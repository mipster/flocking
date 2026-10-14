struct RU {
  viewProj: mat4x4f,
  light: vec4f,     // xyz = direction toward the sun
  absorb: vec4f,    // rgb = extinction per unit (already scaled by murkiness)
  tank: vec4f,      // half extents xyz; y is also the water surface height
  floorGrid: vec4f, // cols, rows, world span x, world span z
  camRight: vec4f,  // xyz, a = tan(fov/2) * aspect
  camUp: vec4f,     // xyz, a = tan(fov/2)
  camFwd: vec4f,    // xyz
  camPos: vec4f,    // xyz = camera world position
};

@group(0) @binding(0) var<uniform> R: RU;
@group(0) @binding(1) var<storage, read> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read> vel: array<vec4f>;
// per species: [scale, 0, 0, 0], [r, g, b, 0]
@group(0) @binding(3) var<uniform> SP: array<vec4f, 6>;

struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) nrm: vec3f,
  @location(1) col: vec3f,
  @location(2) localY: f32,
  @location(3) dist: f32,
  @location(4) sun: vec3f,
  @location(5) veil: vec3f,
};

// Light and veiling haze at a world height. Both vary smoothly, so they are computed per vertex
// and interpolated; only the view-ray transmittance needs a per-pixel exp.
struct DepthLight {
  sun: vec3f,   // fraction of sunlight left at this depth, per channel
  veil: vec3f,  // colour of the haze at this depth
};

fn depthLight(worldY: f32) -> DepthLight {
  let depth = max(R.tank.y - worldY, 0.0);
  var l: DepthLight;
  l.sun = exp(-R.absorb.xyz * depth);
  l.veil = WATER_SCATTER * exp(-R.absorb.xyz * depth * DEEP_FADE);
  return l;
}

// Sunlight has already lost red first on its way down; the view ray loses more with distance,
// and veiling light fills in what was absorbed.
fn underwater(col: vec3f, sun: vec3f, veil: vec3f, dist: f32) -> vec3f {
  let transmit = exp(-R.absorb.xyz * dist);
  return col * sun * transmit + veil * (vec3f(1.0) - transmit);
}

@vertex
fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @builtin(instance_index) ii: u32) -> VOut {
  let pw = pos[ii];
  let vw = vel[ii];
  let sp = u32(pw.w + 0.5);
  let scale = SP[sp * 2u].x;

  let fwd = normalize(vw.xyz + vec3f(1e-5));
  var worldUp = vec3f(0.0, 1.0, 0.0);
  if (abs(fwd.y) > 0.98) { worldUp = vec3f(1.0, 0.0, 0.0); }
  let side = normalize(cross(fwd, worldUp));
  let up = cross(side, fwd);

  var l = p;
  let w = clamp((0.1 - l.x) / 0.7, 0.0, 1.0);
  l.z += sin(vw.w - l.x * TAIL_K) * TAIL_AMP * w * w;

  let world = pw.xyz + (fwd * l.x + up * l.y + side * l.z) * scale;

  let h = fract(sin(f32(ii) * 12.9898) * 43758.5453);
  var o: VOut;
  o.clip = R.viewProj * vec4f(world, 1.0);
  o.nrm = fwd * n.x + up * n.y + side * n.z;
  o.col = SP[sp * 2u + 1u].rgb * (0.85 + 0.3 * h);
  o.localY = p.y;
  o.dist = distance(world, R.camPos.xyz);
  let dl = depthLight(world.y);
  o.sun = dl.sun;
  o.veil = dl.veil;
  return o;
}

@fragment
fn fs(in: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  var n = normalize(in.nrm);
  if (!front) { n = -n; }
  let lambert = max(dot(n, R.light.xyz), 0.0);
  let hemi = n.y * 0.5 + 0.5;
  var col = in.col * (0.3 + 0.4 * hemi + 0.55 * lambert);
  col = mix(col, col * 1.25 + vec3f(0.04), smoothstep(0.0, -0.15, in.localY));
  return vec4f(underwater(col, in.sun, in.veil, in.dist), 1.0);
}

// ---- sea floor --------------------------------------------------------------

struct FloorOut {
  @builtin(position) clip: vec4f,
  @location(0) wp: vec3f,
  @location(1) dist: f32,
  @location(2) sun: vec3f,
  @location(3) veil: vec3f,
};

@vertex
fn vsFloor(@builtin(vertex_index) vi: u32) -> FloorOut {
  let cols = u32(R.floorGrid.x);
  let quad = vi / 6u;
  let corner = vi % 6u;
  let qx = quad % cols;
  let qz = quad / cols;
  var offs = array<vec2u, 6>(
    vec2u(0u, 0u), vec2u(1u, 0u), vec2u(0u, 1u),
    vec2u(1u, 0u), vec2u(1u, 1u), vec2u(0u, 1u));
  let c = offs[corner];
  let gx = f32(qx + c.x) / R.floorGrid.x - 0.5;
  let gz = f32(qz + c.y) / R.floorGrid.y - 0.5;
  let xz = vec2f(gx * R.floorGrid.z, gz * R.floorGrid.w);
  let y = floorY(xz, R.tank.xyz);
  var o: FloorOut;
  o.wp = vec3f(xz.x, y, xz.y);
  o.clip = R.viewProj * vec4f(o.wp, 1.0);
  o.dist = distance(o.wp, R.camPos.xyz);
  let dl = depthLight(y);
  o.sun = dl.sun;
  o.veil = dl.veil;
  return o;
}

fn hash2(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash2(i), hash2(i + vec2f(1.0, 0.0)), u.x),
    mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), u.x),
    u.y);
}

@fragment
fn fsFloor(in: FloorOut) -> @location(0) vec4f {
  let half = R.tank.xyz;
  let p = in.wp.xz;
  let e = 0.6;
  let h0 = floorY(p, half);
  let hx = floorY(p + vec2f(e, 0.0), half);
  let hz = floorY(p + vec2f(0.0, e), half);
  var n = normalize(vec3f(-(hx - h0) / e, 1.0, -(hz - h0) / e));

  // fine detail fades with distance so it doesn't shimmer
  let detail = 1.0 - smoothstep(80.0, 260.0, in.dist);

  // wind ripples: wavy ridges roughly perpendicular to (0.91, 0.41)
  let warp = vnoise(p * 0.12) * 6.0;
  let rp = (p.x * 0.9 + p.y * 0.4 + warp) * 1.6;
  let ripple = sin(rp);
  n = normalize(n + vec3f(0.914, 0.0, 0.406) * cos(rp) * 0.14 * detail);

  // sand grain at three scales
  let g1 = vnoise(p * 0.8);
  let g2 = mix(0.5, vnoise(p * 9.0), detail);
  let g3 = mix(0.5, hash2(floor(p * 40.0)), detail);
  var sand = mix(vec3f(0.60, 0.50, 0.33), vec3f(0.90, 0.82, 0.62), g1 * 0.5 + g2 * 0.5);
  sand *= 0.86 + 0.28 * g3;
  sand *= 0.92 + 0.08 * ripple * detail;

  let lambert = max(dot(n, R.light.xyz), 0.0);
  let col = sand * (0.22 + 0.9 * lambert);
  return vec4f(underwater(col, in.sun, in.veil, in.dist), 1.0);
}

// ---- backdrop -----------------------------------------------------------------

struct BgOut {
  @builtin(position) clip: vec4f,
  @location(0) ndc: vec2f,
};

@vertex
fn vsBg(@builtin(vertex_index) vi: u32) -> BgOut {
  // one oversized triangle covering the screen
  var xy = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: BgOut;
  o.clip = vec4f(xy[vi], 0.0, 1.0);
  o.ndc = xy[vi];
  return o;
}

@fragment
fn fsBg(in: BgOut) -> @location(0) vec4f {
  let ray = normalize(
    R.camFwd.xyz + in.ndc.x * R.camRight.xyz * R.camRight.w + in.ndc.y * R.camUp.xyz * R.camUp.w);
  let sigma = R.absorb.xyz;
  let camDepth = max(R.tank.y - R.camPos.y, 0.0);

  // water colour at the camera: brighter looking toward the surface, darker toward the floor
  let veil = WATER_SCATTER * exp(-sigma * camDepth * DEEP_FADE);
  let toSurface = smoothstep(-0.05, 0.9, ray.y);
  let toFloor = smoothstep(0.05, -0.85, ray.y);
  var col = veil * (1.0 + 1.6 * toSurface) * (1.0 - 0.65 * toFloor);

  // the sun seen through the water: a soft halo plus a tight core, tinted blue-green
  let s = max(dot(ray, R.light.xyz), 0.0);
  let glow = 0.35 * pow(s, 6.0) + 0.9 * pow(s, 80.0);
  col += vec3f(0.55, 0.85, 0.95) * glow * exp(-sigma * camDepth) * smoothstep(0.0, 0.3, ray.y);
  return vec4f(col, 1.0);
}
