// Viewer presets: named bundles of the water look. A preset only sets the runtime sliders listed
// in PRESET_KEYS, so applying one never rebuilds the simulation or touches the flock.
import {
  DEFAULT_MURKINESS,
  DEFAULT_SHAFT_STRENGTH,
  DEFAULT_SNOW_AMOUNT,
  DEFAULT_VIGNETTE,
  DEFAULT_WAVES,
  SNOW_AMOUNT_MAX,
  WAVE_SCALE_MAX,
} from './config.js';

/** `settings` keys a preset may set. */
export const PRESET_KEYS = [
  'murkiness',
  'shafts',
  'snow',
  'vignette',
  'waveHeight',
  'waveScale',
  'waveSpeed',
];

/** Slider range and label for each preset key, so presets can be checked against what the panel allows. */
export const PRESET_RANGES = {
  murkiness: [0, 4, 'water murkiness'],
  shafts: [0, 3, 'light shafts'],
  snow: [0, SNOW_AMOUNT_MAX, 'marine snow'],
  vignette: [0, 1, 'vignette'],
  waveHeight: [0.1, 3, 'wave height'],
  waveScale: [0.4, WAVE_SCALE_MAX, 'wave scale (shorter →)'],
  waveSpeed: [0, 3, 'wave speed'],
};

export const DEFAULT_PRESET = 'Reef';

export const PRESETS = {
  [DEFAULT_PRESET]: {
    murkiness: DEFAULT_MURKINESS,
    shafts: DEFAULT_SHAFT_STRENGTH,
    snow: DEFAULT_SNOW_AMOUNT,
    vignette: DEFAULT_VIGNETTE,
    waveHeight: DEFAULT_WAVES.height,
    waveScale: DEFAULT_WAVES.scale,
    waveSpeed: DEFAULT_WAVES.speed,
  },
  // bright, clean water with strong beams, few specks and a gentle low swell
  'Clear shallows': {
    murkiness: 0.4,
    shafts: 1.8,
    snow: 0.4,
    vignette: 0.3,
    waveHeight: 0.5,
    waveScale: 1,
    waveSpeed: 0.7,
  },
  // dark and blue: weak beams, lots of particles, a heavy frame, long slow swell
  'Deep blue': {
    murkiness: 1.7,
    shafts: 0.7,
    snow: 1.2,
    vignette: 0.7,
    waveHeight: 1.3,
    waveScale: 0.6,
    waveSpeed: 0.6,
  },
  // cloudy water full of particles, short choppy waves
  'Murky bay': {
    murkiness: 3,
    shafts: 1.2,
    snow: 2,
    vignette: 0.6,
    waveHeight: 0.9,
    waveScale: 1.4,
    waveSpeed: 1.2,
  },
  // dark, tall, fast waves with broken-up beams
  Stormy: {
    murkiness: 2,
    shafts: 0.5,
    snow: 1.5,
    vignette: 0.8,
    waveHeight: 2.2,
    waveScale: 1.2,
    waveSpeed: 1.8,
  },
};

/** Copies the named preset's values onto `settings`. Returns false for an unknown name. */
export function applyPreset(settings, name) {
  const preset = PRESETS[name];
  if (!preset) return false;
  Object.assign(settings, preset);
  return true;
}
