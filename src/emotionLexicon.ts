import { EMOTION_NAMES, type EmotionName } from "./poses";
import { zeroWeights, type EmotionWeights } from "./blend";

// A deliberately crude, zero-cost sentiment signal: plain keyword counting
// against a small hand-picked lexicon per Ekman emotion. No API call, no
// nuance (misses sarcasm/negation) — traded for being free to run on every
// turn and on the persistent reflection notes at session start.
const LEXICON: Record<EmotionName, string[]> = {
  joy: [
    "happy", "glad", "great", "wonderful", "love", "excited", "fun",
    "delight", "yay", "awesome", "nice", "thanks", "grateful", "enjoy",
    "smile", "laugh", "hope", "good",
  ],
  sadness: [
    "sad", "sorry", "miss", "lonely", "cry", "grief", "down", "depress",
    "hurt", "disappoint", "lost", "unhappy", "regret", "tired", "hopeless",
  ],
  anger: [
    "angry", "mad", "furious", "annoy", "hate", "frustrat", "irritat",
    "unfair", "rage", "resent", "damn", "stupid",
  ],
  fear: [
    "afraid", "scared", "worried", "anxious", "nervous", "fear", "panic",
    "terrified", "uneasy", "dread", "risk", "threat",
  ],
  surprise: [
    "wow", "surprised", "shocked", "unexpected", "sudden", "whoa", "really",
    "unbelievable", "astonish", "amazing",
  ],
  disgust: [
    "disgust", "gross", "ugh", "yuck", "revolt", "sick", "nasty", "awful",
    "terrible", "horrible",
  ],
};

const PER_MATCH_WEIGHT = 0.12;
const MAX_DELTA = 0.4;

// Scores raw text into a small per-emotion delta by counting lexicon hits.
// Deliberately not normalized by text length — a short, punchy turn ("I'm
// furious!") should register as strongly as a long one containing the same
// word.
export function scoreEmotions(text: string): EmotionWeights {
  const lower = text.toLowerCase();
  const result = zeroWeights();
  for (const name of EMOTION_NAMES) {
    let count = 0;
    for (const stem of LEXICON[name]) {
      const matches = lower.match(new RegExp(`\\b${stem}`, "g"));
      if (matches) count += matches.length;
    }
    result[name] = Math.min(MAX_DELTA, count * PER_MATCH_WEIGHT);
  }
  return result;
}

// Nudges current weights toward a new turn's delta: the prior state fades
// (DECAY) so a single angry turn doesn't linger forever, while this turn's
// signal is added on top. Only ever touches the six numbers passed in — no
// persistent-state lookup, so the per-turn cost is a handful of regex scans,
// not a round trip.
const DECAY = 0.7;

export function applyEmotionDelta(current: EmotionWeights, delta: EmotionWeights): EmotionWeights {
  const next = zeroWeights();
  for (const name of EMOTION_NAMES) {
    next[name] = Math.min(1, Math.max(0, current[name] * DECAY + delta[name]));
  }
  return next;
}
