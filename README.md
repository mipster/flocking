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

- **Mouse**: drag to orbit, wheel to zoom.
- **Global panel (top right)**: fish count (16k to 2M), neighbor mode, samples per cell, left/right edges, tank width and depth, steering smoothing, speed, pause, camera look height, and exact medium and large fish counts. Each species folder exposes every steering parameter and applies it live.
- **Water look**: a **preset** dropdown (Reef, Clear shallows, Deep blue, Murky bay, Stormy) sets water murkiness, light shafts, marine snow, vignette and the three wave sliders (**wave height**, **wave scale**, **wave speed**) together. Moving any of those sliders by hand switches the dropdown to "custom". Presets live in `src/webgpu/presets.js`.
- **Bottom left**: FPS, GPU time per frame, frame time and fish count.
- **`?debug`**: adds profiling switches (simulate, draw fish, surface, sea floor, marine snow, frustum culling, sand caustics, pixel ratio) and exposes `window.__boids` and `window.__renderer`. Add `&msaa=1` to turn multisampling off.

## How it works

- Position and velocity live in GPU storage buffers (one entry per fish). Each frame runs a few compute passes, then draws one instanced low-poly fish mesh.
- **Spatial grid**: fish are counting-sorted into (cell, species) buckets each frame, and each fish scans only nearby cells, taking a capped number of samples per bucket. Brute force (tiled through workgroup memory) is available for comparison.
- **Boundaries**: the floor, surface, near and far walls are hard barriers. The left and right edges either wrap around (same direction and velocity, neighbors found across the seam) or are soft walls.
- Fish outside the view are culled by a compute pass that builds the draw lists, and the draws are indirect. The viewer keeps two frames in flight so CPU and GPU overlap.
- Small fish use a ~20-triangle mesh and the larger species a ~70-triangle one (`FISH_LOD` in `config.js`), and per-fish water lighting is computed once per fish rather than per vertex. Open the viewer with `?debug` for per-layer profiling switches, and add `&msaa=1` to turn multisampling off.
- The fish vertex shader builds an orientation basis from the velocity and bends the tail with the swim phase.
- **Water**: Beer-Lambert absorption per colour channel (red goes first) dims sunlight with depth and tints distant objects, with veiling light filling in, plus a gradient backdrop with a sun glow. The **water murkiness** slider scales it.
- **Surface**: Gerstner waves, drawn translucent. From above you see through it with a Fresnel sky and sun reflection; from below you see the sky through Snell's window, and a mirror of the water beyond the critical angle. **camera looks at height** tilts the view up at it.
- **Caustics**: sunlight focused by the waves (the mesh waves plus fine ripples too short to mesh) is analytic per pixel: the surface acts as a lens, and light at a point is `1 / |det(I + bend * depth * Hessian(height))|`. It dapples the sand and, evaluated once per fish in a small compute pass before drawing, the fish; it washes out with depth.
- **Light shafts**: each view ray is marched at half resolution until it reaches the range limit, the surface or the sea floor, accumulating sunlight scattered toward the eye. The sunlight at each sample is modulated by the same wave focusing as the caustics, so the beams sway with the waves, and the haze is brighter looking toward the sun. It is added on top of the finished frame; the **light shafts** slider scales it (0 skips the passes).
- **Marine snow**: ~24k drifting specks, placed analytically in the vertex shader (a function of index and time, so no simulation or buffers) inside a box that follows the camera. They sink, wander and bob under the waves, are lit and hazed like everything else, and brighten in beams. The **marine snow** slider scales the count.
- **Patchy haze**: the density the shafts scatter varies slowly in 3D noise and drifts, so beams look uneven (`HAZE` in `config.js`).
- **Vignette**: a final full-screen pass multiplies the frame by a factor that falls toward the corners (`VIGNETTE` in `config.js`); the **vignette** slider scales it, and 0 skips the pass.
- **Glint**: small fish flash a tight sun specular off their flanks as they cross the light (per-species **glint** slider; it rides on the caustic-lit sunlight, so it pulses with the caustics).

## Project layout

```
index.html, bench.html
src/species.js               species definitions, defaults and tank size
src/gui.js                   species parameter panels
src/webgpu/config.js         engine tuning constants (one place)
src/webgpu/presets.js        water-look presets (named bundles of slider values)
src/webgpu/layout.js         uniform buffer packing with named fields
src/webgpu/floor.js          sea floor height (JS reference + generated WGSL)
src/webgpu/caustics.js       wave-focusing WGSL shared by sand, fish and shafts
src/webgpu/main.js           viewer: device, GUI, camera, frame loop
src/webgpu/GpuBoids.js       buffers, pipelines, per-frame compute passes
src/webgpu/sim.wgsl          steering, spatial grid, boundaries
src/webgpu/FishRenderer.js   passes: backdrop, floor, culled fish, snow, surface, shafts, vignette
src/webgpu/render.wgsl       all render shaders (water, fish, floor, surface, shafts, snow)
src/webgpu/fishGeometry.js   low-poly fish meshes (full and simple)
src/bench.js                 benchmark runner
```

## Roadmap

- Mouse-controlled predator or food source.
- Optional: baked caustic texture, bubbles, seaweed and rocks on the floor.
