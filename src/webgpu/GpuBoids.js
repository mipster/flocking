import simWGSL from './sim.wgsl?raw';
import { TANK_HALF as DEFAULT_HALF } from '../species.js';

export const CELL_SIZE = 8;
const WG = 64;

export async function getDevice() {
  if (!navigator.gpu) throw new Error('WebGPU is not available in this browser');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter');
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });
  return { adapter, device };
}

const ENTRY_POINTS = ['snapshot', 'steerBrute', 'clearCells', 'countCells', 'scanCells', 'scatter', 'steerGrid'];

export class GpuBoids {
  // counts = [small, medium, large]; mode = 'grid' | 'brute'
  constructor(device, species, counts, { mode = 'grid', maxPerCell = 8, half = DEFAULT_HALF, wrap = true } = {}) {
    this.device = device;
    this.species = species;
    this.mode = mode;
    this.maxPerCell = maxPerCell;
    this.half = half;
    this.wrap = wrap; // true: fish re-enter on the opposite x/z edge; false: soft side walls
    this.count = counts[0] + counts[1] + counts[2];
    this.time = 0;

    this.dims = half.map((h) => Math.ceil((2 * h) / CELL_SIZE));
    this.keys = this.dims[0] * this.dims[1] * this.dims[2] * 3;

    const S = GPUBufferUsage.STORAGE;
    const mk = (size, usage) => device.createBuffer({ size: Math.max(size, 16), usage });
    const n = this.count;
    this.pos = mk(n * 16, S | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    this.vel = mk(n * 16, S | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    this.spos = mk(n * 16, S);
    this.svel = mk(n * 16, S);
    this.cellCount = mk(this.keys * 4, S);
    this.cellStart = mk((this.keys + 1) * 4, S);
    this.keyOf = mk(n * 4, S);
    this.rankOf = mk(n * 4, S);
    this.params = mk(64, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.specBuf = mk(12 * 16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);

    this.upload(counts);

    const module = device.createShaderModule({ code: simWGSL });
    module.getCompilationInfo().then((info) => {
      for (const m of info.messages) console.warn(`WGSL ${m.type} ${m.lineNum}:${m.linePos} ${m.message}`);
    });
    const storage = { type: 'storage' };
    const bgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        ...[2, 3, 4, 5, 6, 7, 8, 9].map((b) => ({ binding: b, visibility: GPUShaderStage.COMPUTE, buffer: storage })),
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    this.pipes = {};
    for (const entryPoint of ENTRY_POINTS) {
      this.pipes[entryPoint] = device.createComputePipeline({ layout, compute: { module, entryPoint } });
    }
    const b = (binding, buffer) => ({ binding, resource: { buffer } });
    this.bindGroup = device.createBindGroup({
      layout: bgl,
      entries: [
        b(0, this.params), b(1, this.specBuf), b(2, this.pos), b(3, this.vel), b(4, this.spos),
        b(5, this.svel), b(6, this.cellCount), b(7, this.cellStart), b(8, this.keyOf), b(9, this.rankOf),
      ],
    });
  }

  upload(counts) {
    const n = this.count;
    const posData = new Float32Array(n * 4);
    const velData = new Float32Array(n * 4);
    const [nS, nM] = counts;
    for (let i = 0; i < n; i++) {
      const sp = i < nS ? 0 : i < nS + nM ? 1 : 2;
      const o = i * 4;
      posData[o] = (Math.random() * 2 - 1) * this.half[0] * 0.8;
      posData[o + 1] = (Math.random() * 2 - 1) * this.half[1] * 0.8;
      posData[o + 2] = (Math.random() * 2 - 1) * this.half[2] * 0.8;
      posData[o + 3] = sp;
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const speed = this.species[sp].maxSpeed * 0.5;
      velData[o] = s * Math.cos(a) * speed;
      velData[o + 1] = u * speed;
      velData[o + 2] = s * Math.sin(a) * speed;
      velData[o + 3] = Math.random() * Math.PI * 2;
    }
    this.device.queue.writeBuffer(this.pos, 0, posData);
    this.device.queue.writeBuffer(this.vel, 0, velData);
  }

  syncSpecies() {
    const d = new Float32Array(48);
    this.species.forEach((s, i) => {
      d.set([
        s.maxSpeed, s.maxForce, s.sepRadius, s.aliRadius,
        s.cohRadius, s.sepWeight, s.aliWeight, s.cohWeight,
        s.fearRadius, s.fearWeight, s.huntRadius, s.huntWeight,
        s.wander, s.scale, 0, 0,
      ], i * 16);
    });
    this.device.queue.writeBuffer(this.specBuf, 0, d);
  }

  // Encodes one simulation step. Returns nothing; call sync() to wait for the GPU.
  step(dt) {
    this.time += dt;
    const q = this.device.queue;
    this.syncSpecies();
    q.writeBuffer(this.params, 0, new Float32Array([
      dt, this.time, this.count, this.maxPerCell,
      this.half[0], this.half[1], this.half[2], 10,
      CELL_SIZE, this.dims[0], this.dims[1], this.dims[2],
      this.wrap ? 1 : 0, 0, 0, 0,
    ]));

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setBindGroup(0, this.bindGroup);
    const run = (name, groups) => {
      pass.setPipeline(this.pipes[name]);
      pass.dispatchWorkgroups(groups);
    };
    const nGroups = Math.ceil(this.count / WG);
    if (this.mode === 'brute') {
      run('snapshot', nGroups);
      run('steerBrute', nGroups);
    } else {
      run('clearCells', Math.ceil(this.keys / WG));
      run('countCells', nGroups);
      run('scanCells', 1);
      run('scatter', nGroups);
      run('steerGrid', nGroups);
    }
    pass.end();
    q.submit([enc.finish()]);
  }

  sync() {
    return this.device.queue.onSubmittedWorkDone();
  }

  destroy() {
    for (const k of ['pos', 'vel', 'spos', 'svel', 'cellCount', 'cellStart', 'keyOf', 'rankOf', 'params', 'specBuf']) {
      this[k].destroy();
    }
  }
}
