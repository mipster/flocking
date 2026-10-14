// WebGPU boids. Two neighbor strategies share the same steering code:
//   steerBrute: every fish tests every fish (tiled through workgroup memory)
//   steerGrid : counting sort into (cell, species) buckets, then only nearby cells are scanned,
//               with at most `maxPerCell` samples taken from each bucket.

struct Params {
  a: vec4f,      // delta, time, count, maxPerCell
  bounds: vec4f, // tank half extents xyz, wall margin
  grid: vec4f,   // cellSize, nx, ny, nz
  flags: vec4f,  // x = wrap horizontally (1) or soft walls (0)
};

fn wrapOn() -> bool { return P.flags.x > 0.5; }

@group(0) @binding(0) var<uniform> P: Params;
// per species, 4 x vec4: [maxSpeed, maxForce, sepR, aliR] [cohR, sepW, aliW, cohW]
//                        [fearR, fearW, huntR, huntW]     [wander, scale, 0, 0]
@group(0) @binding(1) var<uniform> SPEC: array<vec4f, 12>;
@group(0) @binding(2) var<storage, read_write> pos: array<vec4f>;   // xyz, species
@group(0) @binding(3) var<storage, read_write> vel: array<vec4f>;   // xyz, swim phase
@group(0) @binding(4) var<storage, read_write> spos: array<vec4f>;  // snapshot (cell sorted in grid mode)
@group(0) @binding(5) var<storage, read_write> svel: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> cellCount: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read_write> cellStart: array<u32>;
@group(0) @binding(8) var<storage, read_write> keyOf: array<u32>;
@group(0) @binding(9) var<storage, read_write> rankOf: array<u32>;

const TAU = 6.28318530718;

struct Me {
  pos: vec3f, vel: vec3f, phase: f32, sp: u32,
  maxSpeed: f32, maxForce: f32, sepR: f32, aliR: f32, cohR: f32,
  fearR: f32, huntR: f32, scanR: f32, scale: f32,
};

struct Acc {
  sep: vec3f, ali: vec3f, coh: vec3f, fear: vec3f, hunt: vec3f,
  aliN: f32, cohN: f32, huntN: f32,
};

fn loadMe(i: u32) -> Me {
  let p = pos[i];
  let v = vel[i];
  let sp = u32(p.w + 0.5);
  let s0 = SPEC[sp * 4u];
  let s1 = SPEC[sp * 4u + 1u];
  let s2 = SPEC[sp * 4u + 2u];
  let s3 = SPEC[sp * 4u + 3u];
  var m: Me;
  m.pos = p.xyz; m.vel = v.xyz; m.phase = v.w; m.sp = sp;
  m.maxSpeed = s0.x; m.maxForce = s0.y; m.sepR = s0.z; m.aliR = s0.w;
  m.cohR = s1.x; m.fearR = s2.x; m.huntR = s2.z; m.scale = s3.y;
  m.scanR = max(max(max(m.sepR, m.aliR), max(m.cohR, m.fearR)), m.huntR);
  return m;
}

fn consider(acc: ptr<function, Acc>, m: Me, ow: vec4f, ov: vec3f, sepScale: f32) {
  if (ow.w < 0.0) { return; }
  var d = m.pos - ow.xyz;
  if (wrapOn()) {
    // shortest wrapped offset in x and z (y is never wrapped)
    let full = P.bounds.xyz * 2.0;
    d.x -= full.x * round(d.x / full.x);
    d.z -= full.z * round(d.z / full.z);
  }
  let opos = m.pos - d;
  let d2 = dot(d, d);
  if (d2 > m.scanR * m.scanR || d2 < 1e-8) { return; }
  let dist = sqrt(d2);
  let osp = u32(ow.w + 0.5);

  if (dist < m.sepR) { (*acc).sep += d / d2 * sepScale; }

  if (osp == m.sp) {
    if (dist < m.aliR) { (*acc).ali += ov; (*acc).aliN += 1.0; }
    if (dist < m.cohR) { (*acc).coh += opos; (*acc).cohN += 1.0; }
  } else if (osp > m.sp) {
    if (dist < m.fearR) { (*acc).fear += (d / dist) * (1.0 - dist / m.fearR); }
  } else {
    if (dist < m.huntR) { (*acc).hunt += opos; (*acc).huntN += 1.0; }
  }
}

fn steer(dir: vec3f, v: vec3f, maxSpeed: f32, maxForce: f32) -> vec3f {
  let l = length(dir);
  if (l < 1e-6) { return vec3f(0.0); }
  let s = dir * (maxSpeed / l) - v;
  let sl = length(s);
  return select(s, s * (maxForce / sl), sl > maxForce);
}

