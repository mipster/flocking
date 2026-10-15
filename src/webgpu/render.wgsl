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
  post: vec4f,      // x = vignette strength
  waves: vec4f,     // x = wave height scale, y = wavenumber scale, w = wave clock (seconds)
};

@group(0) @binding(0) var<uniform> R: RU;
@group(0) @binding(1) var<storage, read> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read> vel: array<vec4f>;
// per species: [scale, glint, 0, 0], [r, g, b, 0]
@group(0) @binding(3) var<uniform> SP: array<vec4f, SPECIES_COUNT * 2u>;
// per fish, two vec4s written by fishShade each frame: [sun rgb, colour hash] and [veil rgb, 0]
@group(0) @binding(4) var<storage, read> shade: array<vec4f>;
// indices of the fish that survived culling, for this draw (simple or full mesh)
@group(0) @binding(6) var<storage, read> visible: array<u32>;
// light shafts: the half-size shaft image the composite pass adds on top of the frame
@group(0) @binding(11) var shaftTex: texture_2d<f32>;
@group(0) @binding(12) var shaftSampler: sampler;
// marine snow: per-speck placement and look written by snowPrep (compute) and read by vsSnow
@group(0) @binding(13) var<storage, read> snow: array<vec4f>;
@group(0) @binding(14) var<storage, read_write> snowOut: array<vec4f>;
// bubbles: per-bubble placement and look written by bubblePrep (compute) and read by vsBubble
@group(0) @binding(15) var<storage, read> bubbles: array<vec4f>;
@group(0) @binding(16) var<storage, read_write> bubblesOut: array<vec4f>;
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
  let focus = causticAt(p);
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
  let w = clamp((FISH_TAIL_START - l.x) / FISH_TAIL_LENGTH, 0.0, 1.0);
  l.z += sin(vw.w - l.x * TAIL_K) * TAIL_AMP * w * w;

  let world = pw.xyz + (fwd * l.x + up * l.y + side * l.z) * scale;

  let s0 = shade[fi * 2u];
  var o: VOut;
  o.clip = R.viewProj * vec4f(world, 1.0);
  o.nrm = fwd * n.x + up * n.y + side * n.z;
  o.col = SP[sp * 2u + 1u].rgb * (FISH_TINT_BASE + FISH_TINT_RANGE * s0.w);
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
  var col = in.col * (FISH_AMBIENT + FISH_HEMISPHERE * hemi + FISH_DIFFUSE * lambert);
  col = mix(col, col * FISH_BELLY_LIFT + vec3f(FISH_BELLY_FLOOR), smoothstep(0.0, -FISH_BELLY_FADE, in.localY));

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

// sunlight multiplier from the wave focusing at a world position under the water
fn causticAt(p: vec3f) -> f32 {
  return causticLight(p.xz, max(R.tank.w - p.y, 0.0), R.waves.w);
}

fn floorCaustic(wp: vec3f) -> f32 {
  if (R.camFwd.w < 0.5) { return 1.0; }
  return causticAt(wp);
}

@fragment
fn fsFloor(in: FloorOut) -> @location(0) vec4f {
  let half = R.tank.xyz;
  let p = in.wp.xz;
  let e = SAND_NORMAL_STEP;
  let h0 = floorY(p, half);
  let hx = floorY(p + vec2f(e, 0.0), half);
  let hz = floorY(p + vec2f(0.0, e), half);
  var n = normalize(vec3f(-(hx - h0) / e, 1.0, -(hz - h0) / e));

  // fine detail fades with distance so it doesn't shimmer
  let detail = 1.0 - smoothstep(SAND_DETAIL_NEAR, SAND_DETAIL_FAR, in.dist);

  // wind ripples: wavy ridges perpendicular to the ripple direction, warped by noise
  let warp = vnoise(p * SAND_RIPPLE_WARP_SCALE) * SAND_RIPPLE_WARP;
  let rp = (dot(p, SAND_RIPPLE_DIRECTION) + warp) * SAND_RIPPLE_FREQUENCY;
  let ripple = sin(rp);
  let rippleDir = normalize(SAND_RIPPLE_DIRECTION);
  n = normalize(n + vec3f(rippleDir.x, 0.0, rippleDir.y) * cos(rp) * SAND_RIPPLE_TILT * detail);

  // sand grain at three scales
  let g1 = vnoise(p * SAND_GRAIN_SCALES.x);
  let g2 = mix(0.5, vnoise(p * SAND_GRAIN_SCALES.y), detail);
  let g3 = mix(0.5, hash2(floor(p * SAND_GRAIN_SCALES.z)), detail);
  var sand = mix(SAND_DARK, SAND_LIGHT, g1 * 0.5 + g2 * 0.5);
  sand *= (1.0 - 0.5 * SAND_GRAIN_SHADE) + SAND_GRAIN_SHADE * g3;
  sand *= (1.0 - SAND_RIPPLE_SHADE) + SAND_RIPPLE_SHADE * ripple * detail;

  let lambert = max(dot(n, R.light.xyz), 0.0);
  let col = sand * (SAND_AMBIENT + SAND_DIFFUSE * lambert);
  return vec4f(underwater(col, in.sun * floorCaustic(in.wp), in.veil, in.dist), 1.0);
}

