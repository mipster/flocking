import simWGSL from './sim.wgsl?raw';
import { floorWGSL } from './floor.js';
import {
  DEFAULT_STEERING_SMOOTHING,
  CELL_SIZE,
  WALL_MARGIN,
  WORKGROUP_SIZE,
  SPECIES_COUNT,
  wgslHeader,
} from './config.js';
import { SIM_PARAMS_FLOATS, SIM_SPECIES_STRIDE, packSimParams, packSimSpecies } from './layout.js';
import { TANK_HALF as DEFAULT_HALF } from '../species.js';

export async function getDevice() {
  if (!navigator.gpu) throw new Error('WebGPU is not available in this browser');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter');
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage,
    },
  });
  return { adapter, device };
}

const ENTRY_POINTS = [
  'snapshot',
  'steerBrute',
  'clearCells',
  'countCells',
  'scanCells',
  'scatter',
  'steerGrid',
];

// The shader module, bind group layout and pipelines depend only on the device, not on fish counts
// or tank size, so they are built once per device and shared by every flock rebuild.
const pipelineCache = new WeakMap();

function simPipelines(device) {
  let cached = pipelineCache.get(device);
  if (cached) return cached;
  const module = device.createShaderModule({ code: wgslHeader() + floorWGSL + simWGSL });
  module.getCompilationInfo().then((info) => {
    for (const m of info.messages) console.warn(`WGSL ${m.type} ${m.lineNum}:${m.linePos} ${m.message}`);
  });
  const storage = { type: 'storage' };
  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ...[2, 3, 4, 5, 6, 7, 8, 9].map((binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        buffer: storage,
      })),
    ],
  });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const pipes = {};
  for (const entryPoint of ENTRY_POINTS) {
    pipes[entryPoint] = device.createComputePipeline({ layout, compute: { module, entryPoint } });
  }
  cached = { bgl, pipes };
  pipelineCache.set(device, cached);
  return cached;
}

export class GpuBoids {
  // counts = [small, medium, large]; mode = 'grid' | 'brute'
  constructor(
    device,
    species,
    counts,
    {
      mode = 'grid',
      maxPerCell = 8,
      half = DEFAULT_HALF,
      wrap = true,
      smoothing = DEFAULT_STEERING_SMOOTHING,
    } = {}
  ) {
    this.device = device;
    this.species = species;
    this.mode = mode;
    this.maxPerCell = maxPerCell;
    this.smoothing = smoothing; // steering low-pass time constant in seconds; 0 disables
    // x and z must be whole numbers of grid cells so the wrap seam lines up with a cell edge
    const snap = (h) => (Math.ceil((2 * h) / CELL_SIZE) * CELL_SIZE) / 2;
    this.half = [snap(half[0]), half[1], snap(half[2])];
    this.wrap = wrap; // true: fish leaving the left/right edge re-enter opposite; false: soft side walls
    this.counts = counts;
    this.count = counts[0] + counts[1] + counts[2];
    this.time = 0;

    this.dims = this.half.map((h) => Math.ceil((2 * h) / CELL_SIZE));
    this.keys = this.dims[0] * this.dims[1] * this.dims[2] * SPECIES_COUNT;

    const S = GPUBufferUsage.STORAGE;
    const mk = (size, usage) => device.createBuffer({ size: Math.max(size, 16), usage });
    const n = this.count;
    this.pos = mk(n * 16, S | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    this.vel = mk(n * 16, S | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    this.spos = mk(n * 16, S);
    this.svel = mk(n * 16, S);
    this.cellCount = mk(this.keys * 4, S);
    this.cellStart = mk((this.keys + 1) * 4, S);
    this.keyRank = mk(n * 8, S);
    this.smoothAccel = mk(n * 16, S);
    this.params = mk(SIM_PARAMS_FLOATS * 4, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.specBuf = mk(
      SPECIES_COUNT * SIM_SPECIES_STRIDE * 4,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    );

    this.upload(counts);

    const { bgl, pipes } = simPipelines(device);
    this.pipes = pipes;
    const b = (binding, buffer) => ({ binding, resource: { buffer } });
    this.bindGroup = device.createBindGroup({
      layout: bgl,
      entries: [
        b(0, this.params),
        b(1, this.specBuf),
        b(2, this.pos),
        b(3, this.vel),
        b(4, this.spos),
        b(5, this.svel),
        b(6, this.cellCount),
        b(7, this.cellStart),
        b(8, this.keyRank),
        b(9, this.smoothAccel),
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
      posData[o + 1] = (Math.random() * 2 - 1) * this.half[1] * 0.7;
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
    this.device.queue.writeBuffer(this.specBuf, 0, packSimSpecies(this.species));
  }

  // Encodes one simulation step. Returns nothing; call sync() to wait for the GPU.
  step(dt) {
    this.time += dt;
    const q = this.device.queue;
    this.syncSpecies();
    q.writeBuffer(
      this.params,
      0,
      packSimParams({
        dt,
        time: this.time,
        count: this.count,
        maxPerCell: this.maxPerCell,
        half: this.half,
        wallMargin: WALL_MARGIN,
        cellSize: CELL_SIZE,
        dims: this.dims,
        wrap: this.wrap,
        smoothing: this.smoothing,
      })
    );

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setBindGroup(0, this.bindGroup);
    const run = (name, groups) => {
      pass.setPipeline(this.pipes[name]);
      pass.dispatchWorkgroups(groups);
    };
    const nGroups = Math.ceil(this.count / WORKGROUP_SIZE);
    if (this.mode === 'brute') {
      run('snapshot', nGroups);
      run('steerBrute', nGroups);
    } else {
      run('clearCells', Math.ceil(this.keys / WORKGROUP_SIZE));
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
    for (const k of [
      'pos',
      'vel',
      'spos',
      'svel',
      'cellCount',
      'cellStart',
      'keyRank',
      'smoothAccel',
      'params',
      'specBuf',
    ]) {
      this[k].destroy();
    }
  }
}