fn integrate(i: u32, m: Me, a: Acc) {
  let dt = P.a.x;
  let t = P.a.y;
  let s1 = SPEC[m.sp * 4u + 1u];
  let s2 = SPEC[m.sp * 4u + 2u];
  let s3 = SPEC[m.sp * 4u + 3u];

  var force = steer(a.sep, m.vel, m.maxSpeed, m.maxForce) * s1.y;
  if (a.aliN > 0.0) { force += steer(a.ali / a.aliN, m.vel, m.maxSpeed, m.maxForce) * s1.z; }
  if (a.cohN > 0.0) { force += steer(a.coh / a.cohN - m.pos, m.vel, m.maxSpeed, m.maxForce) * s1.w; }
  force += steer(a.fear, m.vel, m.maxSpeed * 1.3, m.maxForce * 2.0) * s2.y;
  if (a.huntN > 0.0) { force += steer(a.hunt / a.huntN - m.pos, m.vel, m.maxSpeed, m.maxForce) * s2.w; }

  // lazy wander with a per-fish phase offset
  let id = fract(f32(i) * 0.6180339887) * 100.0;
  let wd = vec3f(sin(t * 0.40 + id * 6.1), sin(t * 0.31 + id * 3.7), cos(t * 0.27 + id * 9.3));
  force += wd * m.maxForce * s3.x;

  // soft tank walls
  let margin = P.bounds.w;
  let inner = P.bounds.xyz - vec3f(margin);
  var over = (abs(m.pos) - inner) / margin;
  if (wrapOn()) { over.x = 0.0; over.z = 0.0; }
  over.y = max(0.0, (m.pos.y - inner.y) / margin);   // top only; the bottom is the sea floor
  force -= sign(m.pos) * clamp(over, vec3f(0.0), vec3f(2.0)) * m.maxForce * 2.0;

  // sea floor: push up as the fish gets within `margin` of the sand
  let clearance = m.pos.y - floorY(m.pos.xz, P.bounds.xyz);
  force.y += clamp((margin - clearance) / margin, 0.0, 2.0) * m.maxForce * 2.0;

  var v = m.vel + force * dt;
  var speed = length(v);
  if (speed < 1e-4) { v = vec3f(1.0, 0.0, 0.0) * m.maxSpeed * 0.5; speed = length(v); }
  v = v * (clamp(speed, m.maxSpeed * 0.4, m.maxSpeed) / speed);
  speed = length(v);

  let phase = (m.phase + dt * (3.0 + speed * 1.2 / m.scale)) % TAU;
  var np = m.pos + v * dt;
  let h = P.bounds.xyz;
  if (wrapOn()) {
    let full = h * 2.0;
    np.x -= full.x * floor((np.x + h.x) / full.x);
    np.z -= full.z * floor((np.z + h.z) / full.z);
  } else {
    // hard backstop so nothing ever leaves through a side wall
    if (abs(np.x) > h.x) { np.x = sign(np.x) * h.x; v.x = 0.0; }
    if (abs(np.z) > h.z) { np.z = sign(np.z) * h.z; v.z = 0.0; }
  }
  // sea floor and surface are barriers in both modes
  let yMin = floorY(np.xz, h) + 0.6;
  let yMax = h.y - 0.5;
  if (np.y < yMin) { np.y = yMin; v.y = max(v.y, 0.0); }
  if (np.y > yMax) { np.y = yMax; v.y = min(v.y, 0.0); }

  vel[i] = vec4f(v, phase);
  pos[i] = vec4f(np, f32(m.sp));
}

fn pcg(x: u32) -> u32 {
  let s = x * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

fn gridDims() -> vec3i {
  return vec3i(i32(P.grid.y), i32(P.grid.z), i32(P.grid.w));
}

fn wrapIdx(i: i32, n: i32) -> i32 {
  return ((i % n) + n) % n;
}

// unclamped integer cell coordinates
fn rawCell(p: vec3f) -> vec3i {
  return vec3i(floor((p + P.bounds.xyz) / P.grid.x));
}

fn cellOfPos(p: vec3f) -> vec3i {
  let d = gridDims();
  var c = rawCell(p);
  if (wrapOn()) {
    c.x = wrapIdx(c.x, d.x);
    c.z = wrapIdx(c.z, d.z);
  }
  return clamp(c, vec3i(0), d - vec3i(1));
}

// ---- brute force -----------------------------------------------------------

@compute @workgroup_size(64)
fn snapshot(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= u32(P.a.z)) { return; }
  spos[i] = pos[i];
  svel[i] = vel[i];
}

var<workgroup> tp: array<vec4f, 64>;
var<workgroup> tv: array<vec4f, 64>;

