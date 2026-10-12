import * as THREE from 'three';
import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js';
import velocityShader from './velocity.frag.glsl?raw';
import positionShader from './position.frag.glsl?raw';
import { TANK_HALF } from '../species.js';

// Per-species params pushed to the velocity shader as float[3] uniform arrays.
const SPECIES_UNIFORMS = {
  uMaxSpeed: 'maxSpeed', uMaxForce: 'maxForce',
  uSepRadius: 'sepRadius', uAliRadius: 'aliRadius', uCohRadius: 'cohRadius',
  uSepWeight: 'sepWeight', uAliWeight: 'aliWeight', uCohWeight: 'cohWeight',
  uFearRadius: 'fearRadius', uFearWeight: 'fearWeight',
  uHuntRadius: 'huntRadius', uHuntWeight: 'huntWeight',
  uWander: 'wander', uScale: 'scale',
};

export class BoidSimulation {
  constructor(renderer, size, species, mix) {
    this.size = size;
    this.count = size * size;
    this.species = species;
    this.time = 0;

    this.gpu = new GPUComputationRenderer(size, size, renderer);

    const posTex = this.gpu.createTexture();
    const velTex = this.gpu.createTexture();
    this.fillInitial(posTex.image.data, velTex.image.data, mix);

    this.velVar = this.gpu.addVariable('textureVelocity', velocityShader, velTex);
    this.posVar = this.gpu.addVariable('texturePosition', positionShader, posTex);
    this.gpu.setVariableDependencies(this.velVar, [this.posVar, this.velVar]);
    this.gpu.setVariableDependencies(this.posVar, [this.posVar, this.velVar]);

    const vu = this.velVar.material.uniforms;
    vu.uDelta = { value: 0 };
    vu.uTime = { value: 0 };
    vu.uBounds = { value: new THREE.Vector3(...TANK_HALF) };
    vu.uBoundMargin = { value: 10 };
    for (const name of Object.keys(SPECIES_UNIFORMS)) vu[name] = { value: [0, 0, 0] };
    this.posVar.material.uniforms.uDelta = { value: 0 };

    const err = this.gpu.init();
    if (err !== null) console.error('GPUComputationRenderer:', err);
    this.syncUniforms();
  }

  fillInitial(posData, velData, mix) {
    const [pS, pM] = mix;
    for (let i = 0; i < this.count; i++) {
      const r = Math.random();
      const sp = r < pS ? 0 : r < pS + pM ? 1 : 2;
      const o = i * 4;
      posData[o] = (Math.random() * 2 - 1) * TANK_HALF[0] * 0.8;
      posData[o + 1] = (Math.random() * 2 - 1) * TANK_HALF[1] * 0.8;
      posData[o + 2] = (Math.random() * 2 - 1) * TANK_HALF[2] * 0.8;
      posData[o + 3] = sp;

      // random direction at half max speed
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const speed = this.species[sp].maxSpeed * 0.5;
      velData[o] = s * Math.cos(a) * speed;
      velData[o + 1] = u * speed;
      velData[o + 2] = s * Math.sin(a) * speed;
      velData[o + 3] = Math.random() * Math.PI * 2;
    }
  }

  syncUniforms() {
    const u = this.velVar.material.uniforms;
    for (const [uniform, key] of Object.entries(SPECIES_UNIFORMS)) {
      const arr = u[uniform].value;
      for (let i = 0; i < 3; i++) arr[i] = this.species[i][key];
    }
  }

  step(dt) {
    this.time += dt;
    this.syncUniforms();
    this.velVar.material.uniforms.uDelta.value = dt;
    this.velVar.material.uniforms.uTime.value = this.time;
    this.posVar.material.uniforms.uDelta.value = dt;
    this.gpu.compute();
  }

  get positionTexture() {
    return this.gpu.getCurrentRenderTarget(this.posVar).texture;
  }

  get velocityTexture() {
    return this.gpu.getCurrentRenderTarget(this.velVar).texture;
  }

  dispose() {
    this.gpu.dispose();
  }
}
