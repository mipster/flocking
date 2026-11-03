// WebGPU boids. Two neighbor strategies share the same steering code:
//   steerBrute: every fish tests every fish (tiled through workgroup memory)
//   steerGrid : counting sort into (cell, species) buckets, then only nearby cells are scanned,
//               with at most `maxPerCell` samples taken from each bucket.

struct Params {
  a: vec4f,      // delta, time, count, maxPerCell
  bounds: vec4f, // tank half extents xyz, wall margin
  grid: vec4f,   // cellSize, nx, ny, nz
  flags: vec4f,  // x = wrap left/right (1) or soft side walls (0), y = steering blend per step (1 = no smoothing),
                 // z = minimum speed as a fraction of maxSpeed, w = fear weight of the external predator
  home: vec4f,       // centre xyz of a soft region the flock is pulled back into, w = pull strength (0 = off)
  homeRadius: vec4f, // ellipsoid radii of that region xyz, w = 1: roost mode (see integrate)
  predator: vec4f,   // external predator position xyz (not part of the flock), w = fear radius (0 = none)
  flight: vec4f,     // banked bird flight: x = on, y = speed blend per step, z = cruise speed fraction,
                     // w = level-flight pull (1/s); see integrate()
  predatorVel: vec4f, // predator velocity xyz, w = how many seconds ahead animals judge its path
  ground: vec4f,      // x = flat ground height, y = 1: use it instead of the sea floor
};

// height of whatever the animals must stay above: the sea floor, or flat ground (the starlings' lake)
fn groundY(xz: vec2f) -> f32 {
  return select(floorY(xz, P.bounds.xyz), P.ground.x, P.ground.y > 0.5);
}

fn flying() -> bool { return P.flight.x > 0.5; }

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
//                        [fearR, fearW, huntR, huntW]     [wander, scale, farCohesion, neighbours]
@group(0) @binding(1) var<uniform> SPEC: array<vec4f, SPECIES_COUNT * 4u>;
@group(0) @binding(2) var<storage, read_write> pos: array<vec4f>;   // xyz, species
@group(0) @binding(3) var<storage, read_write> vel: array<vec4f>;   // xyz, swim phase
@group(0) @binding(4) var<storage, read_write> spos: array<vec4f>;  // snapshot (cell sorted in grid mode)
@group(0) @binding(5) var<storage, read_write> svel: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> cellCount: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read_write> cellStart: array<u32>;
@group(0) @binding(8) var<storage, read_write> keyRank: array<vec2u>; // per fish: (bucket key, rank in bucket)
// per animal steering state: xyz = low-passed steering force (the current turn in banked flight),
// w = its topological neighbour radius (0 until first set, unused when `neighbours` is 0)
@group(0) @binding(9) var<storage, read_write> smoothAccel: array<vec4f>;

const TAU = 6.28318530718;

struct Me {
  pos: vec3f, vel: vec3f, phase: f32, sp: u32,
  maxSpeed: f32, maxForce: f32, sepR: f32, aliR: f32, cohR: f32,
  fearR: f32, huntR: f32, scanR: f32, scale: f32,
  topoR: f32, // topological radius: alignment and cohesion reach no further (0 = metric radii only)
  reach: f32, // the longest topoR may grow to: the species' alignment/cohesion radii
};

