import "dotenv/config";
import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import { DAILY_TOKEN_BUDGET, getUsage, isBudgetExceeded, recordUsage, resetUsage } from "./usage";
import { dailyLogout, ensureDailyAuth, msUntilNextLocalMidnight } from "./auth";
import { EMOTION_SELF_REPORT_INSTRUCTION, parseSelfReportedEmotion } from "./emotionSelfReport";
import { ACTIVE_MODEL } from "./models";
import { DEFAULT_PERSONA_ID, PERSONA_OPTIONS, getPersonaById } from "./personas";
import {
  REFLECTION_SYSTEM_PROMPT,
  archiveCurrentReflections,
  buildReflectionUserMessage,
  consumeMigrationNotice,
  formatReflectionSummary,
  formatReflectionsForSystemPrompt,
  getReflections,
  migrateReflectionsSchema,
  parseReflectionResponse,
  resetReflections,
  saveReflections,
  type EmotionSnapshot,
} from "./reflections";
import {
  appendHeightenChange,
  appendPersonaChange,
  appendTurn,
  discardCurrentSessionIfEmpty,
  recordReflection,
  startSession,
  type JournalRole,
} from "./journal";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;

// Responses are read aloud via TTS and shown as short chat pills, so keep
// them brief and free of formatting that doesn't make sense spoken aloud.
// Kept separate from persona text (server/personas.ts) — this constraint
// applies regardless of which persona is selected.
const RESPONSE_FORMAT_INSTRUCTION =
  " Your replies are read aloud via text-to-speech and shown as short chat " +
  "bubbles, so keep them brief (1-3 sentences), conversational, and free of " +
  "markdown, lists, or headings.";

// The persisted reflective notes (see reflections.ts) are appended fresh on
// every call so each new Reflection-mode session "reviews" them from its
// very first reply, with no separate session-start round-trip needed. The
// reflective notes store is global/shared across all personas (not scoped
// per persona) — a deliberate v1 simplification.
function buildSystemPrompt(personaId: string): string {
  return (
    getPersonaById(personaId).systemPrompt +
    RESPONSE_FORMAT_INSTRUCTION +
    EMOTION_SELF_REPORT_INSTRUCTION +
    formatReflectionsForSystemPrompt(getReflections())
  );
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return (m.role === "user" || m.role === "assistant") && typeof m.content === "string";
}

// Reflection mode resends the full dialog history on every /api/chat call
// (see CLAUDE.md's "Known issues" — no compaction yet), so a long session's
// per-turn cost otherwise grows with the square of its length. Caching the
// prefix through the most-recently-appended turn means each new call only
// pays full price for what's actually new — everything before it is read
// back at a fraction of the cost, once a request's prefix clears the active
// model's minimum cacheable length (see server/models.ts). Standard
// multi-turn placement: https://platform.claude.com/docs/en/build-with-claude/prompt-caching.
function withCacheBreakpoint(messages: ChatMessage[]) {
  return messages.map((m, i) =>
    i === messages.length - 1
      ? {
          role: m.role,
          content: [{ type: "text" as const, text: m.content, cache_control: { type: "ephemeral" as const } }],
        }
      : { role: m.role, content: m.content },
  );
}

// Loosely validated: an object of numeric emotion weights, keys optional.
function isEmotionSnapshot(value: unknown): value is EmotionSnapshot {
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === "number");
}

const client = new Anthropic();

const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/usage", (_req, res) => {
  res.json(getUsage());
});

app.post("/api/usage/reset", (_req, res) => {
  res.json(resetUsage());
});

// Full PersonaOption objects, including systemPrompt and any saved voice
// defaults — the systemPrompt used to be stripped out here since the client
// had no need for it, but Test script mode's persona voice-tuning workflow
// (see "Copy persona code" in src/main.ts) needs to round-trip the full
// object so the user can paste a complete, pasteable entry back into
// server/personas.ts.
app.get("/api/personas", (_req, res) => {
  res.json(PERSONA_OPTIONS);
});