@compute @workgroup_size(64)
fn steerBrute(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) lid: u32) {
  let n = u32(P.a.z);
  let i = gid.x;
  let valid = i < n;
  var m: Me;
  if (valid) { m = loadMe(i); }
  var acc: Acc;
  let tiles = (n + 63u) / 64u;
  for (var t = 0u; t < tiles; t++) {
    let j = t * 64u + lid;
    if (j < n) {
      tp[lid] = spos[j];
      tv[lid] = svel[j];
    } else {
      tp[lid] = vec4f(0.0, 0.0, 0.0, -1.0);
      tv[lid] = vec4f(0.0);
    }
    workgroupBarrier();
    if (valid) {
      for (var k = 0u; k < 64u; k++) {
        consider(&acc, m, tp[k], tv[k].xyz, 1.0);
      }
    }
    workgroupBarrier();
  }
  if (valid) { integrate(i, m, acc); }
}

// ---- spatial grid ----------------------------------------------------------

@compute @workgroup_size(64)
fn clearCells(@builtin(global_invocation_id) gid: vec3u) {
  let keys = u32(P.grid.y * P.grid.z * P.grid.w) * 3u;
  if (gid.x < keys) { atomicStore(&cellCount[gid.x], 0u); }
}

@compute @workgroup_size(64)
fn countCells(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= u32(P.a.z)) { return; }
  let p = pos[i];
  let c = cellOfPos(p.xyz);
  let d = gridDims();
  let cell = u32((c.z * d.y + c.y) * d.x + c.x);
  let key = cell * 3u + u32(p.w + 0.5);
  keyOf[i] = key;
  rankOf[i] = atomicAdd(&cellCount[key], 1u);
}

@compute @workgroup_size(1)
fn scanCells() {
  let keys = u32(P.grid.y * P.grid.z * P.grid.w) * 3u;
  var sum = 0u;
  for (var k = 0u; k < keys; k++) {
    cellStart[k] = sum;
    sum += atomicLoad(&cellCount[k]);
  }
  cellStart[keys] = sum;
}

@compute @workgroup_size(64)
fn scatter(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= u32(P.a.z)) { return; }
  let dst = cellStart[keyOf[i]] + rankOf[i];
  spos[dst] = pos[i];
  svel[dst] = vel[i];
}

@compute @workgroup_size(64)
fn steerGrid(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= u32(P.a.z)) { return; }
  let m = loadMe(i);
  var acc: Acc;

  let cs = P.grid.x;
  let half = P.bounds.xyz;
  let dims = gridDims();
  var r = i32(ceil(m.scanR / cs));
  let wrap = wrapOn();
  let c0 = select(cellOfPos(m.pos), rawCell(m.pos), wrap);
  var lo = max(c0 - vec3i(r), vec3i(0));
  var hi = min(c0 + vec3i(r), dims - vec3i(1));
  if (wrap) {
    // x and z walk unclamped cell coordinates and wrap into the grid below;
    // keep the span under the grid width so no cell is visited twice
    r = min(r, (min(dims.x, dims.z) - 1) / 2);
    lo.x = c0.x - r; hi.x = c0.x + r;
    lo.z = c0.z - r; hi.z = c0.z + r;
  }
  let cap = max(u32(P.a.w), 1u);
  let h = pcg(i ^ u32(P.a.y * 997.0));
  let scanR2 = m.scanR * m.scanR;

  for (var z = lo.z; z <= hi.z; z++) {
    for (var y = lo.y; y <= hi.y; y++) {
      for (var x = lo.x; x <= hi.x; x++) {
        // skip cells whose box is entirely outside the scan sphere (x and z are unwrapped here,
        // so compare against my own position, shifted into the same image)
        var myp = m.pos;
        if (wrap) {
          let full = half * 2.0;
          myp.x -= full.x * floor((m.pos.x + half.x) / full.x);
          myp.z -= full.z * floor((m.pos.z + half.z) / full.z);
        }
        let cmin = vec3f(f32(x), f32(y), f32(z)) * cs - half;
        let dd = max(max(cmin - myp, myp - (cmin + vec3f(cs))), vec3f(0.0));
        if (dot(dd, dd) > scanR2) { continue; }

        let cx = select(x, wrapIdx(x, dims.x), wrap);
        let cz = select(z, wrapIdx(z, dims.z), wrap);
        let cell = u32((cz * dims.y + y) * dims.x + cx);
        for (var s = 0u; s < 3u; s++) {
          let key = cell * 3u + s;
          let start = cellStart[key];
          let cnt = cellStart[key + 1u] - start;
          if (cnt == 0u) { continue; }
          let n = min(cnt, cap);
          let off = h % cnt;
          let sc = f32(cnt) / f32(n);
          for (var k = 0u; k < n; k++) {
            let j = start + (off + k) % cnt;
            consider(&acc, m, spos[j], svel[j].xyz, sc);
          }
        }
      }
    }
  }
  integrate(i, m, acc);
}
