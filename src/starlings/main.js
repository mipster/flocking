// Starling murmuration viewer: a flock of starlings at dusk, disturbed now and then by a hawk.
// Reuses the fish simulation (GpuBoids) with a home region, a minimum speed and an external
// predator; see config.js for the tuning and README for how it works.
import GUI from 'lil-gui';
import { STARLING } from '../species.js';
import { addSpeciesFolders } from '../gui.js';
import { getDevice, GpuBoids } from '../webgpu/GpuBoids.js';
import { FRAMES_IN_FLIGHT } from '../webgpu/config.js';
import {
  BIRD_COUNTS,
  DEFAULT_BIRDS,
  HAWK,
  HOME,
  MIN_SPEED,
  GRID,
  FLIGHT,
  WAVES,
  SKY_BOX,
  WATER_Y,
} from './config.js';
import { FlockSampler } from './flockSampler.js';
import { Hawk } from './raptor.js';
import { StarlingRenderer } from './StarlingRenderer.js';

const canvas = document.getElementById('c');
const stats = document.getElementById('stats');
const msg = document.getElementById('msg');

const settings = {
  birds: DEFAULT_BIRDS,
  speed: 1,
  autoHawk: true,
  homePull: HOME.strength,
  fearRadius: HAWK.fearRadius,
  fearWeight: HAWK.fearWeight,
  pixelRatio: 2,
};

/** Centre of the home region at time t: drifts on a slow Lissajous path. */
function homeCenter(t) {
  return HOME.center.map(
    (c, i) => c + HOME.drift[i] * Math.sin((2 * Math.PI * t) / HOME.periods[i] + i * 1.9)
  );
}

async function main() {
  const { device } = await getDevice();
  device.lost.then((i) => {
    msg.style.display = 'block';
    msg.textContent = `GPU device lost: ${i.message}`;
  });
  const renderer = new StarlingRenderer(device, canvas);
  // one species in all three sim slots, so the species panel edits every bird
  const species = [STARLING, STARLING, STARLING];
  let boids = null;
  function rebuild() {
    boids?.destroy();
    boids = new GpuBoids(device, species, [Number(settings.birds), 0, 0], {
      half: SKY_BOX,
      wrap: false,
      cellSize: GRID.cellSize,
      maxPerCell: GRID.samplesPerCell,
      minSpeed: MIN_SPEED,
      flight: FLIGHT,
      waves: WAVES,
      ground: WATER_Y,
      spawn: { center: HOME.center, radius: HOME.radius },
    });
  }
  rebuild();
  const hawk = new Hawk();
  const sampler = new FlockSampler(device);
  let lastSample = -Infinity;

  const gui = new GUI({ title: 'Murmuration (WebGPU)' });
  gui.add(settings, 'birds', BIRD_COUNTS).name('starlings').onChange(rebuild);
  gui.add(settings, 'speed', 0, 2, 0.05).name('speed ×');
  gui.add(settings, 'homePull', 0, 3, 0.05).name('pull toward roost');
  const h = gui.addFolder('Hawk');
  h.add(settings, 'autoHawk')
    .name('attacks on their own')
    .onChange((on) => hawk.setAuto(on, simTime));
  h.add({ send: () => hawk.send(simTime) }, 'send').name('send the hawk now');
  h.add(settings, 'fearRadius', 0, 40, 1).name('fear radius');
  h.add(settings, 'fearWeight', 0, 15, 0.5).name('fear strength');
  gui.add(settings, 'pixelRatio', { '1x': 1, '1.5x': 1.5, '2x': 2 }).name('pixel ratio cap');
  addSpeciesFolders(gui, [STARLING]);
  gui.close();

  let simTime = 0;
  let last = performance.now();
  let inFlight = 0;
  let frames = 0;
  let acc = 0;
  function frame() {
    requestAnimationFrame(frame);
    if (inFlight >= FRAMES_IN_FLIGHT) return;
    const now = performance.now();
    const raw = (now - last) / 1000;
    last = now;
    const dt = Math.min(raw, 1 / 30) * settings.speed;
    simTime += dt;

    const center = homeCenter(simTime);
    if (simTime - lastSample > 0.5) {
      sampler.request(boids);
      lastSample = simTime;
    }
    const flying = hawk.update(simTime, sampler.center ?? center, sampler.velocity);
    boids.home = { center, radius: HOME.radius, strength: settings.homePull, roost: true };
    boids.predator = flying
      ? {
          position: flying.position,
          velocity: flying.velocity,
          lookAhead: HAWK.warning,
          radius: settings.fearRadius,
          weight: settings.fearWeight,
        }
      : null;
    if (dt > 0) {
      boids.step(dt);
      renderer.trackVelocities(boids, dt);
    }

    const dpr = Math.min(window.devicePixelRatio, settings.pixelRatio);
    renderer.resize(Math.floor(window.innerWidth * dpr), Math.floor(window.innerHeight * dpr));
    renderer.render(boids, simTime, flying && { ...flying, phase: simTime * HAWK.flapRate });

    inFlight++;
    device.queue.onSubmittedWorkDone().then(() => {
      inFlight--;
      frames++;
      acc += Math.min(raw, 0.25);
      if (acc >= 0.5) {
        stats.textContent = `${Math.round(frames / acc)} fps · ${boids.count.toLocaleString()} starlings`;
        frames = 0;
        acc = 0;
      }
    });
  }
  frame();
  if (new URLSearchParams(location.search).has('debug')) {
    window.__boids = () => boids;
    window.__hawk = hawk;
    window.__renderer = renderer;
  }
}

main().catch((e) => {
  msg.style.display = 'block';
  msg.textContent = String(e?.message ?? e);
  console.error(e);
});
