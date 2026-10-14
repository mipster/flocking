# GPU Fish Flocking

A 3D fish-flocking demo built with [three.js](https://threejs.org/). Boid steering runs on the GPU (WebGL2 GPGPU via `GPUComputationRenderer`), and the fish are drawn as one instanced low-poly mesh. It is a browser rebuild of the flocking demo from *The Nature of Code*, extended with several fish species.

## Run it

```bash
npm install
npm run dev
```

Then open http://localhost:5173. A production build is available with `npm run build`.

Requires a browser with WebGL2 and float render targets (any recent desktop browser).

## WebGPU version and benchmark

- http://localhost:5173/webgpu.html is the same flock on WebGPU compute shaders with a GPU spatial grid (counting sort into cell and species buckets, capped samples per bucket). It runs 100k to 1M+ small fish; fish count, neighbor mode and samples per cell are in the panel.
- http://localhost:5173/bench.html times simulation steps for WebGL2 brute force, WebGPU brute force and WebGPU grid at 4k to 1M fish. Keep the tab visible while it runs, because a hidden tab can skip GPU work and give bogus numbers.

## Behavior

Three species, each with its own speed, force limit and flocking weights:

| Species | Behavior |
| --- | --- |
| Small | Fast, schools tightly in large groups, flees larger fish |
| Medium | Looser groups, flees large fish |
| Large | Slow, wanders, mildly drawn toward smaller fish |

- **Separation** applies to all neighbors.
- **Alignment and cohesion** only count fish of the same species.
- **Fear**: a fish steers away from any larger species within its fear radius.
- **Tank**: fish are steered back from soft walls instead of wrapping around.
- Steering follows Reynolds: `desired = normalize(sum) * maxSpeed`, `steer = desired - velocity`, clamped to `maxForce`.

## Controls

- **Mouse**: orbit, zoom and pan the camera (OrbitControls).
- **Panel (top right)**: fish count (32², 64², 128²), speed multiplier, pause, tank toggle, fog, species mix and reset. Each species folder exposes every steering parameter and applies it live.
- **Bottom left**: FPS and fish count.

## How it works

- Position and velocity live in float textures (one texel per fish), double-buffered. Each frame runs a velocity pass, then a position pass.
- Species parameters are uniform arrays indexed by species id, so GUI edits take effect immediately.
- The velocity pass is brute force O(N²): every fish scans every texel. This is fine up to about 16k fish on a decent GPU.
- The fish vertex shader reads position and velocity from the textures, builds an orientation basis from the velocity and bends the tail with the swim phase.

## Project layout

```
src/main.js                  renderer, scene, camera, loop
src/species.js               species definitions and defaults
src/gui.js                   lil-gui panels
src/sim/BoidSimulation.js    GPUComputationRenderer setup and stepping
src/sim/velocity.frag.glsl   steering (separation, alignment, cohesion, fear, bounds)
src/sim/position.frag.glsl   integration
src/render/FishSchool.js     fish geometry and instancing
src/render/fish.vert.glsl    orientation, tail wiggle
src/render/fish.frag.glsl    lighting and fog
```

## Roadmap

- **Scale**: a GPU spatial grid (cell index, bitonic sort, neighbor-cell search) to reach 100k+ fish.
- **Polish**: water gradient, caustics, light shafts, a mouse-controlled predator or food source, and presets.
