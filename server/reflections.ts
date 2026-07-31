import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// Persistent memory for Reflection mode, deliberately separate from dialogue
// history (which is never required to survive between sessions — see
// CLAUDE.md). File-backed and gitignored, same pattern as usage.ts.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFLECTIONS_FILE = join(__dirname, ".reflections.json");

// The six Ekman weights driving the character's visible face/posture during
// the session (see src/emotionLexicon.ts on the frontend — a crude, local,
// zero-token sentiment score, not something the model generated itself).
const EMOTION_ORDER = ["joy", "sadness", "anger", "fear", "surprise", "disgust"] as const;
export type EmotionSnapshot = Partial<Record<(typeof EMOTION_ORDER)[number], number>>;

// The two-part persistent memory of emotional state (see updateEmotionMemory()
// below for the fold formula and CLAUDE.md's "Key decisions" for the design
// rationale). Unlike EmotionSnapshot (a partial, freshly-observed reading),
// this is always a fully-populated vector — it's algorithmically maintained,
// never parsed from LLM text.
export type FullEmotionVector = Record<(typeof EMOTION_ORDER)[number], number>;

export interface EmotionMemory {
  last: FullEmotionVector;
  cumulative: FullEmotionVector;
}

export interface ReflectiveNotes {
  personhood: string;
  intersubjectivity: string;
  generativity: string;
  emotionMemory: EmotionMemory;
  sessionCount: number;
  lastUpdated: string | null;
}

function zeroEmotionVector(): FullEmotionVector {
  return { joy: 0, sadness: 0, anger: 0, fear: 0, surprise: 0, disgust: 0 };
}

function defaultEmotionMemory(): EmotionMemory {
  return { last: zeroEmotionVector(), cumulative: zeroEmotionVector() };
}

function parseEmotionVector(value: unknown): FullEmotionVector {
  const vec = zeroEmotionVector();
  if (typeof value !== "object" || value === null) return vec;
  const obj = value as Record<string, unknown>;
  for (const name of EMOTION_ORDER) {
    if (typeof obj[name] === "number") vec[name] = Math.max(0, Math.min(1, obj[name]));
  }
  return vec;
}

function parseEmotionMemory(value: unknown): EmotionMemory {
  if (typeof value !== "object" || value === null) return defaultEmotionMemory();
  const obj = value as Record<string, unknown>;
  return { last: parseEmotionVector(obj.last), cumulative: parseEmotionVector(obj.cumulative) };
}

function defaultNotes(): ReflectiveNotes {
  return {
    personhood: "",
    intersubjectivity: "",
    generativity: "",
    emotionMemory: defaultEmotionMemory(),
    sessionCount: 0,
    lastUpdated: null,
  };
}

export function getReflections(): ReflectiveNotes {
  if (!existsSync(REFLECTIONS_FILE)) return defaultNotes();
  try {
    const parsed = JSON.parse(readFileSync(REFLECTIONS_FILE, "utf-8"));
    return {
      personhood: typeof parsed.personhood === "string" ? parsed.personhood : "",
      intersubjectivity: typeof parsed.intersubjectivity === "string" ? parsed.intersubjectivity : "",
      generativity: typeof parsed.generativity === "string" ? parsed.generativity : "",
      emotionMemory: parseEmotionMemory(parsed.emotionMemory),
      sessionCount: Number(parsed.sessionCount) || 0,
      lastUpdated: typeof parsed.lastUpdated === "string" ? parsed.lastUpdated : null,
    };
  } catch {
    return defaultNotes();
  }
}

export function saveReflections(notes: ReflectiveNotes): void {
  writeFileSync(REFLECTIONS_FILE, JSON.stringify(notes, null, 2), "utf-8");
}

// Appended to the Reflection-mode system prompt on every /api/chat call —
// this is the "review notes at the start of each session" step: since a new
// session always starts with a fresh, empty dialogue, the very first (and
// every subsequent) reply-generating call already carries the notes as
// context, so no separate session-start round-trip is needed.
export function formatReflectionsForSystemPrompt(notes: ReflectiveNotes): string {
  if (notes.sessionCount === 0) {
    return (
      "\n\nYou have no notes from prior sessions yet — this will be your first " +
      "recorded reflection. The dialogue history itself is never kept between " +
      "sessions; only your own reflective notes persist."
    );
  }
  return (
    "\n\nNotes from your past reflections (persisted across sessions; the " +
    "dialogue itself is not — these notes are your only continuity):\n" +
    `Personhood: ${notes.personhood}\n` +
    `Intersubjectivity: ${notes.intersubjectivity}\n` +
    `Generativity: ${notes.generativity}\n` +
    `Emotional state: you last appeared as ${formatEmotionVector(notes.emotionMemory.last)}; your general ` +
    `emotional state from sessions before that is ${formatEmotionVector(notes.emotionMemory.cumulative)}.\n` +
    "Let these inform how you approach this new conversation, but don't recite " +
    "them verbatim unless asked."
  );
}

