import "dotenv/config";
import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import { DAILY_TOKEN_BUDGET, getUsage, isBudgetExceeded, recordUsage } from "./usage";
import { dailyLogout, ensureDailyAuth, msUntilNextLocalMidnight } from "./auth";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;

// Responses are read aloud via TTS and shown as short chat pills, so keep
// them brief and free of formatting that doesn't make sense spoken aloud.
const SYSTEM_PROMPT =
  "You are a friendly conversational voice agent. Your replies are read aloud " +
  "via text-to-speech and shown as short chat bubbles, so keep them brief " +
  "(1-3 sentences), conversational, and free of markdown, lists, or headings.";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return (m.role === "user" || m.role === "assistant") && typeof m.content === "string";
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
      system: SYSTEM_PROMPT,
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
