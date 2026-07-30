export type EmotionName =
  | "joy"
  | "sadness"
  | "anger"
  | "fear"
  | "surprise"
  | "disgust";

export const EMOTION_NAMES: EmotionName[] = [
  "joy",
  "sadness",
  "anger",
  "fear",
  "surprise",
  "disgust",
];

// A pose is a set of normalized facial parameters. Values are chosen for
// visual legibility on a simple line drawing, not biomechanical accuracy.
export interface FacePose {
  browY: number; // vertical offset, px, negative = raised
  browAngle: number; // degrees, positive = inner-down (frown/angry slant)
  eyeOpen: number; // scale multiplier, 1 = neutral
  mouthCurve: number; // -1 (frown) .. 1 (smile)
  mouthWidth: number; // scale multiplier, 1 = neutral
  mouthOpen: number; // 0..1 baseline opening (before speech pulses)
  mouthAsymmetry: number; // -1..1, corner skew (used for disgust sneer)
  bodyLean: number; // degrees, whole-figure lean (+forward/right, -back/left)
  posture: number; // scale, 1 = upright, <1 = slumped shoulders
}

export const NEUTRAL: FacePose = {
  browY: 0,
  browAngle: 0,
  eyeOpen: 1,
  mouthCurve: 0,
  mouthWidth: 1,
  mouthOpen: 0.05,
  mouthAsymmetry: 0,
  bodyLean: 0,
  posture: 1,
};

export const EMOTION_POSES: Record<EmotionName, FacePose> = {
  joy: {
    browY: -1,
    browAngle: 4,
    eyeOpen: 0.7,
    mouthCurve: 1,
    mouthWidth: 1.2,
    mouthOpen: 0.15,
    mouthAsymmetry: 0,
    bodyLean: 2,
    posture: 1.05,
  },
  sadness: {
    browY: 3,
    browAngle: -16,
    eyeOpen: 0.6,
    mouthCurve: -0.8,
    mouthWidth: 0.85,
    mouthOpen: 0.05,
    mouthAsymmetry: 0,
    bodyLean: -4,
    posture: 0.85,
  },
  anger: {
    browY: 4,
    browAngle: 22,
    eyeOpen: 0.5,
    mouthCurve: -0.5,
    mouthWidth: 0.85,
    mouthOpen: 0.1,
    mouthAsymmetry: 0,
    bodyLean: 3,
    posture: 1.05,
  },
  fear: {
    browY: -6,
    browAngle: 12,
    eyeOpen: 1.3,
    mouthCurve: -0.2,
    mouthWidth: 0.75,
    mouthOpen: 0.35,
    mouthAsymmetry: 0,
    bodyLean: -6,
    posture: 0.9,
  },
  surprise: {
    browY: -9,
    browAngle: 0,
    eyeOpen: 1.45,
    mouthCurve: 0,
    mouthWidth: 0.7,
    mouthOpen: 0.6,
    mouthAsymmetry: 0,
    bodyLean: 0,
    posture: 1.1,
  },
  disgust: {
    browY: 2,
    browAngle: -10,
    eyeOpen: 0.6,
    mouthCurve: -0.3,
    mouthWidth: 0.85,
    mouthOpen: 0.05,
    mouthAsymmetry: 0.6,
    bodyLean: -2,
    posture: 0.95,
  },
};
