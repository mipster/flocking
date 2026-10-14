import * as THREE from 'three';
import vertexShader from './fish.vert.glsl?raw';
import fragmentShader from './fish.frag.glsl?raw';

// Low-poly fish, length 1 along local +x (head at +0.5), y up, z side. Flat shaded, ~70 tris.
export function buildFishGeometry() {
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const tris = [];
  const SEG = 6;

  // [x, half-height, half-width]
  const stations = [
    [0.42, 0.06, 0.05],
    [0.25, 0.14, 0.09],
    [0.0, 0.18, 0.11],
    [-0.2, 0.13, 0.08],
    [-0.38, 0.05, 0.035],
  ];
  const rings = stations.map(([x, rh, rw]) =>
    Array.from({ length: SEG }, (_, k) => {
      const a = (k / SEG) * Math.PI * 2;
      return V(x, rh * Math.cos(a), rw * Math.sin(a));
    })
  );
  const nose = V(0.5, 0, 0);
  const tailPoint = V(-0.4, 0, 0);

  // orient a triangle so its normal points away from the body axis
  const addBody = (a, b, c) => {
    const n = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a));
    const cen = a.clone().add(b).add(c).divideScalar(3);
    const radial = V(0, cen.y, cen.z);
    tris.push(n.dot(radial) >= 0 ? [a, b, c] : [a, c, b]);
  };
  const addFlat = (a, b, c) => tris.push([a, b, c]);

  for (let k = 0; k < SEG; k++) {
    const k1 = (k + 1) % SEG;
    addBody(nose, rings[0][k], rings[0][k1]);
    for (let r = 0; r < rings.length - 1; r++) {
      addBody(rings[r][k], rings[r + 1][k], rings[r + 1][k1]);
      addBody(rings[r][k], rings[r + 1][k1], rings[r][k1]);
    }
    addBody(rings[rings.length - 1][k], tailPoint, rings[rings.length - 1][k1]);
  }

  // forked tail fin (flat, double-sided in the material)
  addFlat(V(-0.38, 0, 0), V(-0.64, 0.22, 0), V(-0.54, 0, 0));
  addFlat(V(-0.38, 0, 0), V(-0.54, 0, 0), V(-0.64, -0.22, 0));
  // dorsal fin
  addFlat(V(0.12, 0.16, 0), V(-0.1, 0.17, 0), V(-0.14, 0.31, 0));

  const positions = new Float32Array(tris.length * 9);
  tris.forEach((t, i) => t.forEach((v, j) => v.toArray(positions, i * 9 + j * 3)));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals(); // non-indexed -> flat normals
  return geo;
}

export class FishSchool {
  constructor(sim, species) {
    this.sim = sim;
    this.species = species;

    const base = buildFishGeometry();
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('normal', base.getAttribute('normal'));
    geo.instanceCount = sim.count;

    const size = sim.size;
    const refs = new Float32Array(sim.count * 2);
    for (let i = 0; i < sim.count; i++) {
      refs[i * 2] = ((i % size) + 0.5) / size;
      refs[i * 2 + 1] = (Math.floor(i / size) + 0.5) / size;
    }
    geo.setAttribute('aRef', new THREE.InstancedBufferAttribute(refs, 2));

    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      side: THREE.DoubleSide,
      uniforms: {
        uTexPos: { value: null },
        uTexVel: { value: null },
        uScale: { value: [1, 1, 1] },
        uColor: { value: species.map(() => new THREE.Vector3()) },
        uTailAmp: { value: 0.14 },
        uTailK: { value: 7.0 },
        uLightDir: { value: new THREE.Vector3(0.3, 1.0, 0.4).normalize() },
        uFogColor: { value: new THREE.Color('#04121f') },
        uFogDensity: { value: 0.006 },
      },
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
  }

  update() {
    const u = this.material.uniforms;
    u.uTexPos.value = this.sim.positionTexture;
    u.uTexVel.value = this.sim.velocityTexture;
    const c = new THREE.Color();
    this.species.forEach((s, i) => {
      u.uScale.value[i] = s.scale;
      c.set(s.color);
      u.uColor.value[i].set(c.r, c.g, c.b);
    });
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
