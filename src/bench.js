import { SPECIES } from './species.js';
import { getDevice, GpuBoids } from './webgpu/GpuBoids.js';

// side^2 fish; large share fixed at ~0.5%, medium ~2% so every run sees the same mix
const SIDES = [64, 128, 256, 512, 1024];
const SLOW_MS = 600; // stop growing an engine's fish count once one step costs more than this
const DT = 1 / 60;

const $ = (id) => document.getElementById(id);
const status = (t) => {
  $('status').textContent = t;
};
const countsFor = (n) => {
  const large = Math.max(1, Math.round(n * 0.005));
  const medium = Math.round(n * 0.02);
  return [n - large - medium, medium, large];
};

// time `steps` batched steps; returns ms per step
async function timeBatches(stepFn, syncFn, budgetMs = 1500) {
  for (let i = 0; i < 3; i++) stepFn();
  await syncFn();
  let steps = 0;
  const t0 = performance.now();
  let batch = 4;
  while (performance.now() - t0 < budgetMs && steps < 400) {
    for (let i = 0; i < batch; i++) stepFn();
    await syncFn();
    steps += batch;
    const per = (performance.now() - t0) / steps;
    batch = per > 100 ? 1 : per > 20 ? 2 : 4;
  }
  return (performance.now() - t0) / steps;
}

async function benchWebGPU(n, device, mode, maxPerCell) {
  const boids = new GpuBoids(device, SPECIES, countsFor(n), { mode, maxPerCell });
  const ms = await timeBatches(
    () => boids.step(DT),
    () => boids.sync()
  );
  boids.destroy();
  return ms;
}

async function run() {
  $('run').disabled = true;
  const results = []; // {engine, n, ms}
  const engines = [];

  let device = null;
  try {
    device = (await getDevice()).device;
    engines.push({
      name: 'WebGPU brute force',
      maxN: 262144,
      run: (n) => benchWebGPU(n, device, 'brute', 0),
    });
    for (const cap of [4, 8, 32]) {
      engines.push({
        name: `WebGPU grid (${cap} samples/cell)`,
        run: (n) => benchWebGPU(n, device, 'grid', cap),
      });
    }
  } catch (e) {
    status(`WebGPU unavailable: ${e.message}`);
  }

  const only = new URLSearchParams(location.search).get('only');
  if (only)
    engines.splice(
      0,
      engines.length,
      ...engines.filter((e) => e.name.toLowerCase().includes(only.toLowerCase()))
    );

  const ns = SIDES.map((s) => s * s);
  for (const eng of engines) {
    let stop = false;
    for (const n of ns) {
      if (stop || n > (eng.maxN ?? Infinity)) {
        results.push({ engine: eng.name, n, ms: null });
        continue;
      }
      status(`${eng.name} — ${n.toLocaleString()} fish…`);
      await new Promise((r) => setTimeout(r, 30));
      let ms;
      try {
        ms = await eng.run(n);
      } catch (e) {
        console.error(e);
        ms = null;
        stop = true;
      }
      results.push({ engine: eng.name, n, ms });
      if (ms === null || ms > SLOW_MS) stop = true;
    }
  }

  const rows = engines.map((e) => {
    const cells = ns.map((n) => {
      const r = results.find((x) => x.engine === e.name && x.n === n);
      if (!r || r.ms === null) return '<td class="skip">skipped</td>';
      return `<td>${r.ms < 10 ? r.ms.toFixed(2) : r.ms.toFixed(1)}</td>`;
    });
    return `<tr><td>${e.name}</td>${cells.join('')}</tr>`;
  });
  $('out').innerHTML =
    `<table><tr><th>ms / step</th>${ns.map((n) => `<th>${n.toLocaleString()}</th>`).join('')}</tr>${rows.join('')}</table>`;
  window.__bench = results;
  $('env').textContent = `${navigator.userAgent}\n${JSON.stringify(results)}`;
  status('done');
  $('run').disabled = false;
}

$('run').addEventListener('click', run);
if (new URLSearchParams(location.search).has('auto')) run();
