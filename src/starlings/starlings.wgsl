// Starling murmuration at dusk. Everything except the birds is painted as a function of view
// direction (the camera never moves): sky, sun, hills, lake, then reeds over the top.

struct SU {
  viewProj: mat4x4f,
  camRight: vec4f, // xyz, a = tan(fov/2) * aspect
  camUp: vec4f,    // xyz, a = tan(fov/2)
  camFwd: vec4f,   // xyz, a = time in seconds
  camPos: vec4f,   // xyz, a = viewport height in pixels
  hawk: vec4f,     // position xyz, a = 1 while flying
  hawkDir: vec4f,  // unit heading xyz, a = wing phase
};

@group(0) @binding(0) var<uniform> U: SU;
@group(0) @binding(1) var<storage, read> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read> vel: array<vec4f>;
@group(0) @binding(3) var<storage, read> avgVel: array<vec4f>; // running average, see bank.wgsl
// the flock mirrored in the lake, as coverage in .r (drawn each frame before the background)
@group(0) @binding(4) var reflectTex: texture_2d<f32>;
@group(0) @binding(5) var reflectSampler: sampler;

// ---- noise -----------------------------------------------------------------------

fn hash1(x: f32) -> f32 {
  return fract(sin(x * 127.1 + 31.7) * 43758.5453);
}

fn noise1(x: f32) -> f32 {
  let i = floor(x);
  let f = fract(x);
  return mix(hash1(i), hash1(i + 1.0), f * f * (3.0 - 2.0 * f));
}

fn fbm1(x: f32) -> f32 {
  return noise1(x) * 0.55 + noise1(x * 2.3 + 1.7) * 0.3 + noise1(x * 5.1 + 4.2) * 0.15;
}

fn hash2(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn noise2(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash2(i), hash2(i + vec2f(1.0, 0.0)), u.x),
    mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), u.x),
    u.y);
}

// ---- dusk scene ------------------------------------------------------------------

fn elevation(d: vec3f) -> f32 { return asin(clamp(d.y, -1.0, 1.0)); }
fn azimuth(d: vec3f) -> f32 { return atan2(d.x, -d.z); }

// sky and sun for a direction at or above the horizon
fn sky(d: vec3f) -> vec3f {
  let e = max(elevation(d), 0.0);
  var col = mix(SCENE_HORIZON, SCENE_MID, smoothstep(0.0, 0.22, e));
  col = mix(col, SCENE_ZENITH, smoothstep(0.15, 0.9, e));
  // faint stratus streaks low in the sky, catching the sun
  let az = azimuth(d);
  let streak = smoothstep(0.55, 0.9, noise2(vec2f(az * 3.0, e * 70.0))) * exp(-e * 9.0);
  col = mix(col, SCENE_GLOW_COLOR, streak * 0.25);
  let ang = acos(clamp(dot(d, SUN_DIR), -1.0, 1.0));
  col += SCENE_GLOW_COLOR * (0.45 * exp(-ang * 7.0) + 0.35 * exp(-ang * 35.0));
  let disc = 1.0 - smoothstep(SCENE_SUN_SIZE * 0.85, SCENE_SUN_SIZE, ang);
  return mix(col, SCENE_SUN_COLOR, disc);
}

// heights (elevation, radians) of the far and near hill ranges at an azimuth
fn hills(az: f32) -> vec2f {
  let far = 0.012 + 0.016 * fbm1(az * 5.0 + 2.0);
  let near = 0.002 + 0.028 * max(fbm1(az * 3.2 + 9.0) - 0.35, 0.0) * 1.6;
  return vec2f(far, near);
}

// everything above the waterline: sky, sun and the two hill ranges (the sun sits behind the far
// range only where that range is lower than it)
fn land(d: vec3f) -> vec3f {
  let e = elevation(d);
  let h = hills(azimuth(d));
  if (e < h.y) { return SCENE_NEAR_HILLS; }
  if (e < h.x) {
    // far hills: lit a little from behind, fading into the haze toward their tops
    return mix(SCENE_FAR_HILLS, SCENE_HORIZON * 0.75, 0.25 * (e / h.x));
  }
  return sky(d);
}

