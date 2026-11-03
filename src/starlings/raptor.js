// The hawk (the file is not called hawk.js because ad blockers such as Brave Shields block that
// name): not part of the simulated flock but a scripted predator. Every so often it makes one
// curved pass (a quadratic Bezier) through the flock: it starts high and far to one side, dives
// through a point near the flock centre and climbs out the other side. The starlings see its
// position and velocity (passed to the sim as the external predator).
import { HAWK } from './config.js';

const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/** Point and tangent of the quadratic Bezier (start, control, end) at u in [0, 1]. */
export function bezier({ start, control, end }, u) {
  const p = lerp(lerp(start, control, u), lerp(control, end, u), u);
  const d = start.map((s, i) => 2 * (1 - u) * (control[i] - s) + 2 * u * (end[i] - control[i]));
  return { position: p, tangent: d };
}

/**
 * Plans one pass through the flock at `target` moving at `velocity`: it aims where the flock will
 * be when the hawk gets there (about approach / speed seconds later). `rng` returns [0, 1).
 */
export function planAttack(target, rng, cfg = HAWK, velocity = [0, 0, 0]) {
  const side = rng() < 0.5 ? -1 : 1;
  const angle = (rng() - 0.5) * 1.2; // how far the approach swings toward or away from the viewer
  const lead = cfg.approach / cfg.speed;
  const aim = target.map((t, i) => t + velocity[i] * lead + (rng() * 2 - 1) * cfg.aimJitter);
  const start = [
    aim[0] + side * Math.cos(angle) * cfg.approach,
    aim[1] + cfg.height * (0.6 + 0.8 * rng()),
    aim[2] + Math.sin(angle) * cfg.approach,
  ];
  // leave on the far side, a little lower than it came in, then climb away
  const end = [2 * aim[0] - start[0], aim[1] + cfg.height * 0.3 * rng(), 2 * aim[2] - start[2]];
  // control point chosen so the curve passes through `aim` halfway
  const control = aim.map((a, i) => 2 * a - 0.5 * (start[i] + end[i]));
  const path = { start, control, end };
  let length = 0;
  let prev = start;
  for (let k = 1; k <= 16; k++) {
    const p = bezier(path, k / 16).position;
    length += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
    prev = p;
  }
  return { ...path, aim, duration: length / cfg.speed };
}

export class Hawk {
  constructor(cfg = HAWK, rng = Math.random) {
    this.cfg = cfg;
    this.rng = rng;
    this.attack = null;
    this.auto = true; // when on, a new pass starts a random interval after the last one
    this.nextAt = cfg.firstDelay;
  }

  /** Start a pass at the next update (ignored while one is under way). */
  send(time) {
    if (!this.attack) this.nextAt = time;
  }

  /** Turns automatic passes on or off; an attack already under way finishes either way. */
  setAuto(on, time) {
    this.auto = on;
    if (!this.attack) this.nextAt = on ? time + this.cfg.firstDelay : Infinity;
  }

  /**
   * Advances to `time`; returns { position, direction } while flying, otherwise null. `target` and
   * `velocity` describe the flock, used when a new pass is planned.
   */
  update(time, target, velocity = [0, 0, 0]) {
    if (!this.attack && time >= this.nextAt) {
      this.attack = { ...planAttack(target, this.rng, this.cfg, velocity), t0: time };
    }
    if (!this.attack) return null;
    const u = (time - this.attack.t0) / this.attack.duration;
    if (u >= 1) {
      this.attack = null;
      const [lo, hi] = this.cfg.interval;
      this.nextAt = this.auto ? time + lo + (hi - lo) * this.rng() : Infinity;
      return null;
    }
    const { position, tangent } = bezier(this.attack, u);
    const len = Math.hypot(...tangent) || 1;
    // u runs at a constant rate, so the true speed varies along the curve: tangent / duration
    const own = tangent.map((v) => v / this.attack.duration);
    return { position, direction: tangent.map((v) => v / len), velocity: own };
  }
}
