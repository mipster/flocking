uniform vec3 uLightDir;
uniform vec3 uFogColor;
uniform float uFogDensity;

varying vec3 vNormalW;
varying vec3 vColor;
varying float vDepth;
varying float vLocalY;

void main() {
  vec3 n = normalize(vNormalW);
  if (!gl_FrontFacing) n = -n;

  float lambert = max(dot(n, uLightDir), 0.0);
  float hemi = n.y * 0.5 + 0.5;
  vec3 col = vColor * (0.3 + 0.4 * hemi + 0.55 * lambert);
  // countershading: lighter belly
  col = mix(col, col * 1.25 + 0.04, smoothstep(0.0, -0.15, vLocalY));

  float f = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
  gl_FragColor = vec4(mix(col, uFogColor, clamp(f, 0.0, 1.0)), 1.0);
}
