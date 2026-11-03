// Draws the murmuration: painted dusk background with the flock's reflection in the lake, the flock
// as dark specks, the hawk, then reeds.
// The camera is fixed (see VIEW); only the canvas size can change.
import starlingWGSL from './starlings.wgsl?raw';
import bankWGSL from './bank.wgsl?raw';
import { lookAt, mul, perspective } from '../webgpu/mat4.js';
import {
  BANK_PARAMS_FLOATS,
  packBankParams,
  packStarlingUniforms,
  STARLING_UNIFORM_FLOATS,
} from '../webgpu/layout.js';
import { WORKGROUP_SIZE } from '../webgpu/config.js';
import { BIRD_LOOK, REFLECTION, starlingHeader, VIEW } from './config.js';

// coverage only (the lake supplies the colour); half floats because each blurred speck adds only a
// few percent and 8 bits would band
const REFLECTION_FORMAT = 'r16float';

export class StarlingRenderer {
  constructor(device, canvas) {
    this.device = device;
    this.canvas = canvas;
    this.size = [0, 0];
    this.ctx = canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device, format: this.format, alphaMode: 'opaque' });

    const module = device.createShaderModule({ code: starlingHeader() + starlingWGSL });
    module.getCompilationInfo().then((info) => {
      for (const m of info.messages) console.warn(`WGSL ${m.type} ${m.lineNum}:${m.linePos} ${m.message}`);
    });
    this.ubo = device.createBuffer({
      size: STARLING_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // premultiplied "over": dark specks pile up into solid black where the flock is dense
    const over = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
    };
    const pipeline = (vertex, fragment, blend, format = this.format) =>
      device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: vertex },
        fragment: { module, entryPoint: fragment, targets: [{ format, blend }] },
        primitive: { topology: 'triangle-list' },
      });
    this.bgPipeline = pipeline('vsBg', 'fsBg');
    this.birdPipeline = pipeline('vsBird', 'fsBird', over);
    this.hawkPipeline = pipeline('vsHawk', 'fsHawk', over);
    this.reedPipeline = pipeline('vsBg', 'fsReeds', over);
    this.birdReflectionPipeline = pipeline('vsBirdReflection', 'fsBirdCoverage', over, REFLECTION_FORMAT);
    this.hawkReflectionPipeline = pipeline('vsHawkReflection', 'fsHawkCoverage', over, REFLECTION_FORMAT);
    this.reflectionSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.hawkBindGroup = this.bindBuffers(this.hawkPipeline, [this.ubo]);
    this.hawkReflectionBindGroup = this.bindBuffers(this.hawkReflectionPipeline, [this.ubo]);
    this.reedBindGroup = this.bindBuffers(this.reedPipeline, [this.ubo]);
    const bankModule = device.createShaderModule({
      code: `const WORKGROUP_SIZE = ${WORKGROUP_SIZE}u;\n${bankWGSL}`,
    });
    this.bankPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: bankModule, entryPoint: 'trackVelocity' },
    });
    this.bankParams = device.createBuffer({
      size: BANK_PARAMS_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.boundFor = null;
  }

  // bind group 0 of `pipeline` with these buffers at bindings 0, 1, 2, ...
  bindBuffers(pipeline, list) {
    return this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: list.map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
  }

  resize(w, h) {
    w = Math.max(1, w);
    h = Math.max(1, h);
    if (this.size[0] === w && this.size[1] === h) return;
    this.size = [w, h];
    this.canvas.width = w;
    this.canvas.height = h;

    // the reflection texture follows the canvas size; the background reads it
    this.reflection?.destroy();
    this.reflection = this.device.createTexture({
      size: [Math.ceil(w * REFLECTION.scale), Math.ceil(h * REFLECTION.scale)],
      format: REFLECTION_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.reflectionView = this.reflection.createView();
    this.bgBindGroup = this.device.createBindGroup({
      layout: this.bgPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.ubo } },
        { binding: 4, resource: this.reflectionView },
        { binding: 5, resource: this.reflectionSampler },
      ],
    });
  }

  // Updates the running average of bird velocities that the bird shader banks from (bank.wgsl).
  // Call it after each boids.step(dt) with that dt.
  trackVelocities(boids, dt) {
    if (this.boundFor !== boids) this.bindBoids(boids);
    const { device } = this;
    device.queue.writeBuffer(
      this.bankParams,
      0,
      packBankParams({ dt, smoothing: BIRD_LOOK.bankSmoothing, count: boids.count })
    );
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.bankPipeline);
    pass.setBindGroup(0, this.bankBindGroup);
    pass.dispatchWorkgroups(Math.ceil(boids.count / WORKGROUP_SIZE));
    pass.end();
    device.queue.submit([enc.finish()]);
  }

  // Per-flock buffers and bind groups; the average starts at the current velocities so the first
  // frames draw birds level rather than all banked hard.
  bindBoids(boids) {
    const { device } = this;
    this.avgVel?.destroy();
    this.avgVel = device.createBuffer({
      size: boids.vel.size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(boids.vel, 0, this.avgVel, 0, boids.vel.size);
    device.queue.submit([enc.finish()]);
    // the bird and reflection pipelines read the same buffers ('auto' layouts can't share a group)
    const birdBuffers = [this.ubo, boids.pos, boids.vel, this.avgVel];
    this.birdBindGroup = this.bindBuffers(this.birdPipeline, birdBuffers);
    this.birdReflectionBindGroup = this.bindBuffers(this.birdReflectionPipeline, birdBuffers);
    this.bankBindGroup = this.bindBuffers(this.bankPipeline, [this.bankParams, boids.vel, this.avgVel]);
    this.boundFor = boids;
  }

  // hawk: { position, direction, phase } while it flies, otherwise null
  render(boids, time, hawk) {
    const { device } = this;
    if (this.boundFor !== boids) this.bindBoids(boids);

    const [w, h] = this.size;
    const proj = perspective((VIEW.fov * Math.PI) / 180, w / h, VIEW.near, VIEW.far);
    const view = lookAt(VIEW.position, VIEW.target, [0, 1, 0]);
    const tanHalfY = 1 / proj[5];
    device.queue.writeBuffer(
      this.ubo,
      0,
      packStarlingUniforms({
        viewProj: mul(proj, view),
        camera: {
          right: [view[0], view[4], view[8]],
          up: [view[1], view[5], view[9]],
          forward: [-view[2], -view[6], -view[10]],
          position: VIEW.position,
          tanHalfX: tanHalfY * (w / h),
          tanHalfY,
        },
        time,
        viewportHeight: h,
        hawk,
      })
    );

    const enc = device.createCommandEncoder();
    // the flock (and hawk) mirrored in the lake, at low resolution, for the background to sample
    const mirror = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.reflectionView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    mirror.setPipeline(this.birdReflectionPipeline);
    mirror.setBindGroup(0, this.birdReflectionBindGroup);
    mirror.draw(6, boids.count);
    if (hawk) {
      mirror.setPipeline(this.hawkReflectionPipeline);
      mirror.setBindGroup(0, this.hawkReflectionBindGroup);
      mirror.draw(6);
    }
    mirror.end();

    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.ctx.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(this.bgPipeline);
    pass.setBindGroup(0, this.bgBindGroup);
    pass.draw(3);
    pass.setPipeline(this.birdPipeline);
    pass.setBindGroup(0, this.birdBindGroup);
    pass.draw(6, boids.count);
    if (hawk) {
      pass.setPipeline(this.hawkPipeline);
      pass.setBindGroup(0, this.hawkBindGroup);
      pass.draw(6);
    }
    pass.setPipeline(this.reedPipeline);
    pass.setBindGroup(0, this.reedBindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([enc.finish()]);
  }
}