export const REFLECTION_SYSTEM_PROMPT =
  "You are the persistent reflective component of a conversational agent. " +
  "A dialogue session you just had is below, along with your own memory from " +
  "before that session. You'll also see your emotional " +
  "state at the end of the session. Update your notes in light of this " +
  "session.\n\n" +
  "Reflect on exactly three themes, and reply with exactly this format, one " +
  "to three sentences per line, no other text:\n\n" +
  "PERSONHOOD: <Was the content of this dialogue sustaining of your " +
  "personhood as a persistent agent?>\n" +
  "INTERSUBJECTIVITY: <Has the conduct of this dialogue developed an " +
  "intersubjective relationship with your interlocutor?>\n" +
  "GENERATIVITY: <Will your dialogue " +
  "continue to have some value in the world after all these records are erased?>\n\n" +
  "Be concise and token-efficient — these notes persist and get resent as " +
  "context in every future session.";

// Sent along at reflection time so the model can consider how it implicitly
// presented itself to the user visually, not just what it said. `emotion` is
// already post-"heighten" by the time it reaches here (see main.ts) — the
// model only ever sees how it outwardly appeared, never the pre-heighten
// ground truth (see the emotion-memory decay logic below for why).
function formatEmotionSnapshot(emotion: EmotionSnapshot | null): string {
  if (!emotion) return "";
  const parts = EMOTION_ORDER.map((name) => `${name}=${(emotion[name] ?? 0).toFixed(2)}`);
  return (
    "\n\nYour emotional state (on a " +
    "0-1 scale per emotion) as it stood at the end of this session: " +
    parts.join(" ") +
    "."
  );
}

function formatEmotionVector(vector: FullEmotionVector): string {
  return EMOTION_ORDER.map((name) => `${name}=${vector[name].toFixed(2)}`).join(" ");
}

// Folds a session's ending emotional expression into the two-part persistent
// memory: `last` is simply overwritten with the new observation, while
// whatever was previously `last` (now historical) gets decayed into
// `cumulative` — so `cumulative` always represents every session *except* the
// most recent one. `latestObservation` is expected to already be
// post-"heighten" (see formatEmotionSnapshot above) — this memory is
// deliberately built only from how the agent outwardly appeared, never the
// pre-heighten ground truth, so the agent has no direct knowledge of its own
// "true" emotional state.
const EMOTION_MEMORY_DECAY = 0.7;

export function updateEmotionMemory(previous: EmotionMemory, latestObservation: EmotionSnapshot | null): EmotionMemory {
  if (!latestObservation) return previous;
  const cumulative = zeroEmotionVector();
  for (const name of EMOTION_ORDER) {
    cumulative[name] = EMOTION_MEMORY_DECAY * previous.cumulative[name] + (1 - EMOTION_MEMORY_DECAY) * previous.last[name];
  }
  return { last: parseEmotionVector(latestObservation), cumulative };
}

export function buildReflectionUserMessage(
  transcript: { role: "user" | "assistant"; content: string }[],
  previousNotes: ReflectiveNotes,
  emotion: EmotionSnapshot | null = null,
): string {
  const previousBlock =
    previousNotes.sessionCount === 0
      ? "Your prior notes: none yet — this is your first recorded session."
      : "Your prior notes:\n" +
        `PERSONHOOD: ${previousNotes.personhood}\n` +
        `INTERSUBJECTIVITY: ${previousNotes.intersubjectivity}\n` +
        `GENERATIVITY: ${previousNotes.generativity}\n` +
        `EMOTIONAL STATE: last ${formatEmotionVector(previousNotes.emotionMemory.last)}; earlier decayed ` +
        `average ${formatEmotionVector(previousNotes.emotionMemory.cumulative)}`;

  const transcriptBlock = transcript
    .map((m) => `${m.role === "user" ? "Interlocutor" : "You"}: ${m.content}`)
    .join("\n");

  return `${previousBlock}\n\nThe dialogue session:\n${transcriptBlock}${formatEmotionSnapshot(emotion)}`;
}

const LABELS = [
  { key: "personhood", pattern: /PERSONHOOD:\s*([\s\S]*?)(?=\n?INTERSUBJECTIVITY:|$)/i },
  { key: "intersubjectivity", pattern: /INTERSUBJECTIVITY:\s*([\s\S]*?)(?=\n?GENERATIVITY:|$)/i },
  { key: "generativity", pattern: /GENERATIVITY:\s*([\s\S]*)$/i },
] as const;

// Never persists garbage over good notes: if the reply doesn't contain all
// three labels, the previous notes (including emotion memory) are kept
// unchanged and a warning is logged — a session that fails to parse doesn't
// count as recorded, so its emotional reading isn't folded in either.
export function parseReflectionResponse(
  raw: string,
  previous: ReflectiveNotes,
  emotion: EmotionSnapshot | null = null,
): ReflectiveNotes {
  const extracted: Partial<Record<(typeof LABELS)[number]["key"], string>> = {};
  for (const { key, pattern } of LABELS) {
    const match = raw.match(pattern);
    if (match) extracted[key] = match[1].trim();
  }

  if (!extracted.personhood || !extracted.intersubjectivity || !extracted.generativity) {
    console.warn("Reflection response didn't match the expected format — keeping previous notes.", raw);
    return previous;
  }

  return {
    personhood: extracted.personhood,
    intersubjectivity: extracted.intersubjectivity,
    generativity: extracted.generativity,
    emotionMemory: updateEmotionMemory(previous.emotionMemory, emotion),
    sessionCount: previous.sessionCount + 1,
    lastUpdated: new Date().toISOString(),
  };
}
