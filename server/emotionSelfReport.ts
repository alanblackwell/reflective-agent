// LLM self-report of emotion for Reflection mode's per-turn character nudge —
// the alternative to local keyword scoring (src/emotionLexicon.ts, still used
// for Eliza mode and for seeding Reflection mode's emotion at session start
// from the persistent notes). Rides on the /api/chat call already made every
// turn: the model is asked to append a fixed-format tag after its reply,
// which is parsed out here and stripped before the reply is shown or spoken.
const EMOTION_ORDER = ["joy", "sadness", "anger", "fear", "surprise", "disgust"] as const;
export type EmotionSnapshot = Partial<Record<(typeof EMOTION_ORDER)[number], number>>;

const TAG_PATTERN = /\n?\[emotion:\s*([^\]]*)\]\s*$/i;

export const EMOTION_SELF_REPORT_INSTRUCTION =
  "\n\nAfter your reply, on its own line, append your own read on the " +
  "emotional tone of this exchange (yours and the interlocutor's combined) " +
  "as a tag in exactly this format, with each value a number from 0 (not " +
  "present) to 1 (strongly present): " +
  "[emotion: joy=0.00 sadness=0.00 anger=0.00 fear=0.00 surprise=0.00 disgust=0.00]. " +
  "Most values will be 0 or close to it — only rate what's actually present. " +
  "This tag is stripped before the reply is shown or spoken, so it must be " +
  "the very last thing you write, with nothing after it.";

export interface ParsedReply {
  text: string;
  emotion: EmotionSnapshot | null;
}

// Splits the model's raw reply into the user-visible text and the trailing
// self-report tag. Falls back to the raw text with a null emotion if the tag
// is missing or malformed, so a parse hiccup never mangles the visible reply
// or blocks the fallback to local scoring on the frontend (see main.ts).
export function parseSelfReportedEmotion(raw: string): ParsedReply {
  const match = raw.match(TAG_PATTERN);
  if (!match) return { text: raw.trim(), emotion: null };

  const emotion: EmotionSnapshot = {};
  for (const pair of match[1].trim().split(/\s+/)) {
    const [name, value] = pair.split("=");
    if ((EMOTION_ORDER as readonly string[]).includes(name) && value !== undefined) {
      const num = Number(value);
      if (Number.isFinite(num)) {
        emotion[name as (typeof EMOTION_ORDER)[number]] = Math.min(1, Math.max(0, num));
      }
    }
  }

  return { text: raw.slice(0, match.index).trim(), emotion };
}
