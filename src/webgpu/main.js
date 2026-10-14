import GUI from 'lil-gui';
import { SPECIES, DEFAULT_COUNTS, TANK_HALF } from '../species.js';
import { addSpeciesFolders } from '../gui.js';
import { getDevice, GpuBoids } from './GpuBoids.js';
import { FishRenderer } from './FishRenderer.js';
import { CAMERA, DEFAULT_FOG_DENSITY } from './config.js';

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
  fogDensity: DEFAULT_FOG_DENSITY,
  mediumCount: DEFAULT_COUNTS.medium,
  largeCount: DEFAULT_COUNTS.large,
};

async function main() {
  const { device } = await getDevice();
  device.lost.then((i) => {
    msg.style.display = 'block';
    msg.textContent = `GPU device lost: ${i.message}`;
  });
  device.addEventListener?.('uncapturederror', (e) => console.error('WebGPU error:', e.error.message));

  const renderer = new FishRenderer(device, canvas, SPECIES);
  let boids = null;

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
  g.add(settings, 'boundary', { 'wrap around (x, z)': 'wrap', 'soft walls': 'walls' })
    .name('side edges')
    .onChange((v) => {
      boids.wrap = v === 'wrap';
    });
  g.add(settings, 'tankWidth', 80, 800, 10).name('tank width').onFinishChange(rebuild);
  g.add(settings, 'tankDepth', 80, 800, 10).name('tank depth').onFinishChange(rebuild);
  g.add(settings, 'speed', 0, 3, 0.05).name('speed ×');
  g.add(settings, 'paused').name('pause');
  g.add(settings, 'fogDensity', 0, 0.03, 0.001).name('fog');
  g.add(settings, 'mediumCount', 0, 20000, 1).name('medium fish').onFinishChange(rebuild);
  g.add(settings, 'largeCount', 0, 2000, 1).name('large fish').onFinishChange(rebuild);
  g.add({ reset: rebuild }, 'reset');
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
    renderer.yaw -= (e.clientX - drag[0]) * 0.005;
    renderer.pitch = Math.max(-1.5, Math.min(1.5, renderer.pitch + (e.clientY - drag[1]) * 0.005));
    drag = [e.clientX, e.clientY];
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      renderer.dist = Math.max(
        CAMERA.minDistance,
        Math.min(CAMERA.maxDistance, renderer.dist * Math.exp(e.deltaY * 0.001))
      );
    },
    { passive: false }
  );

  // Only submit a new frame once the previous one has finished on the GPU. Otherwise
  // requestAnimationFrame happily queues frames faster than the GPU can draw them, the
  // counter reads high and the picture stutters.
  let last = performance.now();
  let busy = false;
  let done = 0;
  let acc = 0;
  let gpuMsSum = 0;
  const recent = [];
  function frame() {
    requestAnimationFrame(frame);
    if (busy) return;
    const now = performance.now();
    const raw = (now - last) / 1000;
    last = now;
    const dt = Math.min(raw, 1 / 30);

    const dpr = Math.min(window.devicePixelRatio, 2);
    renderer.resize(Math.floor(window.innerWidth * dpr), Math.floor(window.innerHeight * dpr));
    renderer.fogDensity = settings.fogDensity;
    if (!settings.paused) boids.step(dt * settings.speed);
    renderer.render(boids);

    busy = true;
    const t0 = performance.now();
    device.queue.onSubmittedWorkDone().then(() => {
      busy = false;
      const g = performance.now() - t0;
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
