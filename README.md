# GPU Fish Flocking

A 3D fish-flocking demo running entirely on the GPU with WebGPU compute shaders. It is a browser rebuild of the flocking demo from _The Nature of Code_, extended with several fish species, and scales from thousands to a million fish using a spatial grid.

## Run it

```bash
npm install
npm run dev
```

Then open http://localhost:5173. A production build is available with `npm run build`.

Requires a browser with WebGPU (Chrome, Edge or Brave 113+ on macOS, Windows and ChromeOS).

- **Viewer** (`/`): the flock. Fish count (16k to 2M), neighbor mode (spatial grid or brute force), samples per cell, left/right edges (wrap around or soft walls), tank width and depth, and exact medium and large fish counts are in the panel.
- **Benchmark** (`/bench.html`): times simulation steps for WebGPU brute force and the grid at 4k to 1M fish. Keep the tab visible while it runs, because a hidden tab can skip GPU work and give bogus numbers.

## Development

```bash
npm run check    # lint, format check, unit tests, production build (same as CI)
npm run format   # apply Prettier
```

Conventions and the module map are in [CLAUDE.md](CLAUDE.md). Open the viewer with `?debug` to expose
the simulation as `window.__boids` for console inspection.

## Behavior

Three species, each with its own speed, force limit and flocking weights:

| Species | Behavior                                                 |
| ------- | -------------------------------------------------------- |
| Small   | Fast, schools tightly in large groups, flees larger fish |
| Medium  | Looser groups, flees large fish                          |
| Large   | Slow, wanders, mildly drawn toward smaller fish          |

- **Separation** applies to all neighbors.
- **Alignment and cohesion** only count fish of the same species.
- **Fear**: a fish steers away from any larger species within its fear radius.
- **Tank**: the near and far walls, the floor and the surface are always barriers. The left and right edges either wrap around or are soft walls.
- Alignment, cohesion and hunting follow Reynolds: `desired = normalize(sum) * maxSpeed`, `steer = desired - velocity`, clamped to `maxForce`.
- Separation and fear push away with a strength that fades from full at contact to zero at the radius, so crossing a radius never snaps the heading.
- The flocking force is low-pass filtered (**steering smoothing**, 0.1 s by default) to keep dense schools from twitching.

## Controls

- **Mouse**: orbit, zoom and pan the camera (OrbitControls).
- **Panel (top right)**: fish count (32², 64², 128²), speed multiplier, pause, tank toggle, fog, species mix and reset. Each species folder exposes every steering parameter and applies it live.
- **Bottom left**: FPS and fish count.

## How it works

- Position and velocity live in GPU storage buffers (one entry per fish). Each frame runs a few compute passes, then draws one instanced low-poly fish mesh.
- **Spatial grid**: fish are counting-sorted into (cell, species) buckets each frame, and each fish scans only nearby cells, taking a capped number of samples per bucket. Brute force (tiled through workgroup memory) is available for comparison.
- **Boundaries**: the floor, surface, near and far walls are hard barriers. The left and right edges either wrap around (same direction and velocity, neighbors found across the seam) or are soft walls.
- The fish vertex shader builds an orientation basis from the velocity and bends the tail with the swim phase.
- **Water**: Beer-Lambert absorption per colour channel (red goes first) dims sunlight with depth and tints distant objects, with veiling light filling in, plus a gradient backdrop with a sun glow. The **water murkiness** slider scales it.
- **Surface**: Gerstner waves, drawn translucent. From above you see through it with a Fresnel sky and sun reflection; from below you see the sky through Snell's window, and a mirror of the water beyond the critical angle. **camera looks at height** tilts the view up at it.

## Project layout

```
index.html, bench.html
src/species.js               species definitions, defaults and tank size
src/webgpu/config.js         engine tuning constants (one place)
src/webgpu/layout.js         uniform buffer packing with named fields
src/webgpu/floor.js          sea floor height (JS reference + generated WGSL)
src/gui.js                   species parameter panels
src/webgpu/main.js           viewer: device, GUI, camera, frame loop
src/webgpu/GpuBoids.js       buffers, pipelines, per-frame compute passes
src/webgpu/sim.wgsl          steering, spatial grid, boundaries
src/webgpu/FishRenderer.js   instanced rendering, camera matrices
src/webgpu/render.wgsl       orientation, tail wiggle, lighting, fog
src/webgpu/fishGeometry.js   low-poly fish mesh
src/bench.js                 benchmark runner
```

## Roadmap

- Sea floor, absorption-based water colour, animated surface, caustics and light shafts.
- Mouse-controlled predator or food source, and presets.
