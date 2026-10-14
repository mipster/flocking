// Species 0 = small, 1 = medium, 2 = large. Index order matters: a fish fears
// any neighbor with a higher index and (optionally) hunts any with a lower one.
export const SPECIES = [
  {
    name: 'Small', color: '#ffb347', scale: 1.2,
    maxSpeed: 16, maxForce: 40,
    sepRadius: 1.6, aliRadius: 7, cohRadius: 15,
    sepWeight: 1.6, aliWeight: 1.0, cohWeight: 1.4,
    fearRadius: 16, fearWeight: 3.0,
    huntRadius: 0, huntWeight: 0,
    wander: 0.1,
  },
  {
    name: 'Medium', color: '#5cc8ff', scale: 2.6,
    maxSpeed: 11, maxForce: 24,
    sepRadius: 3.0, aliRadius: 9, cohRadius: 13,
    sepWeight: 1.6, aliWeight: 1.0, cohWeight: 0.8,
    fearRadius: 20, fearWeight: 2.5,
    huntRadius: 0, huntWeight: 0,
    wander: 0.15,
  },
  {
    name: 'Large', color: '#c9d6e3', scale: 7.0,
    maxSpeed: 6, maxForce: 8,
    sepRadius: 10, aliRadius: 18, cohRadius: 24,
    sepWeight: 1.5, aliWeight: 0.5, cohWeight: 0.3,
    fearRadius: 0, fearWeight: 0,
    huntRadius: 30, huntWeight: 0.4,
    wander: 0.5,
  },
];

// default absolute numbers of medium / large fish; the rest are small
export const DEFAULT_COUNTS = { medium: 300, large: 8 };
export const TANK_HALF = [60, 30, 40];
