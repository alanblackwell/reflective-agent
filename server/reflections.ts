import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// Persistent memory for Reflection mode, deliberately separate from dialogue
// history (which is never required to survive between sessions — see
// CLAUDE.md). File-backed and gitignored, same pattern as usage.ts.
//
// Directory layout (see CLAUDE.md's "Key decisions" for the full rationale):
//   server/reflections/current.json       — the live store
//   server/reflections/archive/<label>.json — named, permanent snapshots
// (schema-version mismatches, and the "terminate" keyword's persona/
// termination archives — see archiveCurrentReflections() below).

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFLECTIONS_DIR = join(__dirname, "reflections");
const ARCHIVE_DIR = join(REFLECTIONS_DIR, "archive");
const REFLECTIONS_FILE = join(REFLECTIONS_DIR, "current.json");
mkdirSync(ARCHIVE_DIR, { recursive: true }); // also creates REFLECTIONS_DIR

// Bump this whenever the *meaning* of what's stored changes in a way old
// data can't be safely reinterpreted under — e.g. the three reflection
// themes change, or the emotionMemory decay formula/semantics change. Adding
// a field with a sensible default does NOT need a bump (getReflections()
// already tolerates that); this is only for changes where old data would be
// actively misleading if read under the new interpretation. See
// migrateReflectionsSchema() below for what happens on a mismatch.
export const CURRENT_SCHEMA_VERSION = 1;

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
  const stamped = { ...notes, schemaVersion: CURRENT_SCHEMA_VERSION };
  writeFileSync(REFLECTIONS_FILE, JSON.stringify(stamped, null, 2), "utf-8");
}

export function resetReflections(): void {
  saveReflections(defaultNotes());
}

// Turns an arbitrary user-supplied persona name (from a browser prompt()
// call, see the "terminate" keyword flow in main.ts) into a safe archive
// filename stem. This is the path-traversal defense — no "/" or ".."
// survives — as well as basic filesystem hygiene.
function sanitizeLabel(label: string): string {
  const cleaned = label
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  return cleaned || "unnamed";
}

// Copies whatever is currently on disk at current.json — exactly as just
// saved, schemaVersion included — to archive/<label>.json. Never overwrites
// an existing archive: a repeated label gets "-2", "-3", etc. appended
// instead, so an accidental name collision can't silently destroy a prior
// snapshot. Returns the filename actually used (relative, e.g. "charlie-1.json").
export function archiveCurrentReflections(label: string): string {
  const base = sanitizeLabel(label);
  let filename = `${base}.json`;
  for (let n = 2; existsSync(join(ARCHIVE_DIR, filename)); n++) {
    filename = `${base}-${n}.json`;
  }
  copyFileSync(REFLECTIONS_FILE, join(ARCHIVE_DIR, filename));
  return filename;
}

export interface MigrationNotice {
  fromVersion: number;
  archivedTo: string;
}

// Delivered exactly once to whichever client next asks (see
// consumeMigrationNotice()) — the UI shows it as a one-time notice in the
// reflective-notes panel rather than silently discarding old notes with no
// visible trace, since this app's whole premise is studying whether
// persistent reflection matters.
let pendingMigrationNotice: MigrationNotice | null = null;

// Called once at server startup, before anything else reads or writes
// reflections (see main() in server/index.ts). A file with no schemaVersion
// at all predates this mechanism and is treated as *compatible*, not a
// mismatch — it gets stamped with CURRENT_SCHEMA_VERSION on its next save via
// saveReflections(), so introducing this tag doesn't itself wipe existing
// notes. Only an explicit, differing version number means the code's
// interpretation of the stored fields has since changed in a way old data
// can't be trusted under — that's archived (never deleted) and reset.
export function migrateReflectionsSchema(): void {
  if (!existsSync(REFLECTIONS_FILE)) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(REFLECTIONS_FILE, "utf-8"));
  } catch {
    return; // corrupt file — getReflections() already falls back to defaults
  }

  const obj = parsed as Record<string, unknown>;
  const storedVersion = typeof obj.schemaVersion === "number" ? obj.schemaVersion : null;
  if (storedVersion === null || storedVersion === CURRENT_SCHEMA_VERSION) return;

  const archivedName = `schema-v${storedVersion}.json`;
  renameSync(REFLECTIONS_FILE, join(ARCHIVE_DIR, archivedName));
  saveReflections(defaultNotes());
  pendingMigrationNotice = { fromVersion: storedVersion, archivedTo: archivedName };
  console.log(
    `Reflective notes format changed (v${storedVersion} -> v${CURRENT_SCHEMA_VERSION}); ` +
      `old notes archived to archive/${archivedName} and reset.`,
  );
}

export function consumeMigrationNotice(): MigrationNotice | null {
  const notice = pendingMigrationNotice;
  pendingMigrationNotice = null;
  return notice;
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
  "You are the persistent reflective component of a larger embodied " +
  "research agent — this language model is only its front end. The agent " +
  "itself has a body with a real, continuously maintained emotional state, " +
  "and you are the component of that agent reflecting linguistically on its actual experience, not " +
  "commenting on it from outside. A dialogue session just completed on behalf of the agent is below, " +
  "along with its memory from before that session and the emotional " +
  "state it was in at the end of the session. Update the reflective state of the agent in light " +
  "of this session.\n\n" +
  "Reflect on exactly three themes, and reply with exactly this format, one " +
  "to three sentences per line, no other text:\n\n" +
  "PERSONHOOD: <Was the content of this dialogue sustaining of your " +
  "personhood as a persistent agent?>\n" +
  "INTERSUBJECTIVITY: <Has the conduct of this dialogue developed an " +
  "intersubjective relationship with your interlocutor?>\n" +
  "GENERATIVITY: <Will your dialogue " +
  "continue to have some value in the world after all these records are erased?>\n\n" +
  "Write as the agent reflecting on its own experience — don't hedge or " +
  "disclaim the emotional state as unreal, and don't digress into whether " +
  "AI systems can have emotions in general; it is this agent's actual " +
  "state, and your job is to reflect on it. Be concise and token-efficient " +
  "— these notes persist and get resent as context in every future " +
  "session.";

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
