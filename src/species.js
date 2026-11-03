// Species 0 = small, 1 = medium, 2 = large. Index order matters: a fish fears
// any neighbor with a higher index and (optionally) hunts any with a lower one.
export const SPECIES = [
  {
    name: 'Small',
    color: '#ffb347',
    scale: 1.2,
    maxSpeed: 16,
    maxForce: 40,
    sepRadius: 1.6,
    aliRadius: 7,
    cohRadius: 15,
    sepWeight: 1.6,
    aliWeight: 1.0,
    cohWeight: 1.4,
    fearRadius: 16,
    fearWeight: 3.0,
    huntRadius: 0,
    huntWeight: 0,
    wander: 0.1,
    glint: 1.0,
  },
  {
    name: 'Medium',
    color: '#5cc8ff',
    scale: 2.6,
    maxSpeed: 11,
    maxForce: 24,
    sepRadius: 3.0,
    aliRadius: 9,
    cohRadius: 13,
    sepWeight: 1.6,
    aliWeight: 1.0,
    cohWeight: 0.8,
    fearRadius: 20,
    fearWeight: 2.5,
    huntRadius: 0,
    huntWeight: 0,
    wander: 0.15,
    glint: 0.35,
  },
  {
    name: 'Large',
    color: '#c9d6e3',
    scale: 7.0,
    maxSpeed: 6,
    maxForce: 8,
    sepRadius: 10,
    aliRadius: 18,
    cohRadius: 24,
    sepWeight: 1.5,
    aliWeight: 0.5,
    cohWeight: 0.3,
    fearRadius: 0,
    fearWeight: 0,
    huntRadius: 30,
    huntWeight: 0.4,
    wander: 0.5,
    glint: 0.15,
  },
];

// Starlings for the murmuration page (starlings.html). One species fills all three sim slots; the
// hawk is not a flock member but an external predator driven from the CPU. Distances are roughly
// metres: birds keep ~1 m apart, align with birds a few metres away and fly at 12-14 m/s.
export const STARLING = {
  name: 'Starling',
  color: '#1c1626',
  scale: 0.3,
  maxSpeed: 14,
  maxForce: 34,
  sepRadius: 1.4,
  // with `neighbours` set these are the longest reach; each bird shrinks its own radius until
  // about that many birds are inside, as real starlings track their ~7 nearest
  aliRadius: 6,
  cohRadius: 8,
  sepWeight: 1.8,
  aliWeight: 1.5,
  // weak cohesion: with 7 neighbours each bird stays in touch anyway, and a stronger pull squeezes
  // the flock into one ball instead of letting it stretch round the roost
  cohWeight: 0.25,
  fearRadius: 0,
  fearWeight: 0,
  huntRadius: 0,
  huntWeight: 0,
  wander: 0.06,
  farCohesion: 0, // not needed with topological neighbours; it only compresses the flock
  neighbours: 7,
  glint: 0,
};

// default absolute numbers of medium / large fish; the rest are small
export const DEFAULT_COUNTS = { medium: 300, large: 8 };
// default tank half extents (x width, y height, z depth); height is fixed, floor and surface are barriers
export const TANK_HALF = [120, 30, 80];
