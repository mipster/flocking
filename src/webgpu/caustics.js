// WGSL for sunlight focused by the wave surface, shared by the render shaders (sand, per-fish
// lighting, light shafts). Needs the constants from wgslHeader() and the render uniform `R`.

export const causticsWGSL = /* wgsl */ `
// Wave \`i\` as the viewer's wave sliders (R.waves: height, wavenumber scale) leave it:
// [dirX, dirZ, amplitude, wavenumber].
fn waveShape(i: u32) -> vec4f {
  let w = WAVES[i];
  return vec4f(w.xy, w.z * R.waves.x, w.w * R.waves.y);
}

// Horizontal steepness of wave \`i\`. Dividing out the height and scale factors keeps
// steepness * wavenumber * amplitude constant, so crests never loop however the sliders are set.
fn waveSteepness(i: u32) -> f32 {
  return WAVE_DYNAMICS[i].y / (R.waves.x * R.waves.y);
}

// Phase of wave \`i\` at rest position \`xz\`; shared by the displacement, normal and caustics.
// \`t\` is the wave clock (R.waves.w), which already includes the speed slider. Deep-water waves
// travel at sqrt(g / k), so a larger wavenumber scale slows them accordingly.
fn wavePhase(i: u32, xz: vec2f, t: f32) -> f32 {
  let w = waveShape(i);
  return w.w * dot(w.xy, xz) - WAVE_DYNAMICS[i].x * sqrt(R.waves.y) * t;
}

// How much the wave surface stretches sunlight that entered at \`p\` and travelled \`depth\`
// further, summing the first \`waves\` waves: 1 / |det(I + bend * depth * Hessian(height))|.
// Above 1 the light is focused, and it blows up along caustic lines.
fn waveFocus(p: vec2f, depth: f32, t: f32, waves: u32) -> f32 {
  var hxx = 0.0;
  var hxz = 0.0;
  var hzz = 0.0;
  for (var i = 0u; i < waves; i++) {
    let w = waveShape(i);
    let a = w.z * w.w * w.w * sin(wavePhase(i, p, t));
    hxx -= a * w.x * w.x;
    hxz -= a * w.x * w.y;
    hzz -= a * w.y * w.y;
  }
  let b = CAUSTIC_BEND * depth;
  let det = (1.0 + b * hxx) * (1.0 + b * hzz) - b * b * hxz * hxz;
  return 1.0 / max(abs(det), CAUSTIC_MIN_DET);
}

// Relative sunlight focus at horizontal position \`xz\`, \`depth\` below the surface. The wave
// surface acts as a lens: a sun ray entering at p lands at p + depth * (travel + bend * slope(p)),
// and the light at the landing point follows the area stretch of that map (see waveFocus).
fn causticFocus(xz: vec2f, depth: f32, t: f32) -> f32 {
  // entry point if the surface were flat, then refined once with the slope of the mesh waves
  // (the ripples are too small to move the entry point noticeably)
  var p = xz - SUN_TRAVEL * depth;
  var slope = vec2f(0.0);
  for (var i = 0u; i < WAVE_MESH_COUNT; i++) {
    let w = waveShape(i);
    slope += w.xy * (w.z * w.w * cos(wavePhase(i, p, t)));
  }
  p -= CAUSTIC_BEND * depth * slope;
  // contrast washes out with depth
  return mix(1.0, waveFocus(p, depth, t, WAVE_COUNT), exp(-depth * CAUSTIC_FADE));
}

// The same for light shafts: sampled many times per pixel, so no entry-point refinement, and a
// slower wash-out (shafts stay visible deeper than the sharp caustic pattern on the sand). The
// first few ripples matter here (the big mesh waves alone focus too weakly to make beams), but the
// finest ones are shorter than the march step and would only add noise.
fn shaftFocus(xz: vec2f, depth: f32, t: f32) -> f32 {
  let p = xz - SUN_TRAVEL * depth;
  return mix(1.0, waveFocus(p, depth, t, SHAFT_WAVES), exp(-depth * SHAFT_FADE));
}

// multiplier for sunlight at \`xz\`, \`depth\` below the surface
fn causticLight(xz: vec2f, depth: f32, t: f32) -> f32 {
  return CAUSTIC_BASE + CAUSTIC_GAIN * causticFocus(xz, depth, t);
}
`;
