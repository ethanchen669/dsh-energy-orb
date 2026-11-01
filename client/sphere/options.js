export const DEFAULT_OPTIONS = Object.freeze({
  color: '#42dcff',
  bpm: 64,
  rotationSpeed: 1,
  energy: 1,
  coreScale: 1,
  coreBrightness: 1,
  heartbeatEnabled: true,
  paused: false,
});

const RANGES = Object.freeze({
  bpm: [30, 200],
  rotationSpeed: [0, 4],
  energy: [0, 2],
  coreScale: [0.75, 1.5],
  coreBrightness: [0, 2],
});

function validateRange(name, value, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be a finite number between ${minimum} and ${maximum}`);
  }
  return value;
}

export function normalizeOptions(current = {}, patch = {}) {
  const merged = { ...DEFAULT_OPTIONS, ...current, ...patch };
  for (const [name, [minimum, maximum]] of Object.entries(RANGES)) {
    validateRange(name, merged[name], minimum, maximum);
  }
  merged.heartbeatEnabled = Boolean(merged.heartbeatEnabled);
  merged.paused = Boolean(merged.paused);
  return merged;
}

export function validatePulseStrength(value = 1) {
  return validateRange('pulse strength', value, 0, 3);
}

export function assertContainer(container) {
  if (!container || container.nodeType !== 1 || typeof container.appendChild !== 'function') {
    throw new TypeError('createEnergySphere requires an HTMLElement container');
  }
  return container;
}
