// Where the flock is: copies the first `samples` birds' positions and velocities back from the GPU
// (they start randomly placed, so they are a fair sample) and averages them. Asynchronous and
// throttled by the caller, so it never stalls a frame; the hawk aims with the latest estimate.
export class FlockSampler {
  constructor(device, samples = 256) {
    this.device = device;
    this.samples = samples;
    const usage = GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST;
    this.posRead = device.createBuffer({ size: samples * 16, usage });
    this.velRead = device.createBuffer({ size: samples * 16, usage });
    this.busy = false;
    this.center = null; // mean position, once the first readback lands
    this.velocity = [0, 0, 0]; // mean velocity
  }

  request(boids) {
    if (this.busy) return;
    this.busy = true;
    const n = Math.min(this.samples, boids.count);
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(boids.pos, 0, this.posRead, 0, n * 16);
    enc.copyBufferToBuffer(boids.vel, 0, this.velRead, 0, n * 16);
    this.device.queue.submit([enc.finish()]);
    Promise.all([this.posRead.mapAsync(GPUMapMode.READ), this.velRead.mapAsync(GPUMapMode.READ)])
      .then(() => {
        this.center = meanXyz(new Float32Array(this.posRead.getMappedRange()), n);
        this.velocity = meanXyz(new Float32Array(this.velRead.getMappedRange()), n);
        this.posRead.unmap();
        this.velRead.unmap();
      })
      .catch(() => {}) // device lost or page closing: keep the last estimate
      .finally(() => {
        this.busy = false;
      });
  }
}

/** Mean of the xyz parts of the first `n` vec4s in `data`. */
export function meanXyz(data, n) {
  const sum = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) sum[k] += data[i * 4 + k];
  return sum.map((s) => s / Math.max(n, 1));
}