// ---- light shafts ----------------------------------------------------------------

fn interleavedNoise(p: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715))));
}

fn hash3(p: vec3f) -> f32 {
  return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453);
}

// smooth value noise in 3D, 0..1
fn noise3(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let x0 = mix(hash3(i), hash3(i + vec3f(1.0, 0.0, 0.0)), u.x);
  let x1 = mix(hash3(i + vec3f(0.0, 1.0, 0.0)), hash3(i + vec3f(1.0, 1.0, 0.0)), u.x);
  let x2 = mix(hash3(i + vec3f(0.0, 0.0, 1.0)), hash3(i + vec3f(1.0, 0.0, 1.0)), u.x);
  let x3 = mix(hash3(i + vec3f(0.0, 1.0, 1.0)), hash3(i + vec3f(1.0, 1.0, 1.0)), u.x);
  return mix(mix(x0, x1, u.y), mix(x2, x3, u.y), u.z);
}

// Cloudiness of the water at a point: 1 on average, drifting slowly sideways, with a second
// finer layer so patches have ragged edges.
fn hazePatch(p: vec3f, t: f32) -> f32 {
  let q = (p + vec3f(t * HAZE_DRIFT, 0.0, t * HAZE_DRIFT * 0.6)) / HAZE_SCALE;
  let n = noise3(q) * 0.7 + noise3(q * 2.7 + vec3f(5.2, 1.3, 8.1)) * 0.3;
  return max(1.0 + HAZE_AMOUNT * (n * 2.0 - 1.0) * 1.6, 0.05);
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
  // beams stop at rock and coral: without this the march runs through them to the floor behind
  let blocker = textureLoad(rangeTex, vec2i(in.clip.xy), 0).r;
  tEnd = min(tEnd, blocker / rayLen);
  if (tEnd <= 0.0) { return vec4f(0.0); }

  let jitter = interleavedNoise(in.clip.xy);
  let stepT = tEnd / f32(SHAFT_STEPS);
  var sum = vec3f(0.0);
  for (var i = 0; i < SHAFT_STEPS; i++) {
    let t = (f32(i) + jitter) * stepT;
    let p = R.camPos.xyz + ray * t;
    if (p.y < floorY(p.xz, R.tank.xyz)) { break; }
    let depth = max(R.tank.w - p.y, 0.0);
    let focus = shaftFocus(p.xz, depth, R.waves.w);
    let density = (SHAFT_BASE + SHAFT_GAIN * max(focus - 1.0, 0.0)) * hazePatch(p, R.camPos.w);
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

// ---- marine snow ----------------------------------------------------------------

fn snowHash(i: u32, k: f32) -> f32 {
  return fract(sin((f32(i) + k * 7919.0) * 12.9898) * 43758.5453);
}

struct SnowOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) col: vec3f,
  @location(2) alpha: f32,
};

