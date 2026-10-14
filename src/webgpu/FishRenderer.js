import floorWGSL from './floor.wgsl?raw';
import renderWGSL from './render.wgsl?raw';
import { buildFishVertices } from './fishGeometry.js';

const DEPTH_FORMAT = 'depth24plus';
const SAMPLES = 4;

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// column-major 4x4 helpers (WebGPU clip space: z in [0, 1])
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far * nf, -1, 0, 0, near * far * nf, 0]);
}

function lookAt(eye, target, upv) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = (a) => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = norm(sub(eye, target));
  const x = norm(cross(upv, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

export class FishRenderer {
  constructor(device, canvas, species) {
    this.device = device;
    this.canvas = canvas;
    this.species = species;
    this.fogColor = [4 / 255, 18 / 255, 31 / 255];
    this.fogDensity = 0.006;
    // orbit camera
    this.yaw = 0;
    this.pitch = 0.2;
    this.dist = 260;

    this.ctx = canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device, format: this.format, alphaMode: 'opaque' });

    const verts = buildFishVertices();
    this.vertexCount = verts.length / 6;
    this.vbo = device.createBuffer({ size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.vbo, 0, verts);

    this.ubo = device.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.spBuf = device.createBuffer({ size: 6 * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const module = device.createShaderModule({ code: floorWGSL + renderWGSL });
    module.getCompilationInfo().then((info) => {
      for (const m of info.messages) console.warn(`WGSL ${m.type} ${m.lineNum}:${m.linePos} ${m.message}`);
    });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module, entryPoint: 'vs',
        buffers: [{
          arrayStride: 24,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
          ],
        }],
      },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
      multisample: { count: SAMPLES },
    });

    this.floorPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vsFloor' },
      fragment: { module, entryPoint: 'fsFloor', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
      multisample: { count: SAMPLES },
    });
    this.floorBindGroup = device.createBindGroup({
      layout: this.floorPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.ubo } }],
    });

    this.size = [0, 0];
    this.bindGroup = null;
    this.boundFor = null;
  }

  resize(w, h) {
    if (this.size[0] === w && this.size[1] === h) return;
    this.size = [w, h];
    this.canvas.width = w;
    this.canvas.height = h;
    this.colorTex?.destroy();
    this.depthTex?.destroy();
    const usage = GPUTextureUsage.RENDER_ATTACHMENT;
    this.colorTex = this.device.createTexture({ size: [w, h], format: this.format, sampleCount: SAMPLES, usage });
    this.depthTex = this.device.createTexture({ size: [w, h], format: DEPTH_FORMAT, sampleCount: SAMPLES, usage });
  }

  updateSpecies() {
    const d = new Float32Array(24);
    this.species.forEach((s, i) => {
      d.set([s.scale, 0, 0, 0], i * 8);
      d.set([...hexToRgb(s.color), 0], i * 8 + 4);
    });
    this.device.queue.writeBuffer(this.spBuf, 0, d);
  }

  render(boids) {
    const { device } = this;
    if (this.boundFor !== boids) {
      this.bindGroup = device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.ubo } },
          { binding: 1, resource: { buffer: boids.pos } },
          { binding: 2, resource: { buffer: boids.vel } },
          { binding: 3, resource: { buffer: this.spBuf } },
        ],
      });
      this.boundFor = boids;
    }
    this.updateSpecies();

    const aspect = this.size[0] / this.size[1];
    const cp = Math.cos(this.pitch);
    const eye = [Math.sin(this.yaw) * cp * this.dist, Math.sin(this.pitch) * this.dist, Math.cos(this.yaw) * cp * this.dist];
    const vp = mul(perspective(55 * Math.PI / 180, aspect, 1, 3000), lookAt(eye, [0, 0, 0], [0, 1, 0]));
    const light = [0.3, 1.0, 0.4];
    const ll = Math.hypot(...light);
    // the floor mesh covers 3x3 tank widths so wrapped fish always have sand beneath them
    const half = boids.half;
    const spanX = half[0] * 6;
    const spanZ = half[2] * 6;
    const cols = Math.min(500, Math.ceil(spanX / 3));
    const rows = Math.min(500, Math.ceil(spanZ / 3));
    const u = new Float32Array(32);
    u.set(vp, 0);
    u.set([light[0] / ll, light[1] / ll, light[2] / ll, 0], 16);
    u.set([...this.fogColor, this.fogDensity], 20);
    u.set([half[0], half[1], half[2], 0], 24);
    u.set([cols, rows, spanX, spanZ], 28);
    device.queue.writeBuffer(this.ubo, 0, u);

    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: this.colorTex.createView(),
        resolveTarget: this.ctx.getCurrentTexture().createView(),
        clearValue: { r: this.fogColor[0], g: this.fogColor[1], b: this.fogColor[2], a: 1 },
        loadOp: 'clear', storeOp: 'discard',
      }],
      depthStencilAttachment: {
        view: this.depthTex.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard',
      },
    });
    pass.setPipeline(this.floorPipeline);
    pass.setBindGroup(0, this.floorBindGroup);
    pass.draw(cols * rows * 6);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.vbo);
    pass.draw(this.vertexCount, boids.count);
    pass.end();
    device.queue.submit([enc.finish()]);
  }
}
