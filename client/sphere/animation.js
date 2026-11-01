const positiveModulo = (value, divisor) => ((value % divisor) + divisor) % divisor;
const gaussian = (phase, center, width) => Math.exp(-(((phase - center) / width) ** 2));

export function heartbeatAt(seconds, bpm = 64) {
  const phase = positiveModulo(seconds * (bpm / 60), 1);
  const primary = gaussian(phase, 0.08, 0.045);
  const secondary = 0.55 * gaussian(phase, 0.28, 0.065);
  const beat = primary + secondary;

  return {
    phase,
    beat,
    scale: 0.96 + 0.14 * beat,
    glow: 0.85 + 0.9 * beat,
  };
}
