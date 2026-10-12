// Steering pass. Brute force O(N^2): every fish scans every texel.
// textureVelocity / texturePosition samplers and `resolution` are injected by GPUComputationRenderer.
uniform float uDelta;
uniform float uTime;
uniform vec3 uBounds;      // tank half extents
uniform float uBoundMargin;

uniform float uMaxSpeed[3];
uniform float uMaxForce[3];
uniform float uSepRadius[3];
uniform float uAliRadius[3];
uniform float uCohRadius[3];
uniform float uSepWeight[3];
uniform float uAliWeight[3];
uniform float uCohWeight[3];
uniform float uFearRadius[3];
uniform float uFearWeight[3];
uniform float uHuntRadius[3];
uniform float uHuntWeight[3];
uniform float uWander[3];
uniform float uScale[3];

const float TAU = 6.28318530718;

vec3 limitVec(vec3 v, float m) {
  float l = length(v);
  return l > m ? v * (m / l) : v;
}

// Reynolds: desired = normalize(dir) * maxSpeed, steer = desired - velocity, clamped to maxForce.
vec3 steer(vec3 dir, vec3 vel, float maxSpeed, float maxForce) {
  float l = length(dir);
  if (l < 1e-6) return vec3(0.0);
  return limitVec(dir * (maxSpeed / l) - vel, maxForce);
}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  ivec2 me = ivec2(gl_FragCoord.xy);
  vec4 pw = texture2D(texturePosition, uv);
  vec4 vw = texture2D(textureVelocity, uv);
  vec3 pos = pw.xyz;
  vec3 vel = vw.xyz;
  int sp = int(pw.w + 0.5);

  float maxSpeed = uMaxSpeed[sp];
  float maxForce = uMaxForce[sp];
  float sepR = uSepRadius[sp];
  float aliR = uAliRadius[sp];
  float cohR = uCohRadius[sp];
  float fearR = uFearRadius[sp];
  float huntR = uHuntRadius[sp];
  float scanR = max(max(max(sepR, aliR), max(cohR, fearR)), huntR);
  float scanR2 = scanR * scanR;

  vec3 sepSum = vec3(0.0);
  vec3 aliSum = vec3(0.0);
  vec3 cohSum = vec3(0.0);
  vec3 fearSum = vec3(0.0);
  vec3 huntSum = vec3(0.0);
  float aliN = 0.0, cohN = 0.0, huntN = 0.0;

  int W = int(resolution.x);
  int H = int(resolution.y);
  for (int y = 0; y < H; y++) {
    for (int x = 0; x < W; x++) {
      vec4 ow = texelFetch(texturePosition, ivec2(x, y), 0);
      vec3 d = pos - ow.xyz;
      float d2 = dot(d, d);
      if (d2 > scanR2 || d2 < 1e-8) continue;
      float dist = sqrt(d2);
      int osp = int(ow.w + 0.5);

      // separation applies to every neighbor
      if (dist < sepR) sepSum += d / d2;

      if (osp == sp) {
        // alignment / cohesion only within the same species
        if (dist < aliR) {
          aliSum += texelFetch(textureVelocity, ivec2(x, y), 0).xyz;
          aliN += 1.0;
        }
        if (dist < cohR) {
          cohSum += ow.xyz;
          cohN += 1.0;
        }
      } else if (osp > sp) {
        if (dist < fearR) fearSum += (d / dist) * (1.0 - dist / fearR);
      } else {
        if (dist < huntR) {
          huntSum += ow.xyz;
          huntN += 1.0;
        }
      }
    }
  }

  vec3 force = vec3(0.0);
  force += steer(sepSum, vel, maxSpeed, maxForce) * uSepWeight[sp];
  if (aliN > 0.0) force += steer(aliSum / aliN, vel, maxSpeed, maxForce) * uAliWeight[sp];
  if (cohN > 0.0) force += steer(cohSum / cohN - pos, vel, maxSpeed, maxForce) * uCohWeight[sp];
  force += steer(fearSum, vel, maxSpeed * 1.3, maxForce * 2.0) * uFearWeight[sp];
  if (huntN > 0.0) force += steer(huntSum / huntN - pos, vel, maxSpeed, maxForce) * uHuntWeight[sp];

  // lazy wander, per-fish phase offset
  float id = uv.x * 131.0 + uv.y * 977.0;
  vec3 wd = vec3(
    sin(uTime * 0.40 + id * 6.1),
    sin(uTime * 0.31 + id * 3.7),
    cos(uTime * 0.27 + id * 9.3)
  );
  force += wd * maxForce * uWander[sp];

  // soft tank walls: push back in proportionally to how far past the margin we are
  vec3 inner = uBounds - vec3(uBoundMargin);
  vec3 over = (abs(pos) - inner) / uBoundMargin;
  force -= sign(pos) * clamp(over, 0.0, 2.0) * maxForce * 2.0;

  vel += force * uDelta;

  float speed = length(vel);
  if (speed < 1e-4) { vel = vec3(1.0, 0.0, 0.0) * maxSpeed * 0.5; speed = length(vel); }
  vel *= clamp(speed, maxSpeed * 0.4, maxSpeed) / speed;
  speed = length(vel);

  // swim phase drives the tail wiggle: faster speed (relative to body length) -> faster beat
  float phase = mod(vw.w + uDelta * (3.0 + speed * 1.2 / uScale[sp]), TAU);

  gl_FragColor = vec4(vel, phase);
}
