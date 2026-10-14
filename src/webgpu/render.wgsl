struct RU {
  viewProj: mat4x4f,
  light: vec4f,     // xyz = direction toward the sun
  absorb: vec4f,    // rgb = extinction per unit (already scaled by murkiness), a = light shaft strength
  tank: vec4f,      // half extents xyz, a = mean water surface height
  floorGrid: vec4f, // cols, rows, world span x, world span z
  camRight: vec4f,  // xyz, a = tan(fov/2) * aspect
  camUp: vec4f,     // xyz, a = tan(fov/2)
  camFwd: vec4f,    // xyz, a = sand caustics on (1) / off (0)
  camPos: vec4f,    // xyz = camera world position, a = time in seconds
};

@group(0) @binding(0) var<uniform> R: RU;
@group(0) @binding(1) var<storage, read> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read> vel: array<vec4f>;
// per species: [scale, glint, 0, 0], [r, g, b, 0]
@group(0) @binding(3) var<uniform> SP: array<vec4f, 6>;
// per fish, two vec4s written by fishShade each frame: [sun rgb, colour hash] and [veil rgb, 0]
@group(0) @binding(4) var<storage, read> shade: array<vec4f>;
// indices of the fish that survived culling, for this draw (simple or full mesh)
@group(0) @binding(6) var<storage, read> visible: array<u32>;
// light shafts: the half-size shaft image the composite pass adds on top of the frame
@group(0) @binding(11) var shaftTex: texture_2d<f32>;
@group(0) @binding(12) var shaftSampler: sampler;
// fishShade (compute) only: writable views of the same data, bound with `pos`, SP and the uniforms
@group(0) @binding(5) var<storage, read_write> shadeOut: array<vec4f>;
@group(0) @binding(7) var<storage, read_write> visibleSimpleOut: array<u32>;
@group(0) @binding(8) var<storage, read_write> visibleFullOut: array<u32>;
// two indirect draw argument blocks (vertexCount, instanceCount, firstVertex, firstInstance)
@group(0) @binding(9) var<storage, read_write> drawArgs: array<atomic<u32>>;

struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) nrm: vec3f,
  @location(1) col: vec3f,
  @location(2) localY: f32,
  @location(3) dist: f32,
  @location(4) sun: vec3f,
  @location(5) veil: vec3f,
  @location(6) worldPos: vec3f,
  @location(7) glint: f32,
};

// Light and veiling haze at a world height. Both vary smoothly, so they are computed per vertex
// and interpolated; only the view-ray transmittance needs a per-pixel exp.
struct DepthLight {
  sun: vec3f,   // fraction of sunlight left at this depth, per channel
  veil: vec3f,  // colour of the haze at this depth
};

fn depthLight(worldY: f32) -> DepthLight {
  let depth = max(R.tank.w - worldY, 0.0);
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

// Is a sphere (centre, radius) at least partly inside the view frustum? Planes come straight from
// the rows of viewProj (WebGPU clip space: -w <= x,y <= w, 0 <= z <= w).
fn inFrustum(c: vec3f, r: f32) -> bool {
  let m = R.viewProj;
  let r0 = vec4f(m[0][0], m[1][0], m[2][0], m[3][0]);
  let r1 = vec4f(m[0][1], m[1][1], m[2][1], m[3][1]);
  let r2 = vec4f(m[0][2], m[1][2], m[2][2], m[3][2]);
  let r3 = vec4f(m[0][3], m[1][3], m[2][3], m[3][3]);
  var planes = array<vec4f, 6>(r3 + r0, r3 - r0, r3 + r1, r3 - r1, r2, r3 - r2);
  for (var k = 0; k < 6; k++) {
    let pl = planes[k];
    if (dot(pl.xyz, c) + pl.w < -r * length(pl.xyz)) { return false; }
  }
  return true;
}

// Per-fish work, once per fish instead of once per vertex: cull fish outside the view (appending
// the survivors to the list for their mesh), then compute the depth-attenuated sunlight with
// caustic focus, the veiling haze and a random colour tint. A fish is a few units across, so its
// centre depth stands in for every vertex.
@compute @workgroup_size(WORKGROUP_SIZE)
fn fishShade(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= arrayLength(&pos)) { return; }
  let p4 = pos[i];
  let p = p4.xyz;
  let sp = u32(p4.w + 0.5);
  if (R.light.w > 0.5 && !inFrustum(p, SP[sp * 2u].x * FISH_RADIUS)) { return; }
  if (sp < SIMPLE_SPECIES) {
    visibleSimpleOut[atomicAdd(&drawArgs[1], 1u)] = i;
  } else {
    visibleFullOut[atomicAdd(&drawArgs[5], 1u)] = i;
  }
  let dl = depthLight(p.y);
  let focus = causticLight(p.xz, max(R.tank.w - p.y, 0.0), R.camPos.w);
  let tint = fract(sin(f32(i) * 12.9898) * 43758.5453);
  shadeOut[i * 2u] = vec4f(dl.sun * focus, tint);
  shadeOut[i * 2u + 1u] = vec4f(dl.veil, 0.0);
}