// Per-speck work, once per speck and frame instead of once per quad vertex. A speck's place is a
// function of its index and the time only: a fixed point in the world that sinks and sways,
// wrapped into a box around the camera so there are always specks nearby however far the camera
// travels. Writes [world position xyz, half-size] and [colour rgb, opacity] (opacity 0 = hidden).
@compute @workgroup_size(WORKGROUP_SIZE)
fn snowPrep(@builtin(global_invocation_id) gid: vec3u) {
  let ii = gid.x;
  if (ii * 2u + 1u >= arrayLength(&snowOut)) { return; }
  let t = R.camPos.w;
  let seed = vec3f(snowHash(ii, 0.0), snowHash(ii, 1.0), snowHash(ii, 2.0));
  let speed = SNOW_FALL * (0.4 + 1.2 * snowHash(ii, 3.0));
  let cam = R.camPos.xyz;
  // steady sinking, then a bounded wander in all three axes (each speck has its own phase and
  // rate); the wrap below only needs the unbounded part, which is the sinking
  var p = seed * SNOW_BOX + vec3f(0.0, -speed * t, 0.0);
  p = cam + (fract((p - cam) / SNOW_BOX + 0.5) - 0.5) * SNOW_BOX;
  let phase = seed * 6.2831853 * 7.0;
  let rate = 0.6 + 0.8 * vec3f(snowHash(ii, 6.0), snowHash(ii, 7.0), snowHash(ii, 8.0));
  p += SNOW_SWAY * sin(t * SNOW_SWAY_RATE * rate + phase) * vec3f(1.0, 0.0, 1.0);
  // waves move water in circles that shrink with depth, so specks near the surface also bob
  let bobDepth = max(R.tank.w - p.y, 0.0);
  p.y += SNOW_BOB * exp(-bobDepth * SNOW_BOB_FADE) * sin(t * SNOW_BOB_RATE * rate.y + phase.y);

  // specks above the water or inside the sand are not drawn
  if (p.y > R.tank.w || p.y < floorY(p.xz, R.tank.xyz)) {
    snowOut[ii * 2u + 1u] = vec4f(0.0);
    return;
  }

  let dist = distance(p, cam);
  let size = SNOW_SIZE * (0.5 + snowHash(ii, 4.0));
  // far specks would shrink below a pixel and shimmer, so keep a minimum angular size and give the
  // lost area back as lower opacity
  let wide = max(size, SNOW_MIN_ANGLE * dist);

  let dl = depthLight(p.y);
  let depth = max(R.tank.w - p.y, 0.0);
  let focus = shaftFocus(p.xz, depth, R.waves.w);
  let beam = 1.0 + SNOW_BEAM * clamp(focus - 1.0, 0.0, 2.0);
  let base = SNOW_COLOR * SNOW_BRIGHTNESS * (0.4 + 0.6 * snowHash(ii, 5.0)) * beam;

  snowOut[ii * 2u] = vec4f(p, wide);
  snowOut[ii * 2u + 1u] = vec4f(underwater(base, dl.sun, dl.veil, dist), SNOW_OPACITY * sqrt(size / wide));
}

