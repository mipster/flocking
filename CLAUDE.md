# Fish flocking: project conventions

WebGPU compute-shader fish flock (no WebGL, no three.js). Run with `npm run dev`; open `/` for the
viewer and `/bench.html` for the benchmark.

## Layout

- `src/species.js`: species definitions, default counts and tank size (the only place species data lives).
- `src/gui.js`: lil-gui panels for species parameters.
- `src/webgpu/config.js`: every tuning constant for the engine. Add new constants here, not inline.
- `src/webgpu/layout.js`: **all** uniform-buffer packing, with named fields. Never write raw float
  arrays to a uniform buffer elsewhere.
- `src/webgpu/floor.js`: sea floor height, as JS reference plus the generated WGSL twin.
- `src/webgpu/GpuBoids.js`: buffers, pipelines and per-frame compute passes. `sim.wgsl`: the shader.
- `src/webgpu/FishRenderer.js` / `render.wgsl`: drawing. `main.js`: viewer wiring.

## Rules

- A change to a uniform struct in WGSL must change `layout.js` and its test in the same commit.
- Shared constants reach the shaders through `wgslHeader()` / generated WGSL, never by copy-paste.
- Keep GPU code free of hidden state: per-frame data goes through uniforms; no globals on `window`
  except behind `?debug`.
- Performance-relevant changes: run `/bench.html` (tab visible!) and compare against the README numbers.
- Keep modules small and single-purpose; prefer named constants and short comments that say _why_.

## Checks (run before committing; CI runs the same)

```
npm run check    # lint + format check + tests + build
npm run format   # apply Prettier
```

GPU behaviour is verified in the browser (viewer + benchmark), not mocked in unit tests.

## Audits

Before each commit run `/code-review` and `/simplify` on the diff. At each phase boundary do a whole-repo
pass for duplicated constants, dead code, README drift and benchmark regressions.
