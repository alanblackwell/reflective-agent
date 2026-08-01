import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// A conservative daily ceiling on total (input + output) tokens spent via
// this app's Reflection mode, so experimenting with it can't eat into a
// shared Anthropic account's daily/weekly/monthly caps. Override via
// TOKEN_BUDGET_DAILY in .env if this is too tight or too loose.
export const DAILY_TOKEN_BUDGET = process.env.TOKEN_BUDGET_DAILY
  ? Number(process.env.TOKEN_BUDGET_DAILY)
  : 20000;

// Rough blended claude-opus-4-8 pricing ($5 / $25 per MTok) — display only,
// not what actually gets billed.
const INPUT_COST_PER_TOKEN = 5 / 1_000_000;
const OUTPUT_COST_PER_TOKEN = 25 / 1_000_000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const USAGE_FILE = join(__dirname, ".usage.json");

interface UsageRecord {
  date: string; // YYYY-MM-DD, local server date
  inputTokens: number;
  outputTokens: number;
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

function todayKey(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Reading a stale (prior-day) file transparently resets the counter — the
// budget resets at local midnight without any cron/scheduling logic.
function loadUsage(): UsageRecord {
  if (existsSync(USAGE_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(USAGE_FILE, "utf-8"));
      if (parsed.date === todayKey()) {
        return {
          date: parsed.date,
          inputTokens: Number(parsed.inputTokens) || 0,
          outputTokens: Number(parsed.outputTokens) || 0,
        };
      }
    } catch {
      // corrupt or unreadable file — fall through to a fresh record
    }
  }
  return { date: todayKey(), inputTokens: 0, outputTokens: 0 };
}

function saveUsage(usage: UsageRecord): void {
  writeFileSync(USAGE_FILE, JSON.stringify(usage), "utf-8");
}

function toSnapshot(usage: UsageRecord): UsageSnapshot {
  const totalTokens = usage.inputTokens + usage.outputTokens;
  return {
    date: usage.date,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens,
    budget: DAILY_TOKEN_BUDGET,
    remaining: Math.max(0, DAILY_TOKEN_BUDGET - totalTokens),
    estimatedCostUsd: usage.inputTokens * INPUT_COST_PER_TOKEN + usage.outputTokens * OUTPUT_COST_PER_TOKEN,
  };
}

export function getUsage(): UsageSnapshot {
  return toSnapshot(loadUsage());
}

// Checked BEFORE calling the Anthropic API — this is the actual hard limit.
export function isBudgetExceeded(): boolean {
  const usage = loadUsage();
  return usage.inputTokens + usage.outputTokens >= DAILY_TOKEN_BUDGET;
}

export function recordUsage(inputTokens: number, outputTokens: number): UsageSnapshot {
  const usage = loadUsage();
  usage.inputTokens += inputTokens;
  usage.outputTokens += outputTokens;
  saveUsage(usage);
  return toSnapshot(usage);
}

// Manual escape hatch, triggered by the "reset for today" button that
// appears once the bar goes red (see updateUsageDisplay() in main.ts) — an
// explicit user override of their own conservative default, not a change to
// the budget itself. Zeroes today's counted tokens without touching
// DAILY_TOKEN_BUDGET, so the same cap applies again from zero.
export function resetUsage(): UsageSnapshot {
  const usage: UsageRecord = { date: todayKey(), inputTokens: 0, outputTokens: 0 };
  saveUsage(usage);
  return toSnapshot(usage);
}
