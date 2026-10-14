struct RU {
  viewProj: mat4x4f,
  light: vec4f,   // xyz = direction to light
  fog: vec4f,     // rgb = color, a = density
};

@group(0) @binding(0) var<uniform> R: RU;
@group(0) @binding(1) var<storage, read> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read> vel: array<vec4f>;
// per species: [scale, 0, 0, 0], [r, g, b, 0]
@group(0) @binding(3) var<uniform> SP: array<vec4f, 6>;

const TAIL_AMP = 0.14;
const TAIL_K = 7.0;

struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) nrm: vec3f,
  @location(1) col: vec3f,
  @location(2) localY: f32,
  @location(3) depth: f32,
};

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
  o.depth = o.clip.w;
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
  let dens = R.fog.a;
  let f = clamp(1.0 - exp(-dens * dens * in.depth * in.depth), 0.0, 1.0);
  return vec4f(mix(col, R.fog.rgb, f), 1.0);
}
