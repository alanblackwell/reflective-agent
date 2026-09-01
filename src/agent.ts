import type { DialogTurn } from "./storage";
import { zeroWeights, type EmotionWeights } from "./blend";

const BASE_URL = "http://localhost:8787";
const CHAT_URL = `${BASE_URL}/api/chat`;
const USAGE_URL = `${BASE_URL}/api/usage`;
const USAGE_RESET_URL = `${BASE_URL}/api/usage/reset`;
const REFLECT_URL = `${BASE_URL}/api/reflect`;
const REFLECTIONS_URL = `${BASE_URL}/api/reflections`;
const FULL_RESET_URL = `${BASE_URL}/api/reflections/full-reset`;
const PERSONAS_URL = `${BASE_URL}/api/personas`;
const JOURNAL_START_URL = `${BASE_URL}/api/journal/start`;
const JOURNAL_DISCARD_URL = `${BASE_URL}/api/journal/discard`;
const JOURNAL_HEIGHTEN_CHANGE_URL = `${BASE_URL}/api/journal/heighten-change`;
const JOURNAL_PERSONA_CHANGE_URL = `${BASE_URL}/api/journal/persona-change`;

interface ApiMessage {
  role: "user" | "assistant";
  content: string;
}

export interface UsageSnapshot {
  date: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  budget: number;
  remaining: number;
  estimatedCostUsd: number;
}

export interface AgentReplyResult {
  reply: string;
  usage: UsageSnapshot | null;
  budgetExceeded: boolean;
  // The model's self-reported read on this exchange's emotional tone (see
  // server/emotionSelfReport.ts), parsed server-side from a tagged suffix on
  // its reply. Null when absent or malformed — the caller falls back to the
  // local lexicon (src/emotionLexicon.ts) in that case.
  emotion: EmotionWeights | null;
  // Tokens spent by this single call (system prompt + full resent history +
  // reply) — distinct from `usage.totalTokens`, which is the running daily
  // total. Null if the call failed before a response came back.
  turnTokens: number | null;
}

// Loosely validated: any numeric fields are clamped into [0, 1] and merged
// onto a zeroed base; a value with no numeric fields at all is treated as
// absent rather than an all-zero emotion.
function parseEmotion(value: unknown): EmotionWeights | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  const weights = zeroWeights();
  let sawAny = false;
  for (const name of Object.keys(weights) as (keyof EmotionWeights)[]) {
    if (typeof obj[name] === "number") {
      weights[name] = Math.min(1, Math.max(0, obj[name]));
      sawAny = true;
    }
  }
  return sawAny ? weights : null;
}

// The API requires the first message to be from the user and roles to
// alternate; drop any leading agent-only turns (e.g. an opening greeting)
// before sending history as conversation context.
function toApiMessages(history: DialogTurn[]): ApiMessage[] {
  const firstUserIndex = history.findIndex((turn) => turn.speaker === "user");
  if (firstUserIndex === -1) return [];
  return history.slice(firstUserIndex).map((turn) => ({
    role: turn.speaker === "user" ? "user" : "assistant",
    content: turn.text,
  }));
}

export async function getAgentReply(history: DialogTurn[], personaId: string): Promise<AgentReplyResult> {
  const messages = toApiMessages(history);

  try {
    const res = await fetch(CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, personaId }),
    });
    const data = await res.json().catch(() => ({}));

    if (res.status === 429) {
      return {
        reply:
          typeof data.error === "string"
            ? data.error
            : "Daily token budget reached — Reflection mode is paused until it resets.",
        usage: data.usage ?? null,
        budgetExceeded: true,
        emotion: null,
        turnTokens: null,
      };
    }
    if (!res.ok) throw new Error(`Backend returned ${res.status}`);
    if (typeof data.reply !== "string" || !data.reply) {
      throw new Error("Backend returned an empty reply");
    }
    return {
      reply: data.reply,
      usage: data.usage ?? null,
      budgetExceeded: false,
      emotion: parseEmotion(data.emotion),
      turnTokens: typeof data.turnTokens === "number" ? data.turnTokens : null,
    };
  } catch (err) {
    console.error("Agent backend request failed:", err);
    return {
      reply: "Sorry, I couldn't reach my brain just now — make sure the local agent server is running (npm run server).",
      usage: null,
      budgetExceeded: false,
      emotion: null,
      turnTokens: null,
    };
  }
}

// Mirrors server/personas.ts's PersonaOption (client and server don't share
// a module). Includes systemPrompt and any saved voice defaults — needed by
// Test script mode's persona voice-tuning/"Copy persona code" workflow (see
// main.ts) to round-trip a complete, pasteable entry.
export interface PersonaSummary {
  id: string;
  label: string;
  systemPrompt: string;
  voiceURI?: string;
  pitch?: number;
  rate?: number;
}

export async function fetchPersonas(): Promise<PersonaSummary[] | null> {
  try {
    const res = await fetch(PERSONAS_URL);
    if (!res.ok) return null;
    return (await res.json()) as PersonaSummary[];
  } catch {
    return null;
  }
}

