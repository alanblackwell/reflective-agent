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