app.post("/api/chat", async (req, res) => {
  const messages = req.body?.messages;
  if (!Array.isArray(messages) || messages.length === 0 || !messages.every(isChatMessage)) {
    res.status(400).json({ error: "messages must be a non-empty array of {role, content}" });
    return;
  }
  const personaId = typeof req.body?.personaId === "string" ? req.body.personaId : DEFAULT_PERSONA_ID;

  // Hard limit: checked BEFORE calling the API, so an exhausted budget can't
  // spend a single additional token.
  if (isBudgetExceeded()) {
    res.status(429).json({
      error: `Daily token budget reached (${DAILY_TOKEN_BUDGET.toLocaleString()} tokens). Resets at midnight local time.`,
      usage: getUsage(),
    });
    return;
  }

  try {
    const response = await client.messages.create({
      model: ACTIVE_MODEL.id,
      max_tokens: 1024,
      // The system prompt is stable for the whole Reflection-mode session
      // (it only changes when the persisted notes are updated between
      // sessions), so it's cacheable on its own breakpoint alongside the
      // conversation-history one in withCacheBreakpoint() below.
      system: [{ type: "text", text: buildSystemPrompt(personaId), cache_control: { type: "ephemeral" } }],
      messages: withCacheBreakpoint(messages),
    });

    const textBlock = response.content.find((block) => block.type === "text");
    const usage = recordUsage(response.usage.input_tokens, response.usage.output_tokens);
    const { text: reply, emotion } = parseSelfReportedEmotion(textBlock?.type === "text" ? textBlock.text : "");
    // Tokens spent by this single call (system prompt + full resent history +
    // reply) — distinct from `usage`, which is the running daily total. Lets
    // the frontend show a per-turn cost alongside the cumulative one.
    const turnTokens = response.usage.input_tokens + response.usage.output_tokens;
    // Every /api/chat call is inherently a Reflection-mode turn — no mode
    // check needed. No-ops quietly if no journal session is open.
    appendTurn(messages[messages.length - 1].content, reply);
    res.json({ reply, usage, emotion, turnTokens });
  } catch (err) {
    console.error("Anthropic API error:", err);
    res.status(502).json({ error: "Failed to reach the language model." });
  }
});

app.get("/api/reflections", (_req, res) => {
  res.json({ ...getReflections(), migrationNotice: consumeMigrationNotice() });
});

// "Full memory reset" button (main.ts) — a fast, LLM-free wipe of the
// persistent reflective store, for starting a brand-new experiment without
// waiting on (or paying for) a real reflection. Closes out whatever journal
// page was open with a placeholder note instead of a genuine reflection
// (mirrors the existing budget-exceeded/call-failed placeholder pattern in
// /api/reflect below) — recordReflection() no-ops harmlessly if no filename
// is supplied or nothing is open.
app.post("/api/reflections/full-reset", (req, res) => {
  const filename = typeof req.body?.filename === "string" ? req.body.filename : null;
  recordReflection("(No reflection recorded — persistent memory was manually reset before this session ended.)", "normal", filename);
  resetReflections();
  res.json({ ok: true, notes: getReflections() });
});

app.post("/api/reflect", async (req, res) => {
  const messages = req.body?.messages;
  if (!Array.isArray(messages) || messages.length === 0 || !messages.every(isChatMessage)) {
    res.status(400).json({ error: "messages must be a non-empty array of {role, content}" });
    return;
  }
  if (!messages.some((m: ChatMessage) => m.role === "user")) {
    res.status(400).json({ error: "session has no user turns to reflect on" });
    return;
  }

  const previousNotes = getReflections();
  const emotion = isEmotionSnapshot(req.body?.emotion) ? req.body.emotion : null;
  // Optional archiving, driven by the "terminate" keyword flow in main.ts —
  // see archiveCurrentReflections()/resetReflections() in reflections.ts.
  // Bundled into this same request so "reflect -> archive -> (optionally)
  // reset" is atomic, rather than needing a separate endpoint + round trip.
  const archiveLabel = typeof req.body?.archiveLabel === "string" ? req.body.archiveLabel : null;
  const resetAfterArchive = Boolean(req.body?.resetAfterArchive);
  // Distinguishes an ordinary end-of-session reflection from the two-stage
  // "terminate" flow (see handleTerminate() in main.ts and the module
  // comment in journal.ts) — defaults to "normal" for the ordinary
  // Reset-conversation case.
  const journalRole: JournalRole =
    req.body?.journalRole === "deferred" || req.body?.journalRole === "termination" ? req.body.journalRole : "normal";
  // Identifies which journal page this reflection is for — the session that
  // was open when the client kicked off this call, which may no longer be
  // the server's "active" journal session by the time this (LLM-backed, so
  // potentially slow) call actually resolves. See journal.ts's dual-slot
  // comment for why this matters.
  const journalFilename = typeof req.body?.journalFilename === "string" ? req.body.journalFilename : null;

  // Reflection is best-effort — an exhausted budget must never block the
  // UI's reset action, so this responds 200 with the session skipped rather
  // than an error.
  if (isBudgetExceeded()) {
    // For "deferred" (terminate flow's Step 1), the client aborts the whole
    // termination in place and leaves the live dialogue untouched — so the
    // journal session must stay open exactly as it was, not be finalized
    // here. "normal"/"termination" both lead the client to move on to a new
    // session regardless of this skip, so finalize now with a placeholder —
    // otherwise the page would be left open (unclosed dialogue section) and
    // the *next* session's start would still patch a next-link onto it.
    if (journalRole !== "deferred") {
      recordReflection("(No reflection recorded — the daily token budget was reached.)", journalRole, journalFilename);
    }
    res.json({ skipped: true, notes: previousNotes, archivedTo: null, usage: getUsage() });
    return;
  }

  try {
    const response = await client.messages.create({
      model: ACTIVE_MODEL.id,
      max_tokens: 500,
      // REFLECTION_SYSTEM_PROMPT is a fixed constant, byte-identical on
      // every call, so it's cacheable across every reflection ever run — the
      // user message isn't (transcript + notes differ every time, so there's
      // no reusable prefix there to cache; see prompt-caching guidance).
      system: [{ type: "text", text: REFLECTION_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: buildReflectionUserMessage(messages, previousNotes, emotion) }],
    });

    const textBlock = response.content.find((block) => block.type === "text");
    const usage = recordUsage(response.usage.input_tokens, response.usage.output_tokens);
    const notes = parseReflectionResponse(textBlock?.type === "text" ? textBlock.text : "", previousNotes, emotion);
    saveReflections(notes);

    // Computed before recordReflection() below so a "termination" call can
    // record which archive file holds this exact snapshot (see journal.ts).
    let archivedTo: string | null = null;
    if (archiveLabel) {
      archivedTo = archiveCurrentReflections(archiveLabel);
      if (resetAfterArchive) resetReflections();
    }

    recordReflection(formatReflectionSummary(notes), journalRole, journalFilename, archivedTo);

    // Tokens spent by this single reflection call — see the matching field on
    // /api/chat's response.
    const turnTokens = response.usage.input_tokens + response.usage.output_tokens;
    res.json({ skipped: false, notes, archivedTo, usage, turnTokens });
  } catch (err) {
    console.error("Anthropic API error during reflection:", err);
    // See the isBudgetExceeded() branch above for why "deferred" is skipped
    // here but "normal"/"termination" still finalize the journal page.
    if (journalRole !== "deferred") {
      recordReflection("(No reflection recorded — the language model call failed.)", journalRole, journalFilename);
    }
    res.status(502).json({ error: "Failed to reach the language model." });
  }
});