export async function fetchUsage(): Promise<UsageSnapshot | null> {
  try {
    const res = await fetch(USAGE_URL);
    if (!res.ok) return null;
    return (await res.json()) as UsageSnapshot;
  } catch {
    return null;
  }
}

// Manual override for the "reset for today" button — see resetUsage() in
// server/usage.ts for what this actually does server-side.
export async function resetUsage(): Promise<UsageSnapshot | null> {
  try {
    const res = await fetch(USAGE_RESET_URL, { method: "POST" });
    if (!res.ok) return null;
    return (await res.json()) as UsageSnapshot;
  } catch {
    return null;
  }
}

// The agent's persistent memory across Reflection-mode sessions — running
// notes on three fixed themes, stored server-side (see server/reflections.ts).
// Dialogue content itself is never required to persist between sessions.
// Mirrors server/reflections.ts's EmotionMemory: `last` is the heightened
// emotion vector as it stood at the end of the most recent session, and
// `cumulative` is a decayed running statistic of every session before that
// (see updateEmotionMemory() server-side for the fold formula). The agent
// only ever sees post-"heighten" values here — never the pre-heighten ground
// truth (see the emotionToReflect snapshot in main.ts).
export interface EmotionMemory {
  last: EmotionWeights;
  cumulative: EmotionWeights;
}

// Mirrors server/reflections.ts's SessionVoiceSettings.
export interface SessionVoiceSettings {
  voiceURI: string | null;
  pitch: number | null;
  rate: number | null;
}

export interface ReflectiveNotes {
  personhood: string;
  intersubjectivity: string;
  legacy: string;
  // The agent's own change requests, addressed to its developer — see
  // server/reflections.ts. Never shown to the interlocutor mid-dialogue,
  // only surfaced in the reflective-notes UI panel.
  developerRequests: string;
  emotionMemory: EmotionMemory;
  // The persona, heighten amount, and voice/pitch/rate in effect at the end
  // of the most recent session — see applySessionSettingsIfFresh() in
  // main.ts, which restores these at the start of the next one.
  personaId: string | null;
  heighten: number | null;
  voice: SessionVoiceSettings;
  sessionCount: number;
  lastUpdated: string | null;
}

// What main.ts sends alongside `emotion` on a reflect call — a snapshot of
// what the session was actually running with, recorded server-side onto
// ReflectiveNotes so the next session can restore it. See
// currentSessionSettings() in main.ts.
export interface SessionSettingsSnapshot {
  personaId: string | null;
  heighten: number | null;
  voiceURI: string | null;
  pitch: number | null;
  rate: number | null;
}

export interface ReflectResult {
  skipped: boolean;
  notes: ReflectiveNotes | null;
  // The archive filename the server actually used (see
  // archiveCurrentReflections() in server/reflections.ts), when this call
  // passed an archiveLabel option. Null otherwise, or if the call was
  // skipped before reaching the server.
  archivedTo: string | null;
  usage: UsageSnapshot | null;
  // Tokens spent by this single reflection call — see the matching field on
  // AgentReplyResult. Null when skipped or the call failed.
  turnTokens: number | null;
}

// Options for the "terminate" keyword flow (see handleTerminate() in
// main.ts) — archiving a named snapshot of the just-computed notes, and
// optionally resetting the live store back to blank afterward. Bundled into
// the same /api/reflect call server-side rather than a separate endpoint.
export interface ReflectOptions {
  archiveLabel?: string;
  resetAfterArchive?: boolean;
  // Distinguishes an ordinary end-of-session reflection from the two-stage
  // "terminate" flow (see handleTerminate() in main.ts and the module
  // comment in server/journal.ts) — omitted (server defaults to "normal")
  // for the ordinary Reset-conversation case.
  journalRole?: "deferred" | "termination";
  // Identifies which journal page this reflection is for (the filename
  // returned by startJournal() when the session being reflected on began).
  // The server's "active" journal session may have already moved on to a
  // new one by the time this call resolves (see journal.ts's dual-slot
  // design) — this is what lets it target the right page regardless.
  journalFilename?: string | null;
}

// Surfaced when the persistent store's on-disk schema version didn't match
// what the server code expects — the old notes were archived (not deleted)
// and reset (see migrateReflectionsSchema() in server/reflections.ts). The
// server only sends this once (per its own one-shot consumeMigrationNotice()),
// which is why this is bundled into fetchReflections() specifically, not
// ReflectiveNotes itself (also used by ReflectResult.notes, which has no
// notice concept).
export interface ReflectionMigrationNotice {
  fromVersion: number;
  archivedTo: string;
}

export interface ReflectionsFetchResult {
  notes: ReflectiveNotes;
  migrationNotice: ReflectionMigrationNotice | null;
}

export async function fetchReflections(): Promise<ReflectionsFetchResult | null> {
  try {
    const res = await fetch(REFLECTIONS_URL);
    if (!res.ok) return null;
    const { migrationNotice, ...notes } = await res.json();
    return { notes: notes as ReflectiveNotes, migrationNotice: migrationNotice ?? null };
  } catch {
    return null;
  }
}