@vertex
fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @builtin(instance_index) ii: u32) -> VOut {
  let fi = visible[ii];
  let pw = pos[fi];
  let vw = vel[fi];
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

  let s0 = shade[fi * 2u];
  var o: VOut;
  o.clip = R.viewProj * vec4f(world, 1.0);
  o.nrm = fwd * n.x + up * n.y + side * n.z;
  o.col = SP[sp * 2u + 1u].rgb * (0.85 + 0.3 * s0.w);
  o.localY = p.y;
  o.dist = distance(world, R.camPos.xyz);
  o.sun = s0.rgb;
  o.veil = shade[fi * 2u + 1u].rgb;
  o.worldPos = world;
  o.glint = SP[sp * 2u].y;
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

  // sun glint: a facet flashes when its normal lines up with the half vector between sun and eye.
  // It is added to the colour before the sunlight factor, so caustic focus lifts it too.
  let toEye = normalize(R.camPos.xyz - in.worldPos);
  let half = normalize(R.light.xyz + toEye);
  let spec = pow(max(dot(n, half), 0.0), GLINT_SHARPNESS);
  col += GLINT_COLOR * spec * in.glint;

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

// World x/z of vertex `vi` of the big horizontal grid (two triangles per cell) that the floor and
// the water surface are both drawn on.
fn gridVertex(vi: u32) -> vec2f {
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
  return vec2f(gx * R.floorGrid.z, gz * R.floorGrid.w);
}

@vertex
fn vsFloor(@builtin(vertex_index) vi: u32) -> FloorOut {
  let xz = gridVertex(vi);
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

fn floorCaustic(wp: vec3f) -> f32 {
  if (R.camFwd.w < 0.5) { return 1.0; }
  return causticLight(wp.xz, max(R.tank.w - wp.y, 0.0), R.camPos.w);
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
  return vec4f(underwater(col, in.sun * floorCaustic(in.wp), in.veil, in.dist), 1.0);
}

// ---- light shafts ----------------------------------------------------------------

fn interleavedNoise(p: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715))));
}

