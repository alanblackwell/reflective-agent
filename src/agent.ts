import type { DialogTurn } from "./storage";
import { zeroWeights, type EmotionWeights } from "./blend";

const BASE_URL = "http://localhost:8787";
const CHAT_URL = `${BASE_URL}/api/chat`;
const USAGE_URL = `${BASE_URL}/api/usage`;
const USAGE_RESET_URL = `${BASE_URL}/api/usage/reset`;
const REFLECT_URL = `${BASE_URL}/api/reflect`;
const REFLECTIONS_URL = `${BASE_URL}/api/reflections`;

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

export async function getAgentReply(history: DialogTurn[]): Promise<AgentReplyResult> {
  const messages = toApiMessages(history);

  try {
    const res = await fetch(CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
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
    };
  } catch (err) {
    console.error("Agent backend request failed:", err);
    return {
      reply: "Sorry, I couldn't reach my brain just now — make sure the local agent server is running (npm run server).",
      usage: null,
      budgetExceeded: false,
      emotion: null,
    };
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

export interface ReflectiveNotes {
  personhood: string;
  intersubjectivity: string;
  generativity: string;
  // The agent's own change requests, addressed to its developer — see
  // server/reflections.ts. Never shown to the interlocutor mid-dialogue,
  // only surfaced in the reflective-notes UI panel.
  developerRequests: string;
  emotionMemory: EmotionMemory;
  sessionCount: number;
  lastUpdated: string | null;
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
}

// Options for the "terminate" keyword flow (see handleTerminate() in
// main.ts) — archiving a named snapshot of the just-computed notes, and
// optionally resetting the live store back to blank afterward. Bundled into
// the same /api/reflect call server-side rather than a separate endpoint.
export interface ReflectOptions {
  archiveLabel?: string;
  resetAfterArchive?: boolean;
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

// `emotion` is the character's Ekman-weight state (src/emotionLexicon.ts) as
// it stood at the end of the session being reflected on — sent along so the
// agent can consider how it implicitly presented itself to the user
// visually, not just what it said.
export async function reflectOnSession(
  history: DialogTurn[],
  emotion: EmotionWeights | null = null,
  options: ReflectOptions = {},
): Promise<ReflectResult> {
  const messages = toApiMessages(history);
  if (messages.length === 0) return { skipped: true, notes: null, archivedTo: null, usage: null };

  try {
    const res = await fetch(REFLECT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        emotion,
        archiveLabel: options.archiveLabel ?? null,
        resetAfterArchive: options.resetAfterArchive ?? false,
      }),
    });
    if (!res.ok) throw new Error(`Backend returned ${res.status}`);
    const data = await res.json();
    return {
      skipped: Boolean(data.skipped),
      notes: data.notes ?? null,
      archivedTo: data.archivedTo ?? null,
      usage: data.usage ?? null,
    };
  } catch (err) {
    console.error("Reflection request failed:", err);
    return { skipped: true, notes: null, archivedTo: null, usage: null };
  }
}