// How much of the mirrored flock covers this bit of water: the reflection texture read through the
// same ripples as the rest of the lake, smeared vertically like a reflection on slightly moving water.
// `uv` is the screen position (0..1, y down).
fn flockReflection(uv: vec2f, az: f32, depth: f32, t: f32) -> f32 {
  let wobble = (noise2(vec2f(az * 60.0, depth * 400.0 - t * 0.6)) - 0.5) * REFLECT_RIPPLE;
  // a small tent blur: 5 taps down the streak, 3 across (one reflection texel apart)
  let texel = 1.0 / vec2f(textureDimensions(reflectTex));
  var ink = 0.0;
  for (var k = -2; k <= 2; k++) {
    for (var j = -1; j <= 1; j++) {
      let at = uv + vec2f(wobble + f32(j) * texel.x, f32(k) * REFLECT_STREAK * 0.5);
      ink += textureSampleLevel(reflectTex, reflectSampler, at, 0.0).r * (3.0 - abs(f32(k))) * (2.0 - abs(f32(j)));
    }
  }
  return ink / 36.0;
}

// full background: land above the horizon, the lake below it reflecting land, sun and flock
fn scene(d: vec3f, uv: vec2f) -> vec3f {
  let e = elevation(d);
  if (e >= 0.0) { return land(d); }
  let depth = -e;
  let az = azimuth(d);
  let t = U.camFwd.w;
  // gentle ripples: wobble the reflected direction a little, more toward the viewer
  let wobble = (noise2(vec2f(az * 60.0, depth * 400.0 - t * 0.6)) - 0.5) * 0.004 * (0.3 + depth * 6.0);
  var r = vec3f(d.x, -d.y + wobble, d.z);
  r = normalize(r);
  var col = land(r) * SCENE_WATER;
  // the sun's path on the water: a column of glints broken into horizontal dashes
  let column = exp(-abs(az - SCENE_SUN_AZIMUTH) / (0.004 + depth * 0.12));
  let dashes = smoothstep(0.45, 0.75, noise2(vec2f(az * 260.0, depth * 1400.0 - t * 1.5)));
  col += SCENE_SUN_COLOR * column * dashes * 0.9 * (1.0 - smoothstep(0.0, 0.2, depth));
  // the flock overhead, mirrored (it also blocks the sun's glints where it passes in front)
  col = mix(col, BIRD_COLOR * SCENE_WATER, saturate(flockReflection(uv, az, depth, t) * REFLECT_STRENGTH));
  // the lake darkens toward the viewer, where it reflects the darker sky overhead
  return col * (1.0 - 0.35 * smoothstep(0.0, 0.3, depth));
}

// Reeds in the foreground, as coverage (0..1). Three layers of thin stalks, each with a cattail head,
// swaying slowly. `pxAngle` is the size of one pixel in radians, for antialiasing.
fn reeds(d: vec3f, pxAngle: f32) -> f32 {
  let e = elevation(d);
  let az = azimuth(d);
  let t = U.camFwd.w;
  var cover = 0.0;
  for (var k = 0; k < 3; k++) {
    let fk = f32(k);
    let density = 70.0 + 55.0 * fk;
    let column = floor(az * density);
    // a leaning stalk can cross into the next column, so test this column and both neighbours
    for (var j = -1; j <= 1; j++) {
      let i = column + f32(j);
      let seed = i + fk * 101.0;
      if (hash1(seed) < SCENE_REED_SPARSE) { continue; }
      // most stalks stop below the horizon; a few poke up into the sky
      let tall = pow(hash1(seed + 3.0), 3.0);
      let top = SCENE_REED_TOP - 0.24 + 0.24 * tall + 0.035 * fk;
      if (e > top) { continue; }
      let lean = (hash1(seed + 5.0) - 0.5) * 0.06; // stalks are not quite vertical
      let rise = top - e;
      let sway = SCENE_REED_SWAY * sin(t * 0.7 + seed * 1.3) * (1.0 - rise / (top + 0.5));
      let centre = (i + 0.2 + 0.6 * hash1(seed + 7.0)) / density + lean * rise + sway;
      var halfWidth = SCENE_REED_WIDTH * (1.0 + 0.5 * fk);
      // cattail: a thicker head just below the tip on most stalks
      if (hash1(seed + 9.0) > 0.4 && rise > 0.006 && rise < 0.03) { halfWidth *= 2.4; }
      let dist = abs(az - centre);
      cover = max(cover, clamp((halfWidth - dist) / pxAngle + 0.5, 0.0, 1.0));
    }
  }
  return cover;
}

// ---- full-screen passes ------------------------------------------------------------

struct BgOut {
  @builtin(position) clip: vec4f,
  @location(0) ndc: vec2f,
};

