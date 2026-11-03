// Running average of each bird's velocity. The bird shader reads how far the current velocity has
// swung away from it as a smoothed turn rate, which sets the bank angle; using the raw change per
// step instead would make every bird flicker with the jostle of the flock.

struct BankParams {
  a: vec4f, // x = blend toward the current velocity this step, y = bird count
};

@group(0) @binding(0) var<uniform> B: BankParams;
@group(0) @binding(1) var<storage, read> vel: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> avgVel: array<vec4f>;

@compute @workgroup_size(WORKGROUP_SIZE)
fn trackVelocity(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= u32(B.a.y)) { return; }
  avgVel[i] = mix(avgVel[i], vel[i], B.a.x);
}
