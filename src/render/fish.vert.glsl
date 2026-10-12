uniform sampler2D uTexPos;
uniform sampler2D uTexVel;
uniform float uScale[3];
uniform vec3 uColor[3];
uniform float uTailAmp;
uniform float uTailK;

attribute vec2 aRef;

varying vec3 vNormalW;
varying vec3 vColor;
varying float vDepth;
varying float vLocalY;

void main() {
  vec4 pw = texture2D(uTexPos, aRef);
  vec4 vw = texture2D(uTexVel, aRef);
  int sp = int(pw.w + 0.5);

  // orientation basis: x = forward (velocity), y = up (stabilised vs world up), z = side
  vec3 fwd = normalize(vw.xyz + vec3(1e-5));
  vec3 worldUp = abs(fwd.y) > 0.98 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 side = normalize(cross(fwd, worldUp));
  vec3 up = cross(side, fwd);

  // tail wiggle: weight grows toward the tail (local x < 0)
  vec3 l = position;
  float w = clamp((0.1 - l.x) / 0.7, 0.0, 1.0);
  l.z += sin(vw.w - l.x * uTailK) * uTailAmp * w * w;

  vec3 world = pw.xyz + (fwd * l.x + up * l.y + side * l.z) * uScale[sp];
  vNormalW = fwd * normal.x + up * normal.y + side * normal.z;

  // slight per-fish tint variation
  float h = fract(sin(dot(aRef, vec2(12.9898, 78.233))) * 43758.5453);
  vColor = uColor[sp] * (0.85 + 0.3 * h);
  vLocalY = position.y;

  vec4 mv = viewMatrix * vec4(world, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
