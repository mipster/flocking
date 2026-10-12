uniform float uDelta;

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 pw = texture2D(texturePosition, uv);
  vec3 vel = texture2D(textureVelocity, uv).xyz;
  gl_FragColor = vec4(pw.xyz + vel * uDelta, pw.w);
}