@vertex
fn vsBg(@builtin(vertex_index) vi: u32) -> BgOut {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: BgOut;
  o.ndc = corners[vi];
  o.clip = vec4f(o.ndc, 0.0, 1.0);
  return o;
}

fn viewRay(ndc: vec2f) -> vec3f {
  return normalize(U.camFwd.xyz + ndc.x * U.camRight.xyz * U.camRight.w + ndc.y * U.camUp.xyz * U.camUp.w);
}

@fragment
fn fsBg(in: BgOut) -> @location(0) vec4f {
  let uv = vec2f(in.ndc.x * 0.5 + 0.5, 0.5 - in.ndc.y * 0.5);
  return vec4f(scene(viewRay(in.ndc), uv), 1.0);
}

@fragment
fn fsReeds(in: BgOut) -> @location(0) vec4f {
  let pxAngle = 2.0 * U.camUp.w / U.camPos.w;
  let a = reeds(viewRay(in.ndc), pxAngle);
  return vec4f(SCENE_REEDS * a, a);
}

// ---- birds ---------------------------------------------------------------------------

struct BirdOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) col: vec3f,
  @location(2) alpha: f32,
};

// A camera-facing quad at world point `p`, spanning `span` x `thick` metres across and along the
// heading as seen on screen, never smaller than `minPx` (fainter instead). `shade` adds the haze
// colour; the reflection pass only needs coverage, so it skips that sky lookup.
fn speck(p: vec3f, heading: vec3f, span: f32, thick: f32, corner: vec2f, minPx: f32, shade: bool) -> BirdOut {
  let c = U.viewProj * vec4f(p, 1.0);
  let ahead = U.viewProj * vec4f(p + heading, 1.0);
  let height = U.camPos.w;
  let width = height * U.camRight.w / U.camUp.w;
  let px = vec2f(width, height) * 0.5;
  var fwd = (ahead.xy / ahead.w - c.xy / c.w) * px;
  fwd = select(vec2f(1.0, 0.0), normalize(fwd), length(fwd) > 1e-5);
  let side = vec2f(-fwd.y, fwd.x);
  let focal = height * 0.5 / U.camUp.w; // pixels per metre at unit distance
  let spanPx = span * focal / c.w;
  let thickPx = thick * focal / c.w;
  let s = max(spanPx, minPx);
  let t = max(thickPx, minPx * 0.7);
  var o: BirdOut;
  let offsetPx = side * corner.x * s * 0.5 + fwd * corner.y * t * 0.5;
  o.clip = vec4f(c.xy + offsetPx / px * c.w, c.zw);
  o.uv = corner;
  // keep the ink a speck puts down roughly equal to its true size
  o.alpha = min(1.0, (spanPx * thickPx) / (s * t) * 1.5);
  o.col = BIRD_COLOR;
  if (shade) {
    // distant birds take on a little of the sky behind them
    let haze = 1.0 - exp(-c.w * BIRD_HAZE);
    o.col = mix(BIRD_COLOR, land(normalize(p - U.camPos.xyz)), haze);
  }
  return o;
}

const CORNERS = array<vec2f, 6>(
  vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
  vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));

// a point reflected in the lake surface; directions reflect by flipping y (MIRROR)
fn mirrorPoint(p: vec3f) -> vec3f { return vec3f(p.x, 2.0 * WATER_Y - p.y, p.z); }
const MIRROR = vec3f(1.0, -1.0, 1.0);

