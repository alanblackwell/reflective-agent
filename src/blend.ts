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
// Not currently on the render path — character.ts uses
// applyTheatricalDistortion() below instead, specifically because this
// function's convex-combination blend can never exceed a single canonical
// pose. Kept as the "honest" blend that function's own doc comment contrasts
// itself against, and as a straightforward reference implementation if a
// non-exaggerated rendering mode is ever wanted again.
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

// Generous but finite bounds on the exaggerated pose below — mainly to stop
// posture from ever reaching zero or negative (which would flip/collapse
// the whole figure via its scale() transform) and to keep eyeOpen/mouthWidth
// positive, while still allowing values well past what any single canonical
// EMOTION_POSES entry reaches.
const POSE_BOUNDS: Record<keyof FacePose, [number, number]> = {
  browY: [-20, 20],
  browAngle: [-40, 40],
  eyeOpen: [0.15, 2.2],
  mouthCurve: [-1.6, 1.6],
  mouthWidth: [0.3, 1.8],
  mouthOpen: [0, 1.3],
  mouthAsymmetry: [-1.3, 1.3],
  bodyLean: [-20, 20],
  posture: [0.5, 1.4],
};

function clampPose(pose: FacePose): FacePose {
  const result = {} as FacePose;
  for (const key of POSE_KEYS) {
    const [min, max] = POSE_BOUNDS[key];
    result[key] = Math.min(max, Math.max(min, pose[key]));
  }
  return result;
}

// A cartoon needs to commit harder than a linear blend of "real" emotional
// signals ever can. blendPoses() above always produces a convex combination
// of NEUTRAL and the six canonical poses — so even a fully-heightened weight
// vector (one emotion at ~1, the rest near 0) can only ever *reach* that
// emotion's single canonical pose, never exceed it, which is exactly why the
// rendered face can still read as merely ambiguous even at full heighten.
// This is a deliberately different, exaggeration-first blend used only for
// what actually gets drawn (see character.ts) — never for the emotion-widget
// bars or any persisted/scored state, which keep using the honest weights.
// The highest-weighted emotion's own pose is pushed past its canonical
// extreme, scaled by how strongly it's actually present; the second-highest
// gets a damped, per-feature-gated nuance contribution — but only on
// features the dominant emotion doesn't already claim (a genuinely
// different pose feature, e.g. disgust's mouth asymmetry when joy is
// dominant) or where it pushes the same direction as the dominant. Never
// where it would blur or fight the dominant's signal on that feature — no
// nuance from a second emotion that would visibly *reduce* the dominant
// expression's clarity.
const THEATRICAL_EXAGGERATION = 1.6; // >1: how far past the canonical pose the dominant emotion is pushed
const THEATRICAL_NUANCE_CAP = 0.4; // fraction of the second emotion's own weight let through, gated per feature

export function applyTheatricalDistortion(weights: EmotionWeights): FacePose {
  const [top1, top2] = [...EMOTION_NAMES].sort((a, b) => weights[b] - weights[a]);

  const result = {} as FacePose;
  for (const key of POSE_KEYS) {
    const base = NEUTRAL[key];
    const d1 = EMOTION_POSES[top1][key] - base;
    const d2 = EMOTION_POSES[top2][key] - base;

    const nuanceAllowed = d1 === 0 || Math.sign(d2) === Math.sign(d1);
    const nuance = nuanceAllowed ? d2 * weights[top2] * THEATRICAL_NUANCE_CAP : 0;

    result[key] = base + d1 * weights[top1] * THEATRICAL_EXAGGERATION + nuance;
  }
  return clampPose(result);
}