// --- Journal (server/journal.ts) ---
// Human-readable HTML archive of Reflection-mode sessions, for research
// review — see journal.ts's module comment for the full design. All four
// routes are fire-and-forget from the client's perspective (see agent.ts) —
// a journalling hiccup must never surface as a dialogue-breaking error.

app.post("/api/journal/start", (req, res) => {
  const personaId = typeof req.body?.personaId === "string" ? req.body.personaId : DEFAULT_PERSONA_ID;
  const heighten = typeof req.body?.heighten === "number" ? req.body.heighten : 0;
  const greeting = typeof req.body?.greeting === "string" ? req.body.greeting : "";
  // Returned filename lets the client target this exact session on its
  // later /api/journal/discard or /api/reflect call, unambiguously — see
  // journal.ts's dual-slot comment for why that matters.
  const filename = startSession(personaId, heighten, greeting);
  res.json({ ok: true, filename });
});

app.post("/api/journal/discard", (req, res) => {
  const filename = typeof req.body?.filename === "string" ? req.body.filename : null;
  discardCurrentSessionIfEmpty(filename);
  res.json({ ok: true });
});

app.post("/api/journal/heighten-change", (req, res) => {
  const from = typeof req.body?.from === "number" ? req.body.from : 0;
  const to = typeof req.body?.to === "number" ? req.body.to : 0;
  appendHeightenChange(from, to);
  res.json({ ok: true });
});

app.post("/api/journal/persona-change", (req, res) => {
  const personaId = typeof req.body?.personaId === "string" ? req.body.personaId : DEFAULT_PERSONA_ID;
  appendPersonaChange(personaId);
  res.json({ ok: true });
});

function scheduleDailyShutdown(): void {
  setTimeout(async () => {
    console.log("");
    console.log("======================================================");
    console.log(" A new day has started — shutting down Reflection mode.");
    console.log(" Your Anthropic login has been cleared, not left active.");
    console.log(" Run `npm run server` again when you want to use");
    console.log(" Reflection mode today — you'll be prompted to log in.");
    console.log("======================================================");
    console.log("");
    await dailyLogout();
    process.exit(0);
  }, msUntilNextLocalMidnight());
}

async function shutdownGracefully(signal: string): Promise<void> {
  console.log(`\nReceived ${signal} — logging out of Anthropic and shutting down.`);
  await dailyLogout();
  process.exit(0);
}
process.on("SIGINT", () => void shutdownGracefully("SIGINT"));
process.on("SIGTERM", () => void shutdownGracefully("SIGTERM"));

async function main(): Promise<void> {
  migrateReflectionsSchema();
  await ensureDailyAuth();
  scheduleDailyShutdown();
  app.listen(PORT, () => {
    console.log(`Agent backend listening on http://localhost:${PORT}`);
    console.log(`Using model ${ACTIVE_MODEL.id} (${ACTIVE_MODEL.rationale})`);
  });
}

main();