// One bird as a speck. `mirror` draws its reflection instead: the bird flipped through the lake
// surface (position, velocity and gravity), seen by the same camera.
fn birdSpeck(vi: u32, ii: u32, mirror: bool, minPx: f32) -> BirdOut {
  let flip = select(vec3f(1.0), MIRROR, mirror);
  let p = select(pos[ii].xyz, mirrorPoint(pos[ii].xyz), mirror);
  let v = vel[ii];
  let vel3 = v.xyz * flip;
  let speed = length(vel3);
  let heading = select(vec3f(1.0, 0.0, 0.0), vel3 / speed, speed > 1e-4);
  // wings: open and close with the sim's wingbeat phase, except for birds currently gliding
  let gliding = step(1.0 - BIRD_GLIDE, noise1(f32(ii) * 0.37 + U.camFwd.w * 0.5));
  let beat = abs(sin(v.w));
  let wings = mix(1.0 - BIRD_FLAP * (1.0 - beat), 1.0, gliding);

  // Bank: lift must hold the bird up and pull it round the turn, so the wing normal leans from
  // vertical toward the turn. Seen from the camera the wings then show their face (dark) or their
  // edge (faint), which is what draws the rolling bands across a turning murmuration.
  // An exponential average lags a steady turn by its time constant, so this is the smoothed turn.
  let accel = (vel3 - avgVel[ii].xyz * flip) / BIRD_BANK_SMOOTHING;
  let up = vec3f(0.0, 1.0, 0.0) * flip;
  let lift = (accel - heading * dot(accel, heading)) + (up - heading * dot(up, heading)) * BIRD_BANK_GRAVITY;
  let normal = lift / max(length(lift), 1e-4); // zero only in a vertical climb with no turn
  let toCam = normalize(U.camPos.xyz - p);
  let facing = abs(dot(normal, toCam));
  // a wing pointing at the camera foreshortens to little more than the body
  let wingAxis = cross(heading, normal);
  let spanSeen = max(sqrt(max(0.0, 1.0 - dot(wingAxis, toCam) * dot(wingAxis, toCam))), 0.3);
  let thick = mix(BIRD_EDGE_THICKNESS, BIRD_THICKNESS, facing);
  var o = speck(p, heading, BIRD_WINGSPAN * wings * spanSeen, thick, CORNERS[vi], minPx, !mirror);
  o.alpha *= BIRD_OPACITY;
  return o;
}

@vertex
fn vsBird(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> BirdOut {
  return birdSpeck(vi, ii, false, BIRD_MIN_PIXELS);
}

@vertex
fn vsBirdReflection(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> BirdOut {
  return birdSpeck(vi, ii, true, REFLECT_MIN_PIXELS);
}

// soft oval: tiny on screen, so only the falloff matters
fn birdCoverage(in: BirdOut) -> f32 {
  return clamp(1.4 * (1.0 - length(in.uv)), 0.0, 1.0) * in.alpha;
}

@fragment
fn fsBird(in: BirdOut) -> @location(0) vec4f {
  let a = birdCoverage(in);
  return vec4f(in.col * a, a);
}

// reflection pass: coverage only, in .r (the lake supplies the colour)
@fragment
fn fsBirdCoverage(in: BirdOut) -> @location(0) vec4f {
  let a = birdCoverage(in);
  return vec4f(a, 0.0, 0.0, a);
}

// ---- hawk -------------------------------------------------------------------------------

fn hawkSpeck(vi: u32, mirror: bool) -> BirdOut {
  let p = select(U.hawk.xyz, mirrorPoint(U.hawk.xyz), mirror);
  let dir = U.hawkDir.xyz * select(vec3f(1.0), MIRROR, mirror);
  var o = speck(p, dir, HAWK_WINGSPAN, HAWK_WINGSPAN, CORNERS[vi], 4.0, !mirror);
  if (U.hawk.w < 0.5) { o.clip = vec4f(0.0, 0.0, -2.0, 1.0); }
  return o;
}

@vertex
fn vsHawk(@builtin(vertex_index) vi: u32) -> BirdOut {
  return hawkSpeck(vi, false);
}

@vertex
fn vsHawkReflection(@builtin(vertex_index) vi: u32) -> BirdOut {
  return hawkSpeck(vi, true);
}

// Raptor silhouette in quad space (x across the wings, y along the heading): a slim body and two
// long wings swept slightly back, their tips rising and falling with the wingbeat.
fn hawkCoverage(in: BirdOut) -> f32 {
  let p = in.uv;
  let ax = abs(p.x);
  let body = 1.0 - smoothstep(0.08, 0.14, length(vec2f(p.x * 2.4, p.y * 0.55)));
  let flap = sin(U.hawkDir.w) * 0.25 * ax;
  let wingY = -0.25 * ax + 0.08 + flap; // swept back toward the tips
  let chord = 0.2 * (1.0 - ax * 0.7);
  let wing = (1.0 - smoothstep(chord * 0.7, chord, abs(p.y - wingY))) * (1.0 - smoothstep(0.9, 1.0, ax));
  let tail = (1.0 - smoothstep(0.1, 0.16, ax)) * step(-0.75, p.y) * step(p.y, -0.2);
  return clamp(max(max(body, wing), tail), 0.0, 1.0) * in.alpha;
}

@fragment
fn fsHawk(in: BirdOut) -> @location(0) vec4f {
  let a = hawkCoverage(in);
  return vec4f(in.col * a, a);
}

@fragment
fn fsHawkCoverage(in: BirdOut) -> @location(0) vec4f {
  let a = hawkCoverage(in);
  return vec4f(a, 0.0, 0.0, a);
}
