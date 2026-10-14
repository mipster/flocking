import GUI from 'lil-gui';
import { SPECIES, DEFAULT_COUNTS, TANK_HALF } from '../species.js';
import { addSpeciesFolders } from '../gui.js';
import { getDevice, GpuBoids } from './GpuBoids.js';
import { FishRenderer } from './FishRenderer.js';
import {
  CAMERA,
  DEFAULT_LOOK_HEIGHT,
  DEFAULT_MURKINESS,
  DEFAULT_SHAFT_STRENGTH,
  DEFAULT_SNOW_AMOUNT,
  DEFAULT_VIGNETTE,
  DEFAULT_WAVES,
  WAVE_SCALE_MAX,
  DEFAULT_STEERING_SMOOTHING,
  FRAMES_IN_FLIGHT,
} from './config.js';
import { DEFAULT_PRESET, PRESETS, PRESET_KEYS, applyPreset } from './presets.js';

const DEBUG = new URLSearchParams(location.search).has('debug');

const canvas = document.getElementById('c');
const stats = document.getElementById('stats');
const msg = document.getElementById('msg');

const settings = {
  total: 65536,
  mode: 'grid',
  maxPerCell: 8,
  speed: 1,
  paused: false,
  boundary: 'wrap',
  tankWidth: 240,
  tankDepth: 160,
  murkiness: DEFAULT_MURKINESS,
  shafts: DEFAULT_SHAFT_STRENGTH,
  snow: DEFAULT_SNOW_AMOUNT,
  vignette: DEFAULT_VIGNETTE,
  waveHeight: DEFAULT_WAVES.height,
  waveScale: DEFAULT_WAVES.scale,
  waveSpeed: DEFAULT_WAVES.speed,
  preset: DEFAULT_PRESET,
  lookHeight: DEFAULT_LOOK_HEIGHT,
  smoothing: DEFAULT_STEERING_SMOOTHING,
  mediumCount: DEFAULT_COUNTS.medium,
  largeCount: DEFAULT_COUNTS.large,
  simulate: true,
  pixelRatio: 2, // cap on devicePixelRatio
};

