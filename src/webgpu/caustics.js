// WGSL for sunlight focused by the wave surface, shared by the render shaders (sand, fish
// lighting) and the simulation (per-fish light, evaluated once per fish rather than per vertex).
// Needs the constants from wgslHeader().

export const causticsWGSL = /* wgsl */ `
// Phase of wave \`i\` at rest position \`xz\`; shared by the displacement, normal and caustics.
fn wavePhase(i: u32, xz: vec2f, t: f32) -> f32 {
  let w = WAVES[i];
  return w.w * dot(w.xy, xz) - WAVE_DYNAMICS[i].x * t;
}

// Relative sunlight focus at horizontal position \`xz\`, \`depth\` below the surface. The wave
// surface acts as a lens: a sun ray entering at p lands at p + depth * (travel + bend * slope(p)),
// and the light at the landing point is inversely proportional to how much that map stretches
// area, 1 / |det(I + bend * depth * Hessian(height))|, which blows up along caustic lines.
fn causticFocus(xz: vec2f, depth: f32, t: f32) -> f32 {
  // entry point if the surface were flat, then refined once with the slope of the mesh waves
  // (the ripples are too small to move the entry point noticeably)
  var p = xz - SUN_TRAVEL * depth;
  var slope = vec2f(0.0);
  for (var i = 0u; i < WAVE_MESH_COUNT; i++) {
    let w = WAVES[i];
    slope += w.xy * (w.z * w.w * cos(wavePhase(i, p, t)));
  }
  p -= CAUSTIC_BEND * depth * slope;

  var hxx = 0.0;
  var hxz = 0.0;
  var hzz = 0.0;
  for (var i = 0u; i < WAVE_COUNT; i++) {
    let w = WAVES[i];
    let a = w.z * w.w * w.w * sin(wavePhase(i, p, t));
    hxx -= a * w.x * w.x;
    hxz -= a * w.x * w.y;
    hzz -= a * w.y * w.y;
  }
  let b = CAUSTIC_BEND * depth;
  let det = (1.0 + b * hxx) * (1.0 + b * hzz) - b * b * hxz * hxz;
  let focus = 1.0 / max(abs(det), CAUSTIC_MIN_DET);
  // contrast washes out with depth
  return mix(1.0, focus, exp(-depth * CAUSTIC_FADE));
}

// multiplier for sunlight at \`xz\`, \`depth\` below the surface
fn causticLight(xz: vec2f, depth: f32, t: f32) -> f32 {
  return CAUSTIC_BASE + CAUSTIC_GAIN * causticFocus(xz, depth, t);
}
`;
