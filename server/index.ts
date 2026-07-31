import "dotenv/config";
import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import { DAILY_TOKEN_BUDGET, getUsage, isBudgetExceeded, recordUsage } from "./usage";
import { dailyLogout, ensureDailyAuth, msUntilNextLocalMidnight } from "./auth";
import {
  REFLECTION_SYSTEM_PROMPT,
  buildReflectionUserMessage,
  formatReflectionsForSystemPrompt,
  getReflections,
  parseReflectionResponse,
  saveReflections,
  type EmotionSnapshot,
} from "./reflections";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;

// Responses are read aloud via TTS and shown as short chat pills, so keep
// them brief and free of formatting that doesn't make sense spoken aloud.
const BASE_SYSTEM_PROMPT =
  "You are a friendly conversational voice agent. Your replies are read aloud " +
  "via text-to-speech and shown as short chat bubbles, so keep them brief " +
  "(1-3 sentences), conversational, and free of markdown, lists, or headings.";

// The persisted reflective notes (see reflections.ts) are appended fresh on
// every call so each new Reflection-mode session "reviews" them from its
// very first reply, with no separate session-start round-trip needed.
function buildSystemPrompt(): string {
  return BASE_SYSTEM_PROMPT + formatReflectionsForSystemPrompt(getReflections());
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

app.post("/api/chat", async (req, res) => {
  const messages = req.body?.messages;
  if (!Array.isArray(messages) || messages.length === 0 || !messages.every(isChatMessage)) {
    res.status(400).json({ error: "messages must be a non-empty array of {role, content}" });
    return;
  }

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
      model: "claude-opus-4-8",
      max_tokens: 1024,
      system: buildSystemPrompt(),
      messages,
    });

    const textBlock = response.content.find((block) => block.type === "text");
    const usage = recordUsage(response.usage.input_tokens, response.usage.output_tokens);
    res.json({ reply: textBlock?.type === "text" ? textBlock.text : "", usage });
  } catch (err) {
    console.error("Anthropic API error:", err);
    res.status(502).json({ error: "Failed to reach the language model." });
  }
});

app.get("/api/reflections", (_req, res) => {
  res.json(getReflections());
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

  // Reflection is best-effort — an exhausted budget must never block the
  // UI's reset action, so this responds 200 with the session skipped rather
  // than an error.
  if (isBudgetExceeded()) {
    res.json({ skipped: true, notes: previousNotes, usage: getUsage() });
    return;
  }

  try {
    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 500,
      system: REFLECTION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildReflectionUserMessage(messages, previousNotes, emotion) }],
    });

    const textBlock = response.content.find((block) => block.type === "text");
    const usage = recordUsage(response.usage.input_tokens, response.usage.output_tokens);
    const notes = parseReflectionResponse(textBlock?.type === "text" ? textBlock.text : "", previousNotes);
    saveReflections(notes);
    res.json({ skipped: false, notes, usage });
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
  await ensureDailyAuth();
  scheduleDailyShutdown();
  app.listen(PORT, () => {
    console.log(`Agent backend listening on http://localhost:${PORT}`);
  });
}

main();
