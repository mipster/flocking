// Sea floor height, shared by the simulation (fish steer away from it) and the renderer.
// Built from sine harmonics of the tank size, so the floor tiles seamlessly when fish wrap around.
const TAU_F = 6.283185307;

fn floorHeight(p: vec2f, half: vec3f) -> f32 {
  let u = p.x / (half.x * 2.0);   // 1.0 == one tank width
  let w = p.y / (half.z * 2.0);
  let a = sin(TAU_F * (2.0 * u + 0.15 * sin(TAU_F * w)));
  let b = sin(TAU_F * (3.0 * w + u) + 1.7);
  let c = sin(TAU_F * (5.0 * u - 4.0 * w) + 0.4);
  return 3.4 * a + 1.8 * b + 0.9 * c;   // roughly +-6 units
}

fn floorY(p: vec2f, half: vec3f) -> f32 {
  return -half.y + 8.0 + floorHeight(p, half);
}