// One camera-facing quad per speck (6 vertices per instance), placed from snowPrep's output.
@vertex
fn vsSnow(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SnowOut {
  let place = snow[ii * 2u];
  let look = snow[ii * 2u + 1u];
  var o: SnowOut;
  o.uv = vec2f(0.0);
  o.col = look.rgb;
  o.alpha = look.a;
  if (look.a <= 0.0) {
    o.clip = vec4f(0.0, 0.0, -2.0, 1.0); // outside the clip volume: culled
    return o;
  }
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let c = corners[vi];
  o.clip = R.viewProj * vec4f(place.xyz + (R.camRight.xyz * c.x + R.camUp.xyz * c.y) * place.w, 1.0);
  o.uv = c;
  return o;
}

@fragment
fn fsSnow(in: SnowOut) -> @location(0) vec4f {
  let a = smoothstep(1.0, 0.25, length(in.uv)) * in.alpha;
  return vec4f(in.col * a, a);
}

// ---- bubbles ----------------------------------------------------------------------

// Per-bubble work, once per bubble and frame. Bubbles are shared out between fixed vents on the
// sand; each has its own size, rise speed, pause before restarting and phase, and its place is a
// pure function of those and the time. Writes [world position xyz, radius] and [colour rgb,
// opacity] (opacity 0 = hidden: waiting at the vent, or already popped).
@compute @workgroup_size(WORKGROUP_SIZE)
fn bubblePrep(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i * 2u + 1u >= arrayLength(&bubblesOut)) { return; }
  let t = R.camPos.w;
  let vent = i % BUBBLE_VENTS;
  let half = R.tank.xyz;
  let vx = (snowHash(vent, 20.0) * 2.0 - 1.0) * (half.x - BUBBLE_MARGIN);
  let vz = (snowHash(vent, 21.0) * 2.0 - 1.0) * (half.z - BUBBLE_MARGIN);
  let ground = floorY(vec2f(vx, vz), half);

  // many small bubbles, a few big ones
  let s = snowHash(i, 22.0);
  let size = mix(BUBBLE_SIZE.x, BUBBLE_SIZE.y, s * s);
  let speed = BUBBLE_RISE_BASE + BUBBLE_RISE_GAIN * size;
  let rise = max(R.tank.w - ground, 1.0);
  let travel = rise / speed;
  let cycle = travel + BUBBLE_GAP * snowHash(i, 23.0);
  let age = fract(t / cycle + snowHash(i, 24.0)) * cycle;
  if (age > travel) {
    bubblesOut[i * 2u + 1u] = vec4f(0.0); // waiting at the vent
    return;
  }

  let up = age / travel; // 0 at the vent, 1 at the surface
  let wobblePhase = snowHash(i, 25.0) * 6.2831853;
  let sway = BUBBLE_WOBBLE * (0.2 + up) * vec2f(
    sin(age * BUBBLE_WOBBLE_RATE + wobblePhase),
    cos(age * BUBBLE_WOBBLE_RATE * 0.83 + wobblePhase * 1.7));
  let scatter = BUBBLE_SPREAD * vec2f(snowHash(i, 26.0) - 0.5, snowHash(i, 27.0) - 0.5);
  let p = vec3f(vx + scatter.x + sway.x, ground + speed * age, vz + scatter.y + sway.y);

  // fade in at the vent, swell on the way up, pop (a quick swell and fade) at the surface
  let remaining = travel - age;
  let pop = clamp(remaining / BUBBLE_POP_TIME, 0.0, 1.0);
  let radius = size * (1.0 + BUBBLE_GROWTH * up) * (1.0 + BUBBLE_POP_SWELL * (1.0 - pop));
  let dist = distance(p, R.camPos.xyz);
  let wide = max(radius, BUBBLE_MIN_ANGLE * dist);
  let dl = depthLight(p.y);
  let alpha = smoothstep(0.0, BUBBLE_FADE_IN, age) * pop * sqrt(radius / wide);

  bubblesOut[i * 2u] = vec4f(p, wide);
  bubblesOut[i * 2u + 1u] = vec4f(underwater(vec3f(1.0), dl.sun, dl.veil, dist), alpha);
}

