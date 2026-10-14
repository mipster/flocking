import renderWGSL from './render.wgsl?raw';
import { buildFishVertices } from './fishGeometry.js';
import { causticsWGSL } from './caustics.js';
import { FLOOR, floorWGSL } from './floor.js';
import { packRenderSpecies, packRenderUniforms, RENDER_UNIFORM_FLOATS } from './layout.js';
import {
  CAMERA,
  DEFAULT_MURKINESS,
  DEFAULT_SHAFT_STRENGTH,
  DEFAULT_SNOW_AMOUNT,
  FISH_LOD,
  FLOOR_MESH,
  LIGHT_DIRECTION,
  SHAFTS,
  SNOW,
  SPECIES_COUNT,
  WORKGROUP_SIZE,
  WATER,
  WAVE_AMPLITUDE_TOTAL,
  wgslHeader,
} from './config.js';

const DEPTH_FORMAT = 'depth24plus';
const DEFAULT_SAMPLES = 4; // WebGPU allows 1 or 4
const SHAFT_FORMAT = 'rgba16float';

// column-major 4x4 helpers (WebGPU clip space: z in [0, 1])
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far * nf, -1, 0, 0, near * far * nf, 0]);
}

function lookAt(eye, target, upv) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = (a) => {
    const l = Math.hypot(...a);
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = norm(sub(eye, target));
  const x = norm(cross(upv, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0],
    y[0],
    z[0],
    0,
    x[1],
    y[1],
    z[1],
    0,
    x[2],
    y[2],
    z[2],
    0,
    -dot(x, eye),
    -dot(y, eye),
    -dot(z, eye),
    1,
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
  constructor(device, canvas, species, { samples = DEFAULT_SAMPLES } = {}) {
    this.samples = samples;
    this.device = device;
    this.canvas = canvas;
    this.species = species;
    this.murkiness = DEFAULT_MURKINESS;
    this.shaftStrength = DEFAULT_SHAFT_STRENGTH;
    this.snowAmount = DEFAULT_SNOW_AMOUNT;
    // orbit camera
    this.yaw = 0;
    this.pitch = CAMERA.startPitch;
    this.dist = CAMERA.startDistance;
    this.targetY = 0; // height the camera orbits and looks at; the viewer sets it every frame

    this.ctx = canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device, format: this.format, alphaMode: 'opaque' });

    const makeMesh = (detail) => {
      const verts = buildFishVertices(detail);
      const vbo = device.createBuffer({
        size: verts.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(vbo, 0, verts);
      return { vbo, vertexCount: verts.length / 6 };
    };
    this.meshes = { simple: makeMesh('simple'), full: makeMesh('full') };

    this.ubo = device.createBuffer({
      size: RENDER_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.spBuf = device.createBuffer({
      size: SPECIES_COUNT * 2 * 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const module = device.createShaderModule({ code: wgslHeader() + floorWGSL + causticsWGSL + renderWGSL });
    module.getCompilationInfo().then((info) => {
      for (const m of info.messages) console.warn(`WGSL ${m.type} ${m.lineNum}:${m.linePos} ${m.message}`);
    });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: 24,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
      multisample: { count: this.samples },
    });

    this.floorPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vsFloor' },
      fragment: { module, entryPoint: 'fsFloor', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
      multisample: { count: this.samples },
    });
    // backdrop gradient, drawn first and never writing depth
    this.bgPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vsBg' },
      fragment: { module, entryPoint: 'fsBg', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'always' },
      multisample: { count: this.samples },
    });
    this.bgBindGroup = device.createBindGroup({
      layout: this.bgPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.ubo } }],
    });

    // translucent water surface, drawn last; premultiplied alpha so it can fade out at its edge
    const premultiplied = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
    };
    this.surfacePipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vsSurface' },
      fragment: {
        module,
        entryPoint: 'fsSurface',
        targets: [{ format: this.format, blend: premultiplied }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'less' },
      multisample: { count: this.samples },
    });
    // marine snow: tiny soft quads, premultiplied alpha, depth-tested but not written
    this.snowPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vsSnow' },
      fragment: {
        module,
        entryPoint: 'fsSnow',
        targets: [{ format: this.format, blend: premultiplied }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'less' },
      multisample: { count: this.samples },
    });
    this.snowBindGroup = device.createBindGroup({
      layout: this.snowPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.ubo } }],
    });
    this.surfaceBindGroup = device.createBindGroup({
      layout: this.surfacePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.ubo } }],
    });

    // light shafts: march the view rays into a reduced-size image, then add it to the frame
    const single = { count: 1 };
    this.shaftPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vsBg' },
      fragment: { module, entryPoint: 'fsShaft', targets: [{ format: SHAFT_FORMAT }] },
      primitive: { topology: 'triangle-list' },
      multisample: single,
    });
    const additive = {
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
    };
    this.compositePipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vsBg' },
      fragment: {
        module,
        entryPoint: 'fsComposite',
        targets: [{ format: this.format, blend: additive }],
      },
      primitive: { topology: 'triangle-list' },
      multisample: single,
    });
    this.shaftBindGroup = device.createBindGroup({
      layout: this.shaftPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.ubo } }],
    });
    this.shaftSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    this.shadePipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'fishShade' },
    });
    this.floorBindGroup = device.createBindGroup({
      layout: this.floorPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.ubo } }],
    });

    this.size = [0, 0];
    this.drawGroups = null;
    this.drawArgs = device.createBuffer({
      size: 32,
      usage:
        GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.boundFor = null;
  }

  resize(w, h) {
    if (this.size[0] === w && this.size[1] === h) return;
    this.size = [w, h];
    this.canvas.width = w;
    this.canvas.height = h;
    this.colorTex?.destroy();
    this.depthTex?.destroy();
    this.shaftTex?.destroy();
    const usage = GPUTextureUsage.RENDER_ATTACHMENT;
    // without multisampling the scene is drawn straight into the canvas texture
    this.colorTex =
      this.samples > 1
        ? this.device.createTexture({ size: [w, h], format: this.format, sampleCount: this.samples, usage })
        : null;
    this.depthTex = this.device.createTexture({
      size: [w, h],
      format: DEPTH_FORMAT,
      sampleCount: this.samples,
      usage,
    });
    this.shaftTex = this.device.createTexture({
      size: [Math.max(1, Math.round(w * SHAFTS.scale)), Math.max(1, Math.round(h * SHAFTS.scale))],
      format: SHAFT_FORMAT,
      usage: usage | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.compositeBindGroup = this.device.createBindGroup({
      layout: this.compositePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 11, resource: this.shaftTex.createView() },
        { binding: 12, resource: this.shaftSampler },
      ],
    });
  }

  // storage for the indices of visible fish, at least one slot so binding is always valid
  makeList(capacity) {
    return this.device.createBuffer({
      size: Math.max(capacity, 1) * 4,
      usage: GPUBufferUsage.STORAGE,
    });
  }

  updateSpecies() {
    this.device.queue.writeBuffer(this.spBuf, 0, packRenderSpecies(this.species));
  }

  // Per-layer switches for profiling (the viewer exposes them under ?debug).
  layers = { floor: true, fish: true, surface: true, floorCaustics: true, cull: true, snow: true };

  // `time` (seconds) drives the waves.
  render(boids, time) {
    const { device } = this;
    if (this.boundFor !== boids) {
      this.shadeBuf?.destroy();
      this.shadeBuf = device.createBuffer({
        size: Math.max(boids.count * 32, 32),
        usage: GPUBufferUsage.STORAGE,
      });
      // fish are stored in species order: the first species get the light mesh
      const nSimple = boids.counts.slice(0, FISH_LOD.simpleSpecies).reduce((a, b) => a + b, 0);
      const lists = {
        simple: this.makeList(nSimple),
        full: this.makeList(boids.count - nSimple),
      };
      this.visibleLists?.forEach((b) => b.destroy());
      this.visibleLists = [lists.simple, lists.full];
      this.shadeBindGroup = device.createBindGroup({
        layout: this.shadePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.ubo } },
          { binding: 1, resource: { buffer: boids.pos } },
          { binding: 3, resource: { buffer: this.spBuf } },
          { binding: 5, resource: { buffer: this.shadeBuf } },
          { binding: 7, resource: { buffer: lists.simple } },
          { binding: 8, resource: { buffer: lists.full } },
          { binding: 9, resource: { buffer: this.drawArgs } },
        ],
      });
      const drawGroup = (list) =>
        device.createBindGroup({
          layout: this.pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.ubo } },
            { binding: 1, resource: { buffer: boids.pos } },
            { binding: 2, resource: { buffer: boids.vel } },
            { binding: 3, resource: { buffer: this.spBuf } },
            { binding: 4, resource: { buffer: this.shadeBuf } },
            { binding: 6, resource: { buffer: list } },
          ],
        });
      this.drawGroups = { simple: drawGroup(lists.simple), full: drawGroup(lists.full) };
      this.boundFor = boids;
    }
    this.updateSpecies();

    const aspect = this.size[0] / this.size[1];
    const cp = Math.cos(this.pitch);
    // keep the camera above the highest dune so it never ends up under the sand
    const half = boids.half;
    const lowestEyeY = -half[1] + FLOOR.lift + FLOOR.amplitudes.reduce((a, b) => a + b, 0) + 1;
    const eye = [
      Math.sin(this.yaw) * cp * this.dist,
      Math.max(this.targetY + Math.sin(this.pitch) * this.dist, lowestEyeY),
      Math.cos(this.yaw) * cp * this.dist,
    ];
    // shafts are only drawn from under the water
    const useShafts = this.shaftStrength > 0 && eye[1] < half[1] + WAVE_AMPLITUDE_TOTAL;
    const proj = perspective((CAMERA.fovDegrees * Math.PI) / 180, aspect, CAMERA.near, CAMERA.far);

    // the floor mesh covers several tank widths so wrapped fish always have sand beneath them
    const { tiles, spacing, maxCells } = FLOOR_MESH;
    const spanX = half[0] * 2 * tiles;
    const spanZ = half[2] * 2 * tiles;
    const cols = Math.min(maxCells, Math.ceil(spanX / spacing));
    const rows = Math.min(maxCells, Math.ceil(spanZ / spacing));

    // view basis comes straight from the view matrix rows (camera looks down -z)
    const view = lookAt(eye, [0, this.targetY, 0], [0, 1, 0]);
    const tanHalfY = 1 / proj[5];

    device.queue.writeBuffer(
      this.ubo,
      0,
      packRenderUniforms({
        viewProj: mul(proj, view),
        light: LIGHT_DIRECTION,
        absorption: WATER.absorption.map((a) => a * this.murkiness),
        half,
        surfaceY: half[1] + WAVE_AMPLITUDE_TOTAL,
        time,
        floorCaustics: this.layers.floorCaustics,
        cull: this.layers.cull,
        shaftStrength: useShafts ? this.shaftStrength : 0,
        floorGrid: [cols, rows, spanX, spanZ],
        camera: {
          right: [view[0], view[4], view[8]],
          up: [view[1], view[5], view[9]],
          forward: [-view[2], -view[6], -view[10]],
          position: eye,
          tanHalfX: tanHalfY * aspect,
          tanHalfY,
        },
      })
    );

    const enc = device.createCommandEncoder();
    if (this.layers.fish) {
      // reset the instance counts the culling pass appends to
      device.queue.writeBuffer(
        this.drawArgs,
        0,
        new Uint32Array([this.meshes.simple.vertexCount, 0, 0, 0, this.meshes.full.vertexCount, 0, 0, 0])
      );
      const compute = enc.beginComputePass();
      compute.setPipeline(this.shadePipeline);
      compute.setBindGroup(0, this.shadeBindGroup);
      compute.dispatchWorkgroups(Math.ceil(boids.count / WORKGROUP_SIZE));
      compute.end();
    }
    const canvasTex = this.ctx.getCurrentTexture();
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: (this.colorTex ?? canvasTex).createView(),
          resolveTarget: this.colorTex ? canvasTex.createView() : undefined,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: this.colorTex ? 'discard' : 'store',
        },
      ],
      depthStencilAttachment: {
        view: this.depthTex.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
      },
    });
    pass.setPipeline(this.bgPipeline);
    pass.setBindGroup(0, this.bgBindGroup);
    pass.draw(3);
    if (this.layers.floor) {
      pass.setPipeline(this.floorPipeline);
      pass.setBindGroup(0, this.floorBindGroup);
      pass.draw(cols * rows * 6);
    }
    if (this.layers.fish) {
      pass.setPipeline(this.pipeline);
      // survivors of the culling pass; instance counts live in drawArgs
      pass.setBindGroup(0, this.drawGroups.simple);
      pass.setVertexBuffer(0, this.meshes.simple.vbo);
      pass.drawIndirect(this.drawArgs, 0);
      pass.setBindGroup(0, this.drawGroups.full);
      pass.setVertexBuffer(0, this.meshes.full.vbo);
      pass.drawIndirect(this.drawArgs, 16);
    }
    const snowCount = Math.round(SNOW.count * this.snowAmount);
    if (this.layers.snow && snowCount > 0 && eye[1] < half[1] + WAVE_AMPLITUDE_TOTAL) {
      pass.setPipeline(this.snowPipeline);
      pass.setBindGroup(0, this.snowBindGroup);
      pass.draw(6, snowCount);
    }
    if (this.layers.surface) {
      pass.setPipeline(this.surfacePipeline);
      pass.setBindGroup(0, this.surfaceBindGroup);
      pass.draw(cols * rows * 6);
    }
    pass.end();

    if (useShafts) {
      const shafts = enc.beginRenderPass({
        colorAttachments: [
          {
            view: this.shaftTex.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      shafts.setPipeline(this.shaftPipeline);
      shafts.setBindGroup(0, this.shaftBindGroup);
      shafts.draw(3);
      shafts.end();

      const composite = enc.beginRenderPass({
        colorAttachments: [{ view: canvasTex.createView(), loadOp: 'load', storeOp: 'store' }],
      });
      composite.setPipeline(this.compositePipeline);
      composite.setBindGroup(0, this.compositeBindGroup);
      composite.draw(3);
      composite.end();
    }
    device.queue.submit([enc.finish()]);
  }
}
