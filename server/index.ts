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
  formatReflectionsForSystemPrompt,
  getReflections,
  migrateReflectionsSchema,
  parseReflectionResponse,
  resetReflections,
  saveReflections,
  type EmotionSnapshot,
} from "./reflections";

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

// Only { id, label } — the systemPrompt text itself has no functional need
// to reach the client, so it stays server-side.
app.get("/api/personas", (_req, res) => {
  res.json(PERSONA_OPTIONS.map(({ id, label }) => ({ id, label })));
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
    res.json({ reply, usage, emotion });
  } catch (err) {
    console.error("Anthropic API error:", err);
    res.status(502).json({ error: "Failed to reach the language model." });
  }
});

app.get("/api/reflections", (_req, res) => {
  res.json({ ...getReflections(), migrationNotice: consumeMigrationNotice() });
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

  // Reflection is best-effort — an exhausted budget must never block the
  // UI's reset action, so this responds 200 with the session skipped rather
  // than an error.
  if (isBudgetExceeded()) {
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

    let archivedTo: string | null = null;
    if (archiveLabel) {
      archivedTo = archiveCurrentReflections(archiveLabel);
      if (resetAfterArchive) resetReflections();
    }

    res.json({ skipped: false, notes, archivedTo, usage });
  } catch (err) {
    console.error("Anthropic API error during reflection:", err);
    res.status(502).json({ error: "Failed to reach the language model." });
  }
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
