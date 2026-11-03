import { describe, expect, it } from 'vitest';
import { makeRng } from '../webgpu/scenery.js';
import { HAWK } from './config.js';
import { Hawk, bezier, planAttack } from './raptor.js';

const target = [0, 26, 0];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('planAttack', () => {
  const attack = planAttack(target, makeRng(1));

  it('passes through its aim point halfway, near the flock centre', () => {
    expect(dist(bezier(attack, 0.5).position, attack.aim)).toBeLessThan(1e-9);
    expect(dist(attack.aim, target)).toBeLessThanOrEqual(HAWK.aimJitter * Math.sqrt(3));
  });

  it('starts and ends well outside the flock, diving in from above', () => {
    expect(dist(attack.start, target)).toBeGreaterThan(HAWK.approach * 0.8);
    expect(dist(attack.end, target)).toBeGreaterThan(HAWK.approach * 0.8);
    expect(attack.start[1]).toBeGreaterThan(attack.aim[1]);
  });

  it('leads a moving flock: aims where it will be, not where it is', () => {
    const still = planAttack(target, makeRng(5));
    const moving = planAttack(target, makeRng(5), HAWK, [10, 0, 0]);
    expect(moving.aim[0] - still.aim[0]).toBeCloseTo((10 * HAWK.approach) / HAWK.speed, 6);
  });

  it('takes as long as its length at hawk speed', () => {
    expect(attack.duration).toBeGreaterThan((2 * HAWK.approach * 0.8) / HAWK.speed);
    expect(attack.duration).toBeLessThan((4 * HAWK.approach) / HAWK.speed);
  });
});

describe('Hawk', () => {
  it('waits, flies one pass with a unit heading, then waits again', () => {
    const hawk = new Hawk(HAWK, makeRng(2));
    expect(hawk.update(HAWK.firstDelay - 0.1, target)).toBeNull();
    const flying = hawk.update(HAWK.firstDelay, target);
    expect(flying).not.toBeNull();
    expect(Math.hypot(...flying.direction)).toBeCloseTo(1, 6);
    const end = HAWK.firstDelay + hawk.attack.duration + 0.01;
    expect(hawk.update(end, target)).toBeNull();
    expect(hawk.nextAt).toBeGreaterThanOrEqual(end + HAWK.interval[0]);
    expect(hawk.nextAt).toBeLessThanOrEqual(end + HAWK.interval[1]);
  });

  it('only flies when sent while automatic passes are off', () => {
    const hawk = new Hawk(HAWK, makeRng(3));
    hawk.setAuto(false, 0);
    expect(hawk.update(100, target)).toBeNull();
    hawk.send(100);
    expect(hawk.update(100, target)).not.toBeNull();
  });
});
