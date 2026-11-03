// Draws the murmuration: painted dusk background, the flock as dark specks, the hawk, then reeds.
// The camera is fixed (see VIEW); only the canvas size can change.
import starlingWGSL from './starlings.wgsl?raw';
import { lookAt, mul, perspective } from '../webgpu/mat4.js';
import { packStarlingUniforms, STARLING_UNIFORM_FLOATS } from '../webgpu/layout.js';
import { starlingHeader, VIEW } from './config.js';

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
    const pipeline = (vertex, fragment, blend) =>
      device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: vertex },
        fragment: { module, entryPoint: fragment, targets: [{ format: this.format, blend }] },
        primitive: { topology: 'triangle-list' },
      });
    this.bgPipeline = pipeline('vsBg', 'fsBg');
    this.birdPipeline = pipeline('vsBird', 'fsBird', over);
    this.hawkPipeline = pipeline('vsHawk', 'fsHawk', over);
    this.reedPipeline = pipeline('vsBg', 'fsReeds', over);
    const uniformsOnly = (p) =>
      device.createBindGroup({
        layout: p.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: this.ubo } }],
      });
    this.bgBindGroup = uniformsOnly(this.bgPipeline);
    this.hawkBindGroup = uniformsOnly(this.hawkPipeline);
    this.reedBindGroup = uniformsOnly(this.reedPipeline);
    this.boundFor = null;
  }

  resize(w, h) {
    w = Math.max(1, w);
    h = Math.max(1, h);
    if (this.size[0] === w && this.size[1] === h) return;
    this.size = [w, h];
    this.canvas.width = w;
    this.canvas.height = h;
  }

  // hawk: { position, direction, phase } while it flies, otherwise null
  render(boids, time, hawk) {
    const { device } = this;
    if (this.boundFor !== boids) {
      this.birdBindGroup = device.createBindGroup({
        layout: this.birdPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.ubo } },
          { binding: 1, resource: { buffer: boids.pos } },
          { binding: 2, resource: { buffer: boids.vel } },
        ],
      });
      this.boundFor = boids;
    }

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
