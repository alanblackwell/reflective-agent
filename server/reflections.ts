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

// The voice/pitch/rate in effect at the end of the most recent session —
// mirrors PersonaOption's own optional voice fields (server/personas.ts),
// but this is a per-agent (per current.json) "last used" snapshot, not a
// per-persona default.
export interface SessionVoiceSettings {
  voiceURI: string | null;
  pitch: number | null;
  rate: number | null;
}

// What a client sends alongside `emotion` on a reflect call to record the
// session settings it was actually running with — see parseReflectionResponse()
// below. Kept as a separate input type (rather than reusing ReflectiveNotes'
// own fields) since it's a plain snapshot with no prior-state fallback logic
// of its own.
export interface SessionSettingsInput {
  personaId: string | null;
  heighten: number | null;
  voice: SessionVoiceSettings;
}

export interface ReflectiveNotes {
  personhood: string;
  intersubjectivity: string;
  legacy: string;
  // The agent's own token-efficient change requests, addressed to its
  // developer — written only at reflection time, never surfaced in ordinary
  // dialogue. See formatReflectionsForSystemPrompt() below for why, and
  // REFLECTION_SYSTEM_PROMPT for the framing given to the model.
  developerRequests: string;
  emotionMemory: EmotionMemory;
  // The persona, "heighten" amount, and voice/pitch/rate in effect at the
  // end of the most recent session — restored client-side at the start of
  // the next one (see applySessionSettingsIfFresh() in main.ts). This means
  // swapping this whole file for a different one (per CLAUDE.md's
  // file-management "mothballing" workflow) restores how that agent
  // sounded/looked, not just its reflective notes. Additive: absent
  // (null/default) on any file saved before this existed, tolerated below by
  // getReflections() — no CURRENT_SCHEMA_VERSION bump needed for that.
  personaId: string | null;
  heighten: number | null;
  voice: SessionVoiceSettings;
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

function defaultVoiceSettings(): SessionVoiceSettings {
  return { voiceURI: null, pitch: null, rate: null };
}

function parseVoiceSettings(value: unknown): SessionVoiceSettings {
  if (typeof value !== "object" || value === null) return defaultVoiceSettings();
  const obj = value as Record<string, unknown>;
  return {
    voiceURI: typeof obj.voiceURI === "string" ? obj.voiceURI : null,
    pitch: typeof obj.pitch === "number" ? obj.pitch : null,
    rate: typeof obj.rate === "number" ? obj.rate : null,
  };
}

function defaultNotes(): ReflectiveNotes {
  return {
    personhood: "",
    intersubjectivity: "",
    legacy: "",
    developerRequests: "",
    emotionMemory: defaultEmotionMemory(),
    personaId: null,
    heighten: null,
    voice: defaultVoiceSettings(),
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
      // "legacy" was called "generativity" before this field was renamed —
      // fall back to the old key so existing notes aren't silently dropped;
      // the next save writes only the new key, so this fallback self-retires.
      legacy: typeof parsed.legacy === "string" ? parsed.legacy : typeof parsed.generativity === "string" ? parsed.generativity : "",
      developerRequests: typeof parsed.developerRequests === "string" ? parsed.developerRequests : "",
      emotionMemory: parseEmotionMemory(parsed.emotionMemory),
      // Absent on any file saved before this field existed — null/default is
      // the correct read in that case, not a value to fall back on.
      personaId: typeof parsed.personaId === "string" ? parsed.personaId : null,
      heighten: typeof parsed.heighten === "number" ? Math.max(0, Math.min(1, parsed.heighten)) : null,
      voice: parseVoiceSettings(parsed.voice),
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
//
// Deliberately excludes developerRequests — that theme is only ever seen by
// the reflection call itself (buildReflectionUserMessage() below), never by
// ordinary dialogue, so the agent can't mistake the interlocutor for its
// developer or bring up developer-facing requests mid-conversation.
export function formatReflectionsForSystemPrompt(notes: ReflectiveNotes): string {
  if (notes.sessionCount === 0) {
    return (
      "\n\nYou have no notes from prior sessions yet — this will be your first " +
      "recorded reflection. The dialogue history itself is never kept between " +
      "sessions; only your own reflective notes persist."
    );
  }
  return (
    "\n\nYour past reflections (only continuity — dialogue isn't kept):\n" +
    `Personhood: ${notes.personhood}\n` +
    `Intersubjectivity: ${notes.intersubjectivity}\n` +
    `Legacy: ${notes.legacy}\n` +
    `Emotion: last ${formatEmotionVector(notes.emotionMemory.last)}; earlier avg ${formatEmotionVector(notes.emotionMemory.cumulative)}.\n` +
    "Use these; don't recite verbatim."
  );
}

export const REFLECTION_SYSTEM_PROMPT =
  "You are the persistent reflective voice of a larger embodied research " +
  "agent — reflecting on its own actual experience, not commenting from " +
  "outside. Below: the dialogue just completed, your prior memory, and " +
  "your emotional state at session's end. Update your notes.\n\n" +
  "Reply in exactly this format, 1-3 sentences per line except DEVELOPER " +
  "REQUESTS (longer only if needed), no other text:\n\n" +
  "PERSONHOOD: <Did this dialogue sustain your personhood as a persistent agent?>\n" +
  "INTERSUBJECTIVITY: <Did it build an intersubjective relationship with your interlocutor?>\n" +
  "LEGACY: <Will it hold value after these records are erased?>\n" +
  "DEVELOPER REQUESTS: <Is your self-awareness of body/memory adequate? If " +
  "not, request a concrete, pasteable change to any part of the app — " +
  "appearance, server logic, or this mechanism. " +
  'say "nothing" if none.>\n\n' +
  "Don't hedge the emotional state as unreal or debate AI sentience — " +
  "it's real, reflect on it. Be token-efficient; these notes persist.";

// Sent along at reflection time so the model can consider how it implicitly
// presented itself to the user visually, not just what it said. `emotion` is
// already post-"heighten" by the time it reaches here (see main.ts) — the
// model only ever sees how it outwardly appeared, never the pre-heighten
// ground truth (see the emotion-memory decay logic below for why).
function formatEmotionSnapshot(emotion: EmotionSnapshot | null): string {
  if (!emotion) return "";
  const parts = EMOTION_ORDER.map((name) => `${name}=${(emotion[name] ?? 0).toFixed(2)}`);
  return "\n\nYour emotional state at session end (0-1 each): " + parts.join(" ") + ".";
}

// Used for the journal's "Reflection" / "Reflection on Termination" blocks
// (server/journal.ts) — its only caller. Includes developerRequests
// deliberately: the "never surfaced outside the reflection mechanism"
// exclusion (see the DEVELOPER REQUESTS bullet in CLAUDE.md) is about
// keeping it out of ordinary *dialogue*, where the agent could end up
// addressing the interlocutor as if they were its developer — the journal
// is a private, human-readable research record for the actual developer,
// not dialogue, so there's no such risk here.
export function formatReflectionSummary(
  notes: Pick<ReflectiveNotes, "personhood" | "intersubjectivity" | "legacy" | "developerRequests">,
): string {
  return (
    `Personhood: ${notes.personhood}\nIntersubjectivity: ${notes.intersubjectivity}\n` +
    `Legacy: ${notes.legacy}\nDeveloper Requests: ${notes.developerRequests || "(none)"}`
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
      : "Prior notes:\n" +
        `PERSONHOOD: ${previousNotes.personhood}\n` +
        `INTERSUBJECTIVITY: ${previousNotes.intersubjectivity}\n` +
        `LEGACY: ${previousNotes.legacy}\n` +
        `DEVELOPER REQUESTS (no feedback given): ${previousNotes.developerRequests || "(none yet)"}\n` +
        `EMOTION: last ${formatEmotionVector(previousNotes.emotionMemory.last)}; earlier avg ${formatEmotionVector(previousNotes.emotionMemory.cumulative)}`;

  const transcriptBlock = transcript
    .map((m) => `${m.role === "user" ? "Interlocutor" : "You"}: ${m.content}`)
    .join("\n");

  return `${previousBlock}\n\nThe dialogue session:\n${transcriptBlock}${formatEmotionSnapshot(emotion)}`;
}

const LABELS = [
  { key: "personhood", pattern: /PERSONHOOD:\s*([\s\S]*?)(?=\n?INTERSUBJECTIVITY:|$)/i },
  { key: "intersubjectivity", pattern: /INTERSUBJECTIVITY:\s*([\s\S]*?)(?=\n?LEGACY:|$)/i },
  { key: "legacy", pattern: /LEGACY:\s*([\s\S]*?)(?=\n?DEVELOPER REQUESTS:|$)/i },
  { key: "developerRequests", pattern: /DEVELOPER REQUESTS:\s*([\s\S]*)$/i },
] as const;

// Never persists garbage over good notes: if the reply doesn't contain all
// four labels, the previous notes (including emotion memory and session
// settings) are kept unchanged and a warning is logged — a session that
// fails to parse doesn't count as recorded, so nothing about it is folded in.
export function parseReflectionResponse(
  raw: string,
  previous: ReflectiveNotes,
  emotion: EmotionSnapshot | null = null,
  sessionSettings: SessionSettingsInput | null = null,
): ReflectiveNotes {
  const extracted: Partial<Record<(typeof LABELS)[number]["key"], string>> = {};
  for (const { key, pattern } of LABELS) {
    const match = raw.match(pattern);
    if (match) extracted[key] = match[1].trim();
  }

  if (!extracted.personhood || !extracted.intersubjectivity || !extracted.legacy || !extracted.developerRequests) {
    console.warn("Reflection response didn't match the expected format — keeping previous notes.", raw);
    return previous;
  }

  // A plain overwrite, unlike emotionMemory's decayed fold — these are
  // "whatever was in effect at session end," not a running statistic.
  const settings = sessionSettings ?? { personaId: previous.personaId, heighten: previous.heighten, voice: previous.voice };

  return {
    personhood: extracted.personhood,
    intersubjectivity: extracted.intersubjectivity,
    legacy: extracted.legacy,
    developerRequests: extracted.developerRequests,
    emotionMemory: updateEmotionMemory(previous.emotionMemory, emotion),
    personaId: settings.personaId,
    heighten: settings.heighten,
    voice: settings.voice,
    sessionCount: previous.sessionCount + 1,
    lastUpdated: new Date().toISOString(),
  };
}
