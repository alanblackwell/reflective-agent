import { EMOTION_NAMES, type EmotionName } from "./poses";
import { zeroWeights, type EmotionWeights } from "./blend";
import { NRC_LEXICON } from "./nrcEmotionLexiconData";
import { NRC_SENTIMENT_FALLBACK } from "./nrcSentimentFallback";

// A deliberately crude, zero-cost sentiment signal: plain keyword counting,
// no API call, no nuance (misses sarcasm/negation). Three sources are
// combined, checked in order for each token:
//
// 1. SUPPLEMENTAL_LEXICON below — the small original hand-picked stem list,
//    kept for casual/interjection words ("thanks", "wow", "ugh") that the
//    formal, dictionary-derived NRC lexicon (2) doesn't contain at all (it's
//    built from a fixed vocabulary of mostly formal English words — see
//    nrcEmotionLexiconData.ts).
// 2. NRC_LEXICON (nrcEmotionLexiconData.ts) — ~3,460 words from the NRC
//    Word-Emotion Association Lexicon with a specific per-emotion
//    association, giving much wider coverage across ordinary English text.
// 3. NRC_SENTIMENT_FALLBACK (nrcSentimentFallback.ts) — ~2,530 more words
//    that NRC tags only with a generic negative/positive sentiment and none
//    of the six specific emotions (e.g. "tired") — invisible to (2) alone,
//    despite clearly carrying emotional weight in everyday text. Checked
//    only when (2) finds nothing, at half weight, and mapped crudely: a
//    negative tag nudges sadness, a positive tag nudges joy.
// (2) and (3) are research/educational use only — see the license note in
// nrcEmotionLexiconData.ts before using this in anything commercial.
//
// Used both for Eliza mode's per-turn emotion (kept as the API-free, local
// approach per explicit user request) and for Reflection mode's session-seed
// scoring and its per-turn fallback when the LLM's own self-report is absent
// (see server/emotionSelfReport.ts).
const SUPPLEMENTAL_LEXICON: Record<EmotionName, string[]> = {
  joy: ["yay", "awesome", "thanks"],
  sadness: ["sorry"],
  anger: ["frustrat", "irritat", "damn"],
  fear: ["scared", "terrified"],
  surprise: ["wow", "whoa", "really", "astonish", "amazing", "shocked"],
  disgust: ["ugh", "yuck"],
};

const PER_MATCH_WEIGHT = 0.12;
// The generic negative/positive fallback (3 above) is a much cruder, less
// specific signal than a direct per-emotion association, so it counts for
// half as much.
const FALLBACK_MATCH_WEIGHT = PER_MATCH_WEIGHT / 2;
const MAX_DELTA = 0.4;

// Keyword counting is crude enough that two or more emotions frequently land
// on the exact same score (both 0, or both matching one keyword each) — and
// applyHeighten() in blend.ts scales each weight's deviation from the mean,
// so values that start out tied stay tied no matter how much heighten is
// applied afterward. breakTies() below fixes this at the source, before
// heighten (or anything else) ever sees the values.
const TIE_BREAK_SD = 0.02; // 2% of the full 0-1 scale

// Box-Muller transform — no built-in Gaussian RNG in JS.
function gaussianSample(sd: number): number {
  const u1 = Math.random() || Number.EPSILON; // avoid log(0)
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * sd;
}

// Nudges every value that shares its score with at least one other value by
// an independent Gaussian sample, so a tie in the raw analysis doesn't
// silently survive as a tie all the way through to the rendered pose. Values
// that are already unique among the six are left untouched.
function breakTies(weights: EmotionWeights): EmotionWeights {
  const counts = new Map<number, number>();
  for (const name of EMOTION_NAMES) counts.set(weights[name], (counts.get(weights[name]) ?? 0) + 1);

  const result = { ...weights };
  for (const name of EMOTION_NAMES) {
    if ((counts.get(weights[name]) ?? 0) > 1) {
      result[name] = Math.min(1, Math.max(0, weights[name] + gaussianSample(TIE_BREAK_SD)));
    }
  }
  return result;
}

const NRC_MAP = new Map(Object.entries(NRC_LEXICON));
const NRC_SENTIMENT_MAP = new Map(Object.entries(NRC_SENTIMENT_FALLBACK));

// The NRC lexicon only lists base/lemma forms ("scare", not "scared"; "cry",
// not "cries"), so a direct lookup misses common inflections. This is a
// crude, single-pass stemmer, not a real lemmatizer — it strips one common
// suffix and re-checks, falling back to no match rather than guessing further.
const STRIP_SUFFIXES = ["ing", "edly", "ed", "ies", "es", "s"];

function lookupWithStemming<V>(map: Map<string, V>, token: string): V | undefined {
  const direct = map.get(token);
  if (direct) return direct;
  for (const suffix of STRIP_SUFFIXES) {
    if (token.length <= suffix.length + 2 || !token.endsWith(suffix)) continue;
    const stem = suffix === "ies" ? `${token.slice(0, -3)}y` : token.slice(0, -suffix.length);
    const hit = map.get(stem);
    if (hit) return hit;
  }
  return undefined;
}

// Scores raw text into a small per-emotion delta by counting lexicon hits
// (supplemental stems + NRC dictionary words, with the sentiment-only
// fallback for words the dictionary lookup misses) and capping the total.
// Deliberately not normalized by text length — a short, punchy turn ("I'm
// furious!") should register as strongly as a long one containing the same
// word.
export function scoreEmotions(text: string): EmotionWeights {
  const lower = text.toLowerCase();
  const result = zeroWeights();

  for (const name of EMOTION_NAMES) {
    let count = 0;
    for (const stem of SUPPLEMENTAL_LEXICON[name]) {
      const matches = lower.match(new RegExp(`\\b${stem}`, "g"));
      if (matches) count += matches.length;
    }
    result[name] += count * PER_MATCH_WEIGHT;
  }

  const tokens = lower.match(/[a-z']+/g) ?? [];
  for (const token of tokens) {
    const emotions = lookupWithStemming(NRC_MAP, token);
    if (emotions) {
      for (const name of emotions) result[name] += PER_MATCH_WEIGHT;
      continue;
    }
    const sentiment = lookupWithStemming(NRC_SENTIMENT_MAP, token);
    if (sentiment === "negative") result.sadness += FALLBACK_MATCH_WEIGHT;
    else if (sentiment === "positive") result.joy += FALLBACK_MATCH_WEIGHT;
  }

  for (const name of EMOTION_NAMES) result[name] = Math.min(MAX_DELTA, result[name]);
  return breakTies(result);
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
