// WebGPU boids. Two neighbor strategies share the same steering code:
//   steerBrute: every fish tests every fish (tiled through workgroup memory)
//   steerGrid : counting sort into (cell, species) buckets, then only nearby cells are scanned,
//               with at most `maxPerCell` samples taken from each bucket.

struct Params {
  a: vec4f,      // delta, time, count, maxPerCell
  bounds: vec4f, // tank half extents xyz, wall margin
  grid: vec4f,   // cellSize, nx, ny, nz
  flags: vec4f,  // x = wrap left/right (1) or soft side walls (0), y = steering blend per step (1 = no smoothing)
};

fn wrapOn() -> bool { return P.flags.x > 0.5; }

// The left/right edges are periodic when wrapping; z and y never are. Every wrap rule goes
// through these two helpers.
fn wrapPosition(p: vec3f) -> vec3f {
  var q = p;
  if (wrapOn()) {
    let fullX = P.bounds.x * 2.0;
    q.x -= fullX * floor((q.x + P.bounds.x) / fullX);
  }
  return q;
}

// shortest offset between two positions, across the seam if that is closer
fn minImage(d: vec3f) -> vec3f {
  var q = d;
  if (wrapOn()) {
    let fullX = P.bounds.x * 2.0;
    q.x -= fullX * round(q.x / fullX);
  }
  return q;
}

@group(0) @binding(0) var<uniform> P: Params;
// per species, 4 x vec4: [maxSpeed, maxForce, sepR, aliR] [cohR, sepW, aliW, cohW]
//                        [fearR, fearW, huntR, huntW]     [wander, scale, 0, 0]
@group(0) @binding(1) var<uniform> SPEC: array<vec4f, SPECIES_COUNT * 4u>;
@group(0) @binding(2) var<storage, read_write> pos: array<vec4f>;   // xyz, species
@group(0) @binding(3) var<storage, read_write> vel: array<vec4f>;   // xyz, swim phase
@group(0) @binding(4) var<storage, read_write> spos: array<vec4f>;  // snapshot (cell sorted in grid mode)
@group(0) @binding(5) var<storage, read_write> svel: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> cellCount: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read_write> cellStart: array<u32>;
@group(0) @binding(8) var<storage, read_write> keyRank: array<vec2u>; // per fish: (bucket key, rank in bucket)
@group(0) @binding(9) var<storage, read_write> smoothAccel: array<vec4f>; // low-passed steering force

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
  let d = minImage(m.pos - ow.xyz);
  let opos = m.pos - d;
  let d2 = dot(d, d);
  if (d2 > m.scanR * m.scanR || d2 < 1e-8) { return; }
  let dist = sqrt(d2);
  let osp = u32(ow.w + 0.5);

  // push away with strength that grows as the neighbor gets closer (0 at the radius edge),
  // so crossing the boundary is a smooth change instead of an on/off kick
  if (dist < m.sepR) { (*acc).sep += (d / dist) * (1.0 - dist / m.sepR) * sepScale; }

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

// Repulsion: magnitude follows the proximity-weighted sum (saturating at maxForce), not a
// full-strength steer toward a normalised direction, so it fades in and out smoothly.
fn pushAway(v: vec3f, maxForce: f32) -> vec3f {
  let l = length(v);
  return select(v, v / l, l > 1.0) * maxForce;
}

fn integrate(i: u32, m: Me, a: Acc) {
  let dt = P.a.x;
  let t = P.a.y;
  let s1 = SPEC[m.sp * 4u + 1u];
  let s2 = SPEC[m.sp * 4u + 2u];
  let s3 = SPEC[m.sp * 4u + 3u];

  var force = pushAway(a.sep, m.maxForce) * s1.y;
  if (a.aliN > 0.0) { force += steer(a.ali / a.aliN, m.vel, m.maxSpeed, m.maxForce) * s1.z; }
  if (a.cohN > 0.0) { force += steer(a.coh / a.cohN - m.pos, m.vel, m.maxSpeed, m.maxForce) * s1.w; }
  force += pushAway(a.fear, m.maxForce * 2.0) * s2.y;
  if (a.huntN > 0.0) { force += steer(a.hunt / a.huntN - m.pos, m.vel, m.maxSpeed, m.maxForce) * s2.w; }

  // lazy wander with a per-fish phase offset
  let id = fract(f32(i) * 0.6180339887) * 100.0;
  let wd = vec3f(sin(t * 0.40 + id * 6.1), sin(t * 0.31 + id * 3.7), cos(t * 0.27 + id * 9.3));
  force += wd * m.maxForce * s3.x;

  // Low-pass the flocking force. Dense flocks sample neighbors stochastically and jostle, so the
  // raw force fluctuates frame to frame; smoothing keeps headings from twitching. Barrier forces
  // below are added afterwards so walls and the floor still react instantly.
  let alpha = P.flags.y;
  if (alpha < 1.0) {
    force = mix(smoothAccel[i].xyz, force, alpha);
    smoothAccel[i] = vec4f(force, 0.0);
  }

  // soft tank walls
  let margin = P.bounds.w;
  let inner = P.bounds.xyz - vec3f(margin);
  var over = (abs(m.pos) - inner) / margin;
  if (wrapOn()) { over.x = 0.0; }   // left/right edges are open when wrapping
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
  var np = wrapPosition(m.pos + v * dt);
  let h = P.bounds.xyz;
  if (!wrapOn() && abs(np.x) > h.x) {
    np.x = sign(np.x) * h.x;
    v.x = 0.0;
  }
  // near and far walls, the sea floor and the surface are barriers in both modes; the clearance
  // scales with body size so big fish don't clip into the sand or poke their fin out of the water
  if (abs(np.z) > h.z) { np.z = sign(np.z) * h.z; v.z = 0.0; }
  let yMin = floorY(np.xz, h) + CLEARANCE_BASE + CLEARANCE_BELLY * m.scale;
  let yMax = h.y - CLEARANCE_BASE - CLEARANCE_FIN * m.scale;
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
  return clamp(rawCell(wrapPosition(p)), vec3i(0), d - vec3i(1));
}