// Single-scattered sunlight along each view ray, from the camera up to the range limit, the water
// surface, or the sea floor (whichever comes first; fish are too small to occlude beams, and
// ignoring them avoids holes where the depth buffer jumps between fish and background). Runs at
// reduced resolution into an additive layer.
@fragment
fn fsShaft(in: BgOut) -> @location(0) vec4f {
  // ray with unit forward component, so the march parameter t equals view depth
  let ray = R.camFwd.xyz + in.ndc.x * R.camRight.xyz * R.camRight.w + in.ndc.y * R.camUp.xyz * R.camUp.w;
  let rayLen = length(ray);
  var tEnd = SHAFT_RANGE / rayLen;
  if (ray.y > 0.0) { tEnd = min(tEnd, max(R.tank.w - R.camPos.y, 0.0) / ray.y); }
  if (tEnd <= 0.0) { return vec4f(0.0); }

  let jitter = interleavedNoise(in.clip.xy);
  let stepT = tEnd / f32(SHAFT_STEPS);
  var sum = vec3f(0.0);
  for (var i = 0; i < SHAFT_STEPS; i++) {
    let t = (f32(i) + jitter) * stepT;
    let p = R.camPos.xyz + ray * t;
    if (p.y < floorY(p.xz, R.tank.xyz)) { break; }
    let depth = max(R.tank.w - p.y, 0.0);
    let focus = shaftFocus(p.xz, depth, R.camPos.w);
    let density = SHAFT_BASE + SHAFT_GAIN * max(focus - 1.0, 0.0);
    // sunlight reaching the point, then the part of it that survives the trip to the eye
    sum += exp(-R.absorb.xyz * (depth + t * rayLen)) * density;
  }

  // forward scattering: brighter when looking toward the sun
  let cosTheta = dot(ray / rayLen, R.light.xyz);
  let g2 = SHAFT_G * SHAFT_G;
  let phase = (1.0 - g2) / pow(1.0 + g2 - 2.0 * SHAFT_G * cosTheta, 1.5);
  let light = sum * stepT * rayLen * phase * SHAFT_STRENGTH * R.absorb.w;
  // soft clip so a bright beam saturates smoothly instead of blowing out
  return vec4f((vec3f(1.0) - exp(-light * SHAFT_COLOR)), 0.0);
}