async function main() {
  const { device } = await getDevice();
  device.lost.then((i) => {
    msg.style.display = 'block';
    msg.textContent = `GPU device lost: ${i.message}`;
  });
  device.addEventListener?.('uncapturederror', (e) => console.error('WebGPU error:', e.error.message));

  const renderer = new FishRenderer(device, canvas, SPECIES, {
    samples: new URLSearchParams(location.search).get('msaa') === '1' ? 1 : undefined,
  });
  let boids = null;
  if (DEBUG) window.__renderer = renderer; // console inspection: camera yaw/pitch/dist

  function rebuild() {
    boids?.destroy();
    const total = Number(settings.total);
    const large = Math.min(settings.largeCount, total);
    const medium = Math.min(settings.mediumCount, total - large);
    boids = new GpuBoids(device, SPECIES, [total - medium - large, medium, large], {
      mode: settings.mode,
      maxPerCell: settings.maxPerCell,
      half: [settings.tankWidth / 2, TANK_HALF[1], settings.tankDepth / 2],
      wrap: settings.boundary === 'wrap',
      smoothing: settings.smoothing,
    });
    if (DEBUG) window.__boids = boids; // console inspection: open the page with ?debug
  }

  const gui = new GUI({ title: 'Fish flock (WebGPU)' });
  const g = gui.addFolder('Global');
  g.add(settings, 'total', {
    '16k': 16384,
    '65k': 65536,
    '131k': 131072,
    '262k': 262144,
    '524k': 524288,
    '1M': 1048576,
    '2M': 2097152,
  })
    .name('fish count')
    .onChange(rebuild);
  g.add(settings, 'mode', { 'spatial grid': 'grid', 'brute force': 'brute' })
    .name('neighbors')
    .onChange((v) => {
      boids.mode = v;
    });
  g.add(settings, 'maxPerCell', 1, 64, 1)
    .name('samples / cell')
    .onChange((v) => {
      boids.maxPerCell = v;
    });
  g.add(settings, 'boundary', { 'wrap left / right': 'wrap', 'soft walls': 'walls' })
    .name('left / right edges')
    .onChange((v) => {
      boids.wrap = v === 'wrap';
    });
  g.add(settings, 'tankWidth', 80, 800, 10).name('tank width').onFinishChange(rebuild);
  g.add(settings, 'tankDepth', 80, 800, 10).name('tank depth').onFinishChange(rebuild);
  g.add(settings, 'smoothing', 0, 0.5, 0.01)
    .name('steering smoothing (s)')
    .onChange((v) => {
      boids.smoothing = v;
    });
  g.add(settings, 'speed', 0, 3, 0.05).name('speed ×');
  g.add(settings, 'paused').name('pause');
  // water look: a preset sets all four sliders at once; touching one by hand marks the preset
  // as "custom" so the dropdown never claims a look that no longer matches
  const look = gui.addFolder('Water look');
  const presetControl = look
    .add(settings, 'preset', ['custom', ...Object.keys(PRESETS)])
    .name('preset')
    .onChange((name) => {
      if (!applyPreset(settings, name)) return;
      for (const c of look.controllers) if (c !== presetControl) c.updateDisplay();
    });
  const markCustom = () => {
    settings.preset = 'custom';
    presetControl.updateDisplay();
  };
  const lookSliders = {
    murkiness: [0, 4, 'water murkiness'],
    shafts: [0, 3, 'light shafts'],
    snow: [0, 2, 'marine snow'],
    vignette: [0, 1, 'vignette'],
    waveHeight: [0.1, 3, 'wave height'],
    waveScale: [0.4, WAVE_SCALE_MAX, 'wave scale (shorter →)'],
    waveSpeed: [0, 3, 'wave speed'],
  };
  for (const key of PRESET_KEYS) {
    const [min, max, label] = lookSliders[key];
    look.add(settings, key, min, max, 0.05).name(label).onChange(markCustom);
  }
  g.add(settings, 'lookHeight', -30, 40, 1).name('camera looks at height');
  g.add(settings, 'mediumCount', 0, 20000, 1).name('medium fish').onFinishChange(rebuild);
  g.add(settings, 'largeCount', 0, 2000, 1).name('large fish').onFinishChange(rebuild);
  g.add({ reset: rebuild }, 'reset');
  if (DEBUG) {
    // profiling switches: turn layers off one at a time and watch the fps / GPU ms readout
    const p = gui.addFolder('Profiling (?debug)');
    p.add(settings, 'simulate').name('simulate fish');
    for (const [key, name] of [
      ['fish', 'draw fish'],
      ['surface', 'draw surface'],
      ['floor', 'draw sea floor'],
      ['snow', 'draw marine snow'],
      ['cull', 'frustum culling'],
      ['floorCaustics', 'sand caustics'],
    ]) {
      p.add(renderer.layers, key).name(name);
    }
    p.add(settings, 'pixelRatio', { '1x': 1, '1.5x': 1.5, '2x': 2 }).name('pixel ratio cap');
  }
  addSpeciesFolders(gui, SPECIES);
  rebuild();

  // orbit camera: drag to rotate, wheel to zoom
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = [e.clientX, e.clientY];
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointerup', () => {
    drag = null;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    renderer.yaw -= (e.clientX - drag[0]) * CAMERA.dragSensitivity;
    renderer.pitch = Math.max(
      -CAMERA.maxPitch,
      Math.min(CAMERA.maxPitch, renderer.pitch + (e.clientY - drag[1]) * CAMERA.dragSensitivity)
    );
    drag = [e.clientX, e.clientY];
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      renderer.dist = Math.max(
        CAMERA.minDistance,
        Math.min(CAMERA.maxDistance, renderer.dist * Math.exp(e.deltaY * CAMERA.zoomSensitivity))
      );
    },
    { passive: false }
  );

  // Keep at most FRAMES_IN_FLIGHT frames queued on the GPU. Without a limit
  // requestAnimationFrame happily queues frames faster than the GPU can draw them, the
  // counter reads high and the picture stutters; with 1 the CPU and GPU never overlap.
  let last = performance.now();
  let inFlight = 0;
  let lastDone = performance.now();
  let done = 0;
  let acc = 0;
  let gpuMsSum = 0;
  const recent = [];
  function frame() {
    requestAnimationFrame(frame);
    if (inFlight >= FRAMES_IN_FLIGHT) return;
    const now = performance.now();
    const raw = (now - last) / 1000;
    last = now;
    const dt = Math.min(raw, 1 / 30);

    const dpr = Math.min(window.devicePixelRatio, settings.pixelRatio);
    renderer.resize(Math.floor(window.innerWidth * dpr), Math.floor(window.innerHeight * dpr));
    renderer.murkiness = settings.murkiness;
    renderer.shaftStrength = settings.shafts;
    renderer.snowAmount = settings.snow;
    renderer.vignette = settings.vignette;
    renderer.waveHeight = settings.waveHeight;
    renderer.waveScale = settings.waveScale;
    renderer.waveSpeed = settings.waveSpeed;
    renderer.targetY = settings.lookHeight;
    if (settings.simulate && !settings.paused) boids.step(dt * settings.speed);
    renderer.render(boids, now / 1000);

    inFlight++;
    const submitted = performance.now();
    device.queue.onSubmittedWorkDone().then(() => {
      inFlight--;
      const finished = performance.now();
      // the GPU was busy from this frame's submission, or from when the previous one finished
      const g = finished - Math.max(submitted, lastDone);
      lastDone = finished;
      gpuMsSum += g;
      recent.push(raw * 1000);
      done++;
      acc += raw;
      if (acc >= 0.5) {
        // frame intervals over the last window: p50 = typical, worst = biggest hitch
        const iv = recent.splice(0).sort((a, b) => a - b);
        const p50 = iv[Math.floor(iv.length / 2)] ?? 0;
        const worst = iv[iv.length - 1] ?? 0;
        stats.textContent =
          `${Math.round(done / acc)} fps · gpu ${(gpuMsSum / done).toFixed(1)} ms/frame\n` +
          `frame time typical ${p50.toFixed(0)} ms · worst ${worst.toFixed(0)} ms\n` +
          `${boids.count.toLocaleString()} fish · ${boids.mode}`;
        done = 0;
        acc = 0;
        gpuMsSum = 0;
      }
    });
  }
  frame();
}

main().catch((e) => {
  msg.style.display = 'block';
  msg.textContent = String(e.message || e);
  console.error(e);
});
