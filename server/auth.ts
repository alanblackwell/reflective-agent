import { spawn } from "child_process";
import Anthropic from "@anthropic-ai/sdk";

// Deliberately not a global/persistent credential: no ANTHROPIC_API_KEY is
// required. Instead, on each server startup we check whether an `ant auth
// login` session is currently active, and if not, walk the user through
// starting one right here in this terminal. The credential is cleared again
// (via `ant auth logout`) whenever this server shuts down — scheduled
// automatically at the next local midnight, or immediately on Ctrl-C — so
// nothing lingers active on disk beyond the day/session it was needed for.

const client = new Anthropic();

function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

// Runs a command with this process's stdio, so an interactive prompt (e.g. a
// browser-login URL) is genuinely interactive in whatever terminal `npm run
// server` was started from.
function runInteractive(command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", () => resolve(-1));
    child.on("exit", (code) => resolve(code ?? -1));
  });
}

async function hasWorkingCredentials(): Promise<boolean> {
  try {
    // Models API metadata lookup — no tokens billed, just an auth probe.
    await client.models.retrieve("claude-haiku-4-5");
    return true;
  } catch (err) {
    if (err instanceof Anthropic.APIConnectionError) {
      // A genuine network problem, not a credentials problem — don't block
      // startup guessing at it.
      console.warn("Could not verify Anthropic credentials (network issue):", err.message);
      return true;
    }
    // Anything else — no credential source configured at all (the SDK throws
    // a plain Error client-side before any request, not AuthenticationError),
    // an expired/invalid credential, an actual 401, etc. — treat all of it as
    // "needs login" rather than trying to enumerate every failure shape.
    return false;
  }
}

export async function ensureDailyAuth(): Promise<void> {
  if (await hasWorkingCredentials()) {
    console.log("Anthropic credentials already active — no login needed right now.");
    return;
  }

  console.log("");
  console.log("Reflection mode needs an Anthropic login for today.");

  if (!(await commandExists("ant"))) {
    console.log("The `ant` CLI isn't installed. Install it, then restart this server:");
    console.log("  brew install anthropics/tap/ant");
    console.log('  xattr -d com.apple.quarantine "$(brew --prefix)/bin/ant"');
    console.log("Continuing without a working credential — Reflection replies will fail until this is done.");
    return;
  }

  console.log("Starting `ant auth login` — follow the prompt below (it opens your browser).");
  console.log("");
  const code = await runInteractive("ant", ["auth", "login"]);
  console.log("");
  if (code === 0) {
    console.log("Logged in. This will be cleared automatically when this server shuts down.");
  } else {
    console.log("Login did not complete — Reflection replies will fail until you log in (restart this server to try again).");
  }
}

export async function dailyLogout(): Promise<void> {
  if (!(await commandExists("ant"))) return;
  await runInteractive("ant", ["auth", "logout"]);
}

export function msUntilNextLocalMidnight(): number {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return next.getTime() - now.getTime();
}