// Adds the shaft image to the finished frame (blend state does the adding).
@fragment
fn fsComposite(in: BgOut) -> @location(0) vec4f {
  let uv = vec2f(in.ndc.x * 0.5 + 0.5, 0.5 - in.ndc.y * 0.5);
  return textureSampleLevel(shaftTex, shaftSampler, uv, 0.0);
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

// Open-water colour seen along `ray` from the camera: brighter looking toward the surface,
// darker toward the floor. Also stands in for the mirror-like underside of the surface.
fn waterColor(ray: vec3f) -> vec3f {
  let veil = depthLight(R.camPos.y).veil;
  let toSurface = smoothstep(-0.05, 0.9, ray.y);
  let toFloor = smoothstep(0.05, -0.85, ray.y);
  return veil * (1.0 + 1.6 * toSurface) * (1.0 - 0.65 * toFloor);
}

@fragment
fn fsBg(in: BgOut) -> @location(0) vec4f {
  let ray = normalize(
    R.camFwd.xyz + in.ndc.x * R.camRight.xyz * R.camRight.w + in.ndc.y * R.camUp.xyz * R.camUp.w);
  let sigma = R.absorb.xyz;
  let camDepth = max(R.tank.w - R.camPos.y, 0.0);
  // above the water, rays that point up see the sky, not the underwater gradient
  if (R.camPos.y >= R.tank.w && ray.y > 0.0) {
    return vec4f(skyColor(ray), 1.0);
  }
  var col = waterColor(ray);

  // the sun seen through the water: a soft halo plus a tight core, tinted blue-green
  let s = max(dot(ray, R.light.xyz), 0.0);
  let glow = 0.35 * pow(s, 6.0) + 0.9 * pow(s, 80.0);
  col += vec3f(0.55, 0.85, 0.95) * glow * exp(-sigma * camDepth) * smoothstep(0.0, 0.3, ray.y);
  return vec4f(col, 1.0);
}

// ---- water surface -----------------------------------------------------------

// Gerstner waves: each crest moves points horizontally as well as vertically, which sharpens
// crests and flattens troughs. Returns the (dx, dy, dz) displacement of rest position `xz`.
fn waveDisplace(xz: vec2f, t: f32) -> vec3f {
  var d = vec3f(0.0);
  for (var i = 0u; i < WAVE_MESH_COUNT; i++) {
    let w = WAVES[i];
    let phase = wavePhase(i, xz, t);
    let c = cos(phase);
    let q = WAVE_DYNAMICS[i].y;
    d.x += q * w.z * w.x * c;
    d.z += q * w.z * w.y * c;
    d.y += w.z * sin(phase);
  }
  return d;
}

// upward-facing surface normal at rest position `xz`
fn waveNormal(xz: vec2f, t: f32) -> vec3f {
  var n = vec3f(0.0, 1.0, 0.0);
  for (var i = 0u; i < WAVE_COUNT; i++) {
    let w = WAVES[i];
    let phase = wavePhase(i, xz, t);
    let c = cos(phase);
    n.x -= w.x * w.w * w.z * c;
    n.z -= w.y * w.w * w.z * c;
    n.y -= WAVE_DYNAMICS[i].y * w.w * w.z * sin(phase);
  }
  return normalize(n);
}

// the sky as seen from underneath or reflected: pale at the horizon, deeper blue overhead, sun disc
fn skyColor(dir: vec3f) -> vec3f {
  let up = clamp(dir.y, 0.0, 1.0);
  let base = mix(vec3f(0.72, 0.82, 0.92), vec3f(0.10, 0.32, 0.70), pow(up, 0.5));
  let s = max(dot(dir, R.light.xyz), 0.0);
  let sun = pow(s, 600.0) * 12.0 + pow(s, 24.0) * 0.35;
  return base + vec3f(1.0, 0.94, 0.8) * sun;
}

struct SurfaceOut {
  @builtin(position) clip: vec4f,
  @location(0) rest: vec2f,
  @location(1) wp: vec3f,
  @location(2) edge: f32,
};

@vertex
fn vsSurface(@builtin(vertex_index) vi: u32) -> SurfaceOut {
  let xz = gridVertex(vi);
  let d = waveDisplace(xz, R.camPos.w);
  var o: SurfaceOut;
  o.rest = xz;
  o.wp = vec3f(xz.x + d.x, R.tank.w + d.y, xz.y + d.z);
  o.clip = R.viewProj * vec4f(o.wp, 1.0);
  // fade the surface out toward the edge of the mesh so it melts into the open water beyond
  let r = max(abs(xz.x) / (R.floorGrid.z * 0.5), abs(xz.y) / (R.floorGrid.w * 0.5));
  o.edge = 1.0 - smoothstep(0.7, 1.0, r);
  return o;
}

fn fresnel(cosTheta: f32) -> f32 {
  return 0.02 + 0.98 * pow(1.0 - clamp(cosTheta, 0.0, 1.0), 5.0);
}

@fragment
fn fsSurface(in: SurfaceOut) -> @location(0) vec4f {
  let n = waveNormal(in.rest, R.camPos.w);
  let toCam = R.camPos.xyz - in.wp;
  let dist = length(toCam);
  let v = toCam / dist;

  var color: vec3f;
  var alpha: f32;
  if (R.camPos.y >= R.tank.w) {
    // from above: mostly see through the water, plus a Fresnel reflection of the sky
    let f = fresnel(dot(n, v));
    color = skyColor(reflect(-v, n)) * f;
    alpha = f;
  } else {
    // from below: the sky is seen through Snell's window, mirrored water elsewhere
    let nd = -n;
    let refracted = refract(-v, nd, 1.33);
    // past the critical angle (refracted == 0) the surface mirrors the water below it; that colour
    // is already hazed, so only the sky seen through the window is attenuated along the way
    let mirror = waterColor(reflect(-v, nd));
    color = mirror;
    if (dot(refracted, refracted) > 1e-4) {
      let sky = underwater(skyColor(refracted), vec3f(1.0), WATER_SCATTER, dist);
      // Schlick evaluated at the angle of the transmitted ray: on the dense side of the interface
      // reflectance climbs smoothly to 1 at the critical angle instead of jumping there
      color = mix(sky, mirror, fresnel(dot(refracted, n)));
    }
    alpha = 1.0;
  }
  return vec4f(color * in.edge, alpha * in.edge);
}
