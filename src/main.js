import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SPECIES, DEFAULT_COUNTS, TANK_HALF } from './species.js';
import { BoidSimulation } from './sim/BoidSimulation.js';
import { FishSchool } from './render/FishSchool.js';
import { createGui } from './gui.js';

// shader colors are authored as raw sRGB values, so skip three's color conversion
THREE.ColorManagement.enabled = false;

const BG = '#04121f';
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(BG);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.5, 600);
camera.position.set(0, 25, 120);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const tank = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(TANK_HALF[0] * 2, TANK_HALF[1] * 2, TANK_HALF[2] * 2)),
  new THREE.LineBasicMaterial({ color: 0x2f6f9f, transparent: true, opacity: 0.6 })
);
scene.add(tank);

const settings = {
  size: 64,
  speed: 1,
  paused: false,
  showTank: true,
  fogDensity: 0.006,
  mediumCount: DEFAULT_COUNTS.medium,
  largeCount: DEFAULT_COUNTS.large,
};

let sim = null;
let school = null;

function rebuild() {
  if (school) {
    scene.remove(school.mesh);
    school.dispose();
    sim.dispose();
  }
  const total = Number(settings.size) ** 2;
  const large = Math.min(settings.largeCount, total);
  const medium = Math.min(settings.mediumCount, total - large);
  sim = new BoidSimulation(renderer, Number(settings.size), SPECIES, [total - medium - large, medium, large]);
  school = new FishSchool(sim, SPECIES);
  scene.add(school.mesh);
}

createGui(settings, SPECIES, {
  rebuild,
  toggleTank: () => { tank.visible = settings.showTank; },
});
rebuild();

const stats = document.getElementById('stats');
let frames = 0;
let acc = 0;
let last = performance.now();

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  const raw = (now - last) / 1000;
  last = now;
  const dt = Math.min(raw, 1 / 30);

  if (!settings.paused) sim.step(dt * settings.speed);
  school.material.uniforms.uFogDensity.value = settings.fogDensity;
  school.update();

  controls.update();
  renderer.render(scene, camera);

  frames++;
  acc += raw;
  if (acc >= 0.5) {
    stats.textContent = `${Math.round(frames / acc)} fps\n${sim.count.toLocaleString()} fish`;
    frames = 0;
    acc = 0;
  }
}
frame();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