@vertex
fn vsBubble(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SnowOut {
  let place = bubbles[ii * 2u];
  let look = bubbles[ii * 2u + 1u];
  var o: SnowOut;
  o.uv = vec2f(0.0);
  o.col = look.rgb;
  o.alpha = look.a;
  if (look.a <= 0.0) {
    o.clip = vec4f(0.0, 0.0, -2.0, 1.0);
    return o;
  }
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let c = corners[vi];
  o.clip = R.viewProj * vec4f(place.xyz + (R.camRight.xyz * c.x + R.camUp.xyz * c.y) * place.w, 1.0);
  o.uv = c;
  return o;
}

// A bubble is mostly clear: a thin bright rim, a faint body, a sharp highlight facing the sun and a
// weaker one on the opposite side (light that crossed the bubble and reflected off its far wall).
@fragment
fn fsBubble(in: SnowOut) -> @location(0) vec4f {
  let r = length(in.uv);
  let rim = smoothstep(0.6, 0.95, r) * (1.0 - smoothstep(0.96, 1.0, r));
  let body = 0.08 * (1.0 - smoothstep(0.9, 1.0, r));
  var toLight = vec2f(dot(R.light.xyz, R.camRight.xyz), dot(R.light.xyz, R.camUp.xyz));
  toLight = toLight / max(length(toLight), 0.001);
  let spot = 1.0 - smoothstep(0.0, 0.25, length(in.uv - toLight * 0.5));
  let echo = 1.0 - smoothstep(0.0, 0.3, length(in.uv + toLight * 0.5));
  let a = clamp(body + 0.5 * rim + 0.9 * spot + 0.3 * echo, 0.0, 1.0) * in.alpha;
  let col = mix(in.col, vec3f(1.0), clamp(spot + 0.4 * echo, 0.0, 1.0));
  return vec4f(col * a, a);
}

// ---- vignette ------------------------------------------------------------------

// Multiplies the finished frame (blend state does the multiplying) by a factor that falls from 1
// in the middle to 1 - strength at the corners.
@fragment
fn fsVignette(in: BgOut) -> @location(0) vec4f {
  let r = length(in.ndc) * 0.70710678; // 0 in the middle, 1 at the corners
  let mask = smoothstep(VIGNETTE_INNER, VIGNETTE_OUTER, r);
  return vec4f(vec3f(1.0 - R.post.x * mask), 1.0);
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
  let toSurface = smoothstep(BACKDROP_SURFACE_FROM, BACKDROP_SURFACE_TO, ray.y);
  let toFloor = smoothstep(BACKDROP_FLOOR_FROM, BACKDROP_FLOOR_TO, ray.y);
  return veil * (1.0 + BACKDROP_SURFACE_BOOST * toSurface) * (1.0 - BACKDROP_FLOOR_DIM * toFloor);
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
  let glow = BACKDROP_SUN_HALO * pow(s, BACKDROP_SUN_HALO_POWER) + BACKDROP_SUN_CORE * pow(s, BACKDROP_SUN_CORE_POWER);
  col += BACKDROP_SUN_COLOR * glow * exp(-sigma * camDepth) * smoothstep(0.0, BACKDROP_SUN_RISE, ray.y);
  return vec4f(col, 1.0);
}

// ---- water surface -----------------------------------------------------------

// Gerstner waves: each crest moves points horizontally as well as vertically, which sharpens
// crests and flattens troughs. Returns the (dx, dy, dz) displacement of rest position `xz`.
fn waveDisplace(xz: vec2f, t: f32) -> vec3f {
  var d = vec3f(0.0);
  for (var i = 0u; i < WAVE_MESH_COUNT; i++) {
    let w = waveShape(i);
    let phase = wavePhase(i, xz, t);
    let c = cos(phase);
    let q = waveSteepness(i);
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
    let w = waveShape(i);
    let phase = wavePhase(i, xz, t);
    let c = cos(phase);
    n.x -= w.x * w.w * w.z * c;
    n.z -= w.y * w.w * w.z * c;
    n.y -= waveSteepness(i) * w.w * w.z * sin(phase);
  }
  return normalize(n);
}

// the sky as seen from underneath or reflected: pale at the horizon, deeper blue overhead, sun disc
fn skyColor(dir: vec3f) -> vec3f {
  let up = clamp(dir.y, 0.0, 1.0);
  let base = mix(SKY_HORIZON, SKY_ZENITH, pow(up, SKY_ZENITH_POWER));
  let s = max(dot(dir, R.light.xyz), 0.0);
  let sun = pow(s, SKY_SUN_DISC_POWER) * SKY_SUN_DISC + pow(s, SKY_SUN_HALO_POWER) * SKY_SUN_HALO;
  return base + SKY_SUN_COLOR * sun;
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
  let d = waveDisplace(xz, R.waves.w);
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
  return FRESNEL_F0 + (1.0 - FRESNEL_F0) * pow(1.0 - clamp(cosTheta, 0.0, 1.0), 5.0);
}

@fragment
fn fsSurface(in: SurfaceOut) -> @location(0) vec4f {
  let n = waveNormal(in.rest, R.waves.w);
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
    let refracted = refract(-v, nd, WATER_IOR);
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

// ---- scenery ----------------------------------------------------------------------
// Rock and coral are one mesh built on the CPU from the scenery distance field. It is drawn three
// times, one tank width apart (like the floor), so formations wrap with the flock.

struct RockOut {
  @builtin(position) clip: vec4f,
  @location(0) nrm: vec3f,
  @location(1) col: vec3f,
  @location(2) wp: vec3f,
  @location(3) dist: f32,
  @location(4) sun: vec3f,
  @location(5) veil: vec3f,
};

@vertex
fn vsRock(
  @location(0) p: vec3f,
  @location(1) n: vec3f,
  @location(2) c: vec3f,
  @builtin(instance_index) ii: u32,
) -> RockOut {
  let wp = p + vec3f((f32(ii) - 1.0) * R.tank.x * 2.0, 0.0, 0.0);
  let dl = depthLight(wp.y);
  var o: RockOut;
  o.clip = R.viewProj * vec4f(wp, 1.0);
  o.nrm = n;
  o.col = c;
  o.wp = wp;
  o.dist = distance(wp, R.camPos.xyz);
  o.sun = dl.sun;
  o.veil = dl.veil;
  return o;
}

@fragment
fn fsRock(in: RockOut) -> @location(0) vec4f {
  let n = normalize(in.nrm);
  let lambert = max(dot(n, R.light.xyz), 0.0);
  let hemi = n.y * 0.5 + 0.5;
  // mottling: low-frequency noise so large faces are not flat colour
  let grain = 1.0 - SCENERY_DETAIL + SCENERY_DETAIL * 2.0 * noise3(in.wp * SCENERY_DETAIL_SCALE);
  let col = in.col * grain * (SCENERY_AMBIENT + SCENERY_HEMISPHERE * hemi + SCENERY_DIFFUSE * lambert);
  return vec4f(underwater(col, in.sun * floorCaustic(in.wp), in.veil, in.dist), 1.0);
}

// Seaweed: every plant is a few ribbon blades, built in the vertex shader from the plant's
// position, height and phase. Blades bend with height squared (a fixed base, a free tip).
@group(0) @binding(17) var<storage, read> weed: array<vec4f>;
// distance from the eye to the nearest rock, coral or seaweed per shaft-image pixel (huge where none)
@group(0) @binding(18) var rangeTex: texture_2d<f32>;

struct WeedOut {
  @builtin(position) clip: vec4f,
  @location(0) col: vec3f,
  @location(1) wp: vec3f,
  @location(2) dist: f32,
  @location(3) sun: vec3f,
  @location(4) veil: vec3f,
};

@vertex
fn vsWeed(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> WeedOut {
  let copy = ii % 3u;
  let plant = ii / 3u;
  let a = weed[plant * 2u];
  let b = weed[plant * 2u + 1u];
  let perBlade = SEAWEED_SEGMENTS * 6u;
  let blade = vi / perBlade;
  let q = (vi % perBlade) / 6u;
  let corner = vi % 6u;
  var cx = array<f32, 6>(0.0, 1.0, 0.0, 1.0, 1.0, 0.0);
  var cy = array<u32, 6>(0u, 0u, 1u, 0u, 1u, 1u);
  let side = cx[corner] * 2.0 - 1.0;
  let t = f32(q + cy[corner]) / f32(SEAWEED_SEGMENTS);

  let id = plant * 8u + blade;
  let yaw = snowHash(id, 31.0) * 6.2831853;
  let offset = (vec2f(snowHash(id, 32.0), snowHash(id, 33.0)) - 0.5) * 2.0 * SEAWEED_SPREAD;
  let height = a.w * (0.65 + 0.5 * snowHash(id, 34.0));
  let width = SEAWEED_WIDTH * (1.0 - 0.85 * t);
  let phase = b.x + snowHash(id, 35.0) * 3.0;
  let clock = R.waves.w * SEAWEED_SWAY_RATE;
  // a slow swell along the current plus a faster flutter across it
  let bend = t * t * SEAWEED_SWAY;
  let along = sin(clock + phase + t * 1.3) + 0.35 * sin(clock * 2.3 + phase * 1.7);
  let across = 0.4 * sin(clock * 1.7 + phase * 2.1 + t * 2.0);
  let current = vec2f(0.94, 0.34);
  let sway = (current * along + vec2f(-current.y, current.x) * across) * bend;

  let perp = vec2f(-sin(yaw), cos(yaw));
  let xz = a.xz + offset + sway + perp * side * width * 0.5
    + vec2f((f32(copy) - 1.0) * R.tank.x * 2.0, 0.0);
  let wp = vec3f(xz.x, a.y - 0.2 + t * height, xz.y);

  let dl = depthLight(wp.y);
  var o: WeedOut;
  o.clip = R.viewProj * vec4f(wp, 1.0);
  o.col = mix(SEAWEED_BASE, SEAWEED_TIP, t);
  o.wp = wp;
  o.dist = distance(wp, R.camPos.xyz);
  o.sun = dl.sun;
  o.veil = dl.veil;
  return o;
}

@fragment
fn fsWeed(in: WeedOut) -> @location(0) vec4f {
  // ribbons are thin: light them as if facing the sun a little, with no sharp terminator
  let col = in.col * (SEAWEED_AMBIENT + SEAWEED_DIFFUSE * (0.5 + 0.5 * R.light.y));
  return vec4f(underwater(col, in.sun * floorCaustic(in.wp), in.veil, in.dist), 1.0);
}

// Depth-only twins of the scenery shaders: they write the distance to the nearest surface into the
// shaft pass's range image, so light shafts can stop at it.
@fragment
fn fsRockRange(in: RockOut) -> @location(0) vec4f {
  return vec4f(in.dist, 0.0, 0.0, 1.0);
}

@fragment
fn fsWeedRange(in: WeedOut) -> @location(0) vec4f {
  return vec4f(in.dist, 0.0, 0.0, 1.0);
}