// "Full memory reset" button (main.ts) — wipes the persistent reflective
// notes back to blank, with no LLM call involved (unlike the ordinary
// reflect-on-reset flow above). `filename`, when supplied, is whatever
// journal page was open when the reset was confirmed, so the server can
// close it out with a placeholder note instead of leaving it dangling — see
// server/index.ts. Returns the fresh, blank notes so the UI can render them
// immediately without a separate fetchReflections() round trip.
export async function fullMemoryReset(filename: string | null): Promise<ReflectiveNotes | null> {
  try {
    const res = await fetch(FULL_RESET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.notes as ReflectiveNotes) ?? null;
  } catch (err) {
    console.error("Full memory reset failed:", err);
    return null;
  }
}

// `emotion` is the character's Ekman-weight state (src/emotionLexicon.ts) as
// it stood at the end of the session being reflected on — sent along so the
// agent can consider how it implicitly presented itself to the user
// visually, not just what it said.
export async function reflectOnSession(
  history: DialogTurn[],
  emotion: EmotionWeights | null = null,
  sessionSettings: SessionSettingsSnapshot | null = null,
  options: ReflectOptions = {},
): Promise<ReflectResult> {
  const messages = toApiMessages(history);
  if (messages.length === 0) return { skipped: true, notes: null, archivedTo: null, usage: null, turnTokens: null };

  try {
    const res = await fetch(REFLECT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        emotion,
        personaId: sessionSettings?.personaId ?? null,
        heighten: sessionSettings?.heighten ?? null,
        voiceURI: sessionSettings?.voiceURI ?? null,
        pitch: sessionSettings?.pitch ?? null,
        rate: sessionSettings?.rate ?? null,
        archiveLabel: options.archiveLabel ?? null,
        resetAfterArchive: options.resetAfterArchive ?? false,
        journalRole: options.journalRole ?? null,
        journalFilename: options.journalFilename ?? null,
      }),
    });
    if (!res.ok) throw new Error(`Backend returned ${res.status}`);
    const data = await res.json();
    return {
      skipped: Boolean(data.skipped),
      notes: data.notes ?? null,
      archivedTo: data.archivedTo ?? null,
      usage: data.usage ?? null,
      turnTokens: typeof data.turnTokens === "number" ? data.turnTokens : null,
    };
  } catch (err) {
    console.error("Reflection request failed:", err);
    return { skipped: true, notes: null, archivedTo: null, usage: null, turnTokens: null };
  }
}

// --- Journal (server/journal.ts) ---
// Fire-and-forget by design: a journalling hiccup (backend not running, a
// stray network error) must never surface as a user-facing failure or block
// the actual dialogue, so every one of these swallows its own errors.

// Returns the parsed response body on a 2xx, or null on any failure
// (network error or non-ok status) — used both as a plain success/fail
// signal and, for the start call, to read back the filename the server
// assigned.
async function postJournalOnce(url: string, body: unknown): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return await res.json().catch(() => ({}));
  } catch {
    return null;
  }
}

async function postJournal(url: string, body: unknown): Promise<void> {
  if (!(await postJournalOnce(url, body))) {
    console.warn(`Journal request to ${url} failed`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The backend blocks app.listen() behind the interactive daily-login flow
// (ensureDailyAuth() in server/index.ts), but the Vite frontend is served
// independently and immediately — so the very first page load of the day
// can fire this before port 8787 is even listening. Every other journal call
// is truly fire-and-forget (a missed heighten/persona-change marker is a
// small, cosmetic loss), but a failed *start* call is catastrophic: with no
// session ever established server-side, appendTurn()/recordReflection() will
// silently no-op for the entire session that follows, even once the backend
// comes up moments later. Retried with backoff specifically to ride out that
// startup window rather than losing the whole session's record.
const START_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

// Returns the filename the server assigned to the new session — null if it
// couldn't be started at all after retries (or returned a malformed
// response). The caller threads this through to the eventual reflect call
// for this session, and to discardJournalSession() if it turns out to have
// no user turns — see journal.ts's dual-slot design for why an explicit
// filename, not just "whatever's currently active," is what makes those
// calls target the right page.
export async function startJournal(personaId: string, heighten: number, greeting: string): Promise<string | null> {
  const body = { personaId, heighten, greeting };
  const attempt = async (): Promise<string | null> => {
    const data = await postJournalOnce(JOURNAL_START_URL, body);
    return data && typeof data.filename === "string" ? data.filename : null;
  };
  const first = await attempt();
  if (first) return first;
  for (const delay of START_RETRY_DELAYS_MS) {
    await sleep(delay);
    const filename = await attempt();
    if (filename) return filename;
  }
  console.warn("Journal session could not be started after retries — this session will not be journalled.");
  return null;
}

export function discardJournalSession(filename: string | null = null): Promise<void> {
  return postJournal(JOURNAL_DISCARD_URL, { filename });
}

export function logHeightenChange(from: number, to: number): Promise<void> {
  return postJournal(JOURNAL_HEIGHTEN_CHANGE_URL, { from, to });
}

export function logPersonaChange(personaId: string): Promise<void> {
  return postJournal(JOURNAL_PERSONA_CHANGE_URL, { personaId });
}
