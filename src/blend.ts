import { EMOTION_NAMES, EMOTION_POSES, NEUTRAL, type EmotionName, type FacePose } from "./poses";

export type EmotionWeights = Record<EmotionName, number>;

export function zeroWeights(): EmotionWeights {
  return {
    joy: 0,
    sadness: 0,
    anger: 0,
    fear: 0,
    surprise: 0,
    disgust: 0,
  };
}

const POSE_KEYS = Object.keys(NEUTRAL) as (keyof FacePose)[];

// Blends the six emotion poses according to slider weights (each expected in
// [0, 1]). Weights are not required to sum to 1: any leftover "budget" below
// a total of 1 is filled by the neutral pose, and totals above 1 are
// renormalized so multiple maxed-out sliders still produce a bounded pose.
export function blendPoses(weights: EmotionWeights): FacePose {
  let total = 0;
  for (const name of EMOTION_NAMES) {
    total += Math.max(0, weights[name]);
  }

  const neutralWeight = Math.max(0, 1 - total);
  const norm = Math.max(total + neutralWeight, 1e-6);

  const result = {} as FacePose;
  for (const key of POSE_KEYS) {
    let sum = NEUTRAL[key] * neutralWeight;
    for (const name of EMOTION_NAMES) {
      const w = Math.max(0, weights[name]);
      if (w > 0) sum += EMOTION_POSES[name][key] * w;
    }
    result[key] = sum / norm;
  }
  return result;
}

// Exaggerates the six weights away from their mean, controlled by a 0..1
// "heighten" amount — models a heightened/altered emotional state (e.g.
// intoxication or acute mental illness distorting expression) rather than a
// literal sentiment reading. Deviations from the mean are scaled by a factor
// that grows *exponentially* with the heighten amount, so even a modest
// slider position pushes whichever emotion is already most prominent toward
// its extreme quickly, while the others get pushed toward zero; a heighten
// of 0 leaves the weights completely untouched (scale factor of 1).
const HEIGHTEN_EXP_RATE = 4;

export function applyHeighten(weights: EmotionWeights, heighten: number): EmotionWeights {
  const h = Math.max(0, Math.min(1, heighten));
  if (h === 0) return weights;

  let mean = 0;
  for (const name of EMOTION_NAMES) mean += weights[name];
  mean /= EMOTION_NAMES.length;

  const factor = Math.exp(HEIGHTEN_EXP_RATE * h);
  const result = {} as EmotionWeights;
  for (const name of EMOTION_NAMES) {
    const deviation = weights[name] - mean;
    result[name] = Math.max(0, Math.min(1, mean + deviation * factor));
  }
  return result;
}