struct Acc {
  sep: vec3f, ali: vec3f, coh: vec3f, fear: vec3f, hunt: vec3f,
  aliN: f32, cohN: f32, huntN: f32,
  far: vec3f, // density imbalance around me, 0..1 in length (grid mode only)
  topoN: f32, // estimated number of my kind within topoR (samples weighted by how many they stand for)
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
  if (s3.w > 0.0) {
    // topological: the species radii become the longest reach; a fresh animal starts there
    m.reach = max(m.aliR, m.cohR);
    let r = smoothAccel[i].w;
    m.topoR = clamp(select(m.reach, r, r > 0.0), m.sepR, m.reach);
    m.aliR = min(m.aliR, m.topoR);
    m.cohR = min(m.cohR, m.topoR);
  }
  m.scanR = max(max(max(m.sepR, m.aliR), max(m.cohR, m.fearR)), max(m.huntR, m.topoR));
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
    if (dist < m.topoR) { (*acc).topoN += sepScale; }
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

// External predator (driven from the CPU). Animals judge where it will pass closest to them within
// the next predatorVel.w seconds and flee sideways out of that path, so a gap opens ahead of it;
// the rest of the flock picks the dodge up through alignment, which sends a wave through it.
fn predatorEscape(m: Me) -> vec3f {
  let radius = P.predator.w;
  if (radius <= 0.0) { return vec3f(0.0); }
  let d = m.pos - P.predator.xyz;
  let u = P.predatorVel.xyz;
  let look = P.predatorVel.w;
  let uu = dot(u, u);
  let t = select(0.0, clamp(dot(d, u) / max(uu, 1e-6), 0.0, look), uu > 0.0 && look > 0.0);
  let off = d - u * t;
  let miss = length(off);
  if (miss >= radius || miss < 1e-4) { return vec3f(0.0); }
  let soon = select(1.0, 1.0 - t / look, look > 0.0);
  return (off / miss) * (1.0 - miss / radius) * soon * m.maxForce * P.flags.w;
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

  // far cohesion: head for the fuller side when the flock around me is lopsided
  if (s3.z > 0.0) { force += steer(a.far, m.vel, m.maxSpeed, m.maxForce) * length(a.far) * s3.z; }

  // lazy wander with a per-fish phase offset
  let id = fract(f32(i) * 0.6180339887) * 100.0;
  let wd = vec3f(sin(t * 0.40 + id * 6.1), sin(t * 0.31 + id * 3.7), cos(t * 0.27 + id * 9.3));
  force += wd * m.maxForce * s3.x;

  // pull from outside the flock: the home region
  var pull = vec3f(0.0);
  if (P.home.w > 0.0) {
    let q = (m.pos - P.home.xyz) / P.homeRadius.xyz;
    if (P.homeRadius.w > 0.5) {
      // roost: always draw birds horizontally toward the roost, full strength at the edge, so
      // with banked flight they circle it; height is only corrected from outside
      let toward = vec3f(P.home.x - m.pos.x, 0.0, P.home.z - m.pos.z);
      pull += steer(toward, m.vel, m.maxSpeed, m.maxForce) * min(length(q.xz), 1.0) * P.home.w;
      let above = abs(q.y) - 1.0;
      if (above > 0.0) {
        let up = vec3f(0.0, P.home.y - m.pos.y, 0.0);
        pull += steer(up, m.vel, m.maxSpeed, m.maxForce) * min(above, 1.0) * P.home.w;
      }
    } else {
      // inside the ellipsoid the flock roams freely; outside, the pull back grows with
      // distance, so the edge of the flock bulges and folds instead of hitting a wall
      let outside = length(q) - 1.0;
      if (outside > 0.0) {
        pull += steer(P.home.xyz - m.pos, m.vel, m.maxSpeed, m.maxForce) * min(outside, 1.0) * P.home.w;
      }
    }
  }
  let escape = predatorEscape(m);

  // Low-pass blend per step. Dense flocks sample neighbours stochastically and jostle, so the raw
  // force fluctuates frame to frame; smoothing keeps headings from twitching.
  let alpha = P.flags.y;
  var state = smoothAccel[i].xyz;
  if (flying()) {
    // Banked flight: a bird can't stop or sidestep. Every steer, the pulls included, becomes a
    // turn (the part across the heading), capped at maxForce; the low-pass is the time it takes to
    // roll into it. Speed is not steered but eases back to cruise, and vertical speed is damped so
    // the flock flies flat. Together these make wide sweeping turns and loops round the roost.
    let speed = max(length(m.vel), 1e-4);
    let h = m.vel / speed;
    force += pull;
    force.y -= m.vel.y * P.flight.w;
    var turn = force - h * dot(force, h);
    let tl = length(turn);
    turn = select(turn, turn * (m.maxForce / tl), tl > m.maxForce);
    state = mix(state, turn, alpha);
    state -= h * dot(state, h);
    force = state + h * ((P.flight.z * m.maxSpeed - speed) * P.flight.y / dt);
    // panic skips the roll-in: the dodge turns at once and may also speed the bird up
    force += escape - h * min(dot(escape, h), 0.0);
  } else {
    // fish: the pulls are added after the low-pass so the home region and a predator act at once
    if (alpha < 1.0) {
      force = mix(state, force, alpha);
      state = force;
    }
    force += pull + escape;
  }

  // topological radius: scale toward the radius that would hold `neighbours` of my kind (the count
  // grows with the cube of the radius), within [sepR, longest reach]
  var topoR = 0.0;
  if (s3.w > 0.0) {
    let k = 1.0 - exp(-dt / TOPO_ADAPT_TIME);
    let ratio = s3.w / max(a.topoN, 0.5);
    topoR = clamp(m.topoR * pow(ratio, k / 3.0), m.sepR, m.reach);
  }
  smoothAccel[i] = vec4f(state, topoR);

  // soft tank walls
  let margin = P.bounds.w;
  let inner = P.bounds.xyz - vec3f(margin);
  var over = (abs(m.pos) - inner) / margin;
  if (wrapOn()) { over.x = 0.0; }   // left/right edges are open when wrapping
  over.y = max(0.0, (m.pos.y - inner.y) / margin);   // top only; the bottom is the sea floor
  force -= sign(m.pos) * clamp(over, vec3f(0.0), vec3f(2.0)) * m.maxForce * 2.0;

  // sea floor: push up as the fish gets within `margin` of the sand
  let clearance = m.pos.y - groundY(m.pos.xz);
  force.y += clamp((margin - clearance) / margin, 0.0, 2.0) * m.maxForce * 2.0;

  var v = m.vel + force * dt;
  var speed = length(v);
  if (speed < 1e-4) { v = vec3f(1.0, 0.0, 0.0) * m.maxSpeed * 0.5; speed = length(v); }
  v = v * (clamp(speed, m.maxSpeed * P.flags.z, m.maxSpeed) / speed);
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
  let yMin = groundY(np.xz) + CLEARANCE_BASE + CLEARANCE_BELLY * m.scale;
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

// Exclusive prefix sum of the bucket counts in one workgroup: each thread sums its own contiguous
// run of keys, thread 0 scans those SCAN_THREADS totals, then every thread writes its run's starts.
var<workgroup> runTotal: array<u32, SCAN_THREADS>;

@compute @workgroup_size(SCAN_THREADS)
fn scanCells(@builtin(local_invocation_index) lid: u32) {
  let keys = u32(P.grid.y * P.grid.z * P.grid.w) * SPECIES_COUNT;
  let run = (keys + SCAN_THREADS - 1u) / SCAN_THREADS;
  let first = min(lid * run, keys);
  let last = min(first + run, keys);
  var sum = 0u;
  for (var k = first; k < last; k++) { sum += atomicLoad(&cellCount[k]); }
  runTotal[lid] = sum;
  workgroupBarrier();
  if (lid == 0u) {
    var total = 0u;
    for (var t = 0u; t < SCAN_THREADS; t++) {
      let n = runTotal[t];
      runTotal[t] = total;
      total += n;
    }
    cellStart[keys] = total;
  }
  workgroupBarrier();
  var start = runTotal[lid];
  for (var k = first; k < last; k++) {
    cellStart[k] = start;
    start += atomicLoad(&cellCount[k]);
  }
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

  // far cohesion: count my own kind in the 26 cells about FAR_COHESION_DISTANCE away and point
  // toward the fuller side, scaled by how lopsided it is (inside a flock the counts balance out)
  if (SPEC[m.sp * 4u + 3u].z > 0.0) {
    let farCells = max(i32(round(FAR_COHESION_DISTANCE / cs)), 1);
    var g = vec3f(0.0);
    var total = 0.0;
    for (var dz = -1; dz <= 1; dz++) {
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          if (dx == 0 && dy == 0 && dz == 0) { continue; }
          let dir = vec3i(dx, dy, dz);
          var cc = c0 + dir * farCells;
          if (wrap) { cc.x = wrapIdx(cc.x, dims.x); }
          if (any(cc < vec3i(0)) || any(cc >= dims)) { continue; }
          let key = u32((cc.z * dims.y + cc.y) * dims.x + cc.x) * SPECIES_COUNT + m.sp;
          let n = f32(cellStart[key + 1u] - cellStart[key]);
          g += normalize(vec3f(dir)) * n;
          total += n;
        }
      }
    }
    if (total > 0.0) { acc.far = g / total; }
  }
  integrate(i, m, acc);
}