// ---- brute force -----------------------------------------------------------

@compute @workgroup_size(WORKGROUP_SIZE)
fn snapshot(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= u32(P.a.z)) { return; }
  spos[i] = pos[i];
  svel[i] = vel[i];
}

var<workgroup> tp: array<vec4f, WORKGROUP_SIZE>;
var<workgroup> tv: array<vec4f, WORKGROUP_SIZE>;

@compute @workgroup_size(WORKGROUP_SIZE)
fn steerBrute(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) lid: u32) {
  let n = u32(P.a.z);
  let i = gid.x;
  let valid = i < n;
  var m: Me;
  if (valid) { m = loadMe(i); }
  var acc: Acc;
  let tiles = (n + WORKGROUP_SIZE - 1u) / WORKGROUP_SIZE;
  for (var t = 0u; t < tiles; t++) {
    let j = t * WORKGROUP_SIZE + lid;
    if (j < n) {
      tp[lid] = spos[j];
      tv[lid] = svel[j];
    } else {
      tp[lid] = vec4f(0.0, 0.0, 0.0, -1.0);
      tv[lid] = vec4f(0.0);
    }
    workgroupBarrier();
    if (valid) {
      for (var k = 0u; k < WORKGROUP_SIZE; k++) {
        consider(&acc, m, tp[k], tv[k].xyz, 1.0);
      }
    }
    workgroupBarrier();
  }
  if (valid) { integrate(i, m, acc); }
}

// ---- spatial grid ----------------------------------------------------------

@compute @workgroup_size(WORKGROUP_SIZE)
fn clearCells(@builtin(global_invocation_id) gid: vec3u) {
  let keys = u32(P.grid.y * P.grid.z * P.grid.w) * SPECIES_COUNT;
  if (gid.x < keys) { atomicStore(&cellCount[gid.x], 0u); }
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn countCells(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= u32(P.a.z)) { return; }
  let p = pos[i];
  let c = cellOfPos(p.xyz);
  let d = gridDims();
  let cell = u32((c.z * d.y + c.y) * d.x + c.x);
  let key = cell * SPECIES_COUNT + u32(p.w + 0.5);
  keyRank[i] = vec2u(key, atomicAdd(&cellCount[key], 1u));
}

@compute @workgroup_size(1)
fn scanCells() {
  let keys = u32(P.grid.y * P.grid.z * P.grid.w) * SPECIES_COUNT;
  var sum = 0u;
  for (var k = 0u; k < keys; k++) {
    cellStart[k] = sum;
    sum += atomicLoad(&cellCount[k]);
  }
  cellStart[keys] = sum;
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn scatter(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= u32(P.a.z)) { return; }
  let kr = keyRank[i];
  let dst = cellStart[kr.x] + kr.y;
  spos[dst] = pos[i];
  svel[dst] = vel[i];
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn steerGrid(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= u32(P.a.z)) { return; }
  let m = loadMe(i);
  var acc: Acc;

  let cs = P.grid.x;
  let half = P.bounds.xyz;
  let dims = gridDims();
  let r = i32(ceil(m.scanR / cs));
  let wrap = wrapOn();
  let myp = wrapPosition(m.pos); // my position in the canonical image
  let c0 = cellOfPos(myp);
  var lo = max(c0 - vec3i(r), vec3i(0));
  var hi = min(c0 + vec3i(r), dims - vec3i(1));
  if (wrap) {
    // x walks unclamped cell coordinates and wraps into the grid below; keep the span under
    // the grid width so no cell is visited twice
    let rx = min(r, (dims.x - 1) / 2);
    lo.x = c0.x - rx;
    hi.x = c0.x + rx;
  }
  let cap = max(u32(P.a.w), 1u);
  let h = pcg(i ^ u32(P.a.y * 997.0));
  let scanR2 = m.scanR * m.scanR;

  for (var z = lo.z; z <= hi.z; z++) {
    for (var y = lo.y; y <= hi.y; y++) {
      for (var x = lo.x; x <= hi.x; x++) {
        // skip cells whose box is entirely outside the scan sphere (x is unwrapped here, so
        // compare against my own canonical position)
        let cmin = vec3f(f32(x), f32(y), f32(z)) * cs - half;
        let dd = max(max(cmin - myp, myp - (cmin + vec3f(cs))), vec3f(0.0));
        if (dot(dd, dd) > scanR2) { continue; }

        let cx = select(x, wrapIdx(x, dims.x), wrap);
        let cell = u32((z * dims.y + y) * dims.x + cx);
        for (var s = 0u; s < SPECIES_COUNT; s++) {
          let key = cell * SPECIES_COUNT + s;
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
