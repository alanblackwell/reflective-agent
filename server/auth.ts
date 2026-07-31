import { spawn } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";

// Deliberately not a global/persistent credential: no ANTHROPIC_API_KEY is
// required. Instead, on each server startup we check whether an `ant auth
// login` session is currently active, and if not, walk the user through
// starting one right here in this terminal. The credential is cleared again
// (via `ant auth logout`) whenever this server shuts down — scheduled
// automatically at the next local midnight, or immediately on Ctrl-C — so
// nothing lingers active on disk beyond the day/session it was needed for.

const client = new Anthropic();

// The user's macOS default browser is Safari, but they want the `ant auth
// login` OAuth URL opened in Chrome specifically (where their Anthropic
// session/cookies live) instead. `open -a "<App>" <url>` opens a URL in a
// named app without touching the system default-browser setting.
const AUTH_BROWSER_APP = "Google Chrome";

function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

// Runs a command with this process's stdio, so an interactive prompt (e.g. a
// browser-login URL) is genuinely interactive in whatever terminal `npm run
// server` was started from. `env` defaults to this process's own.
function runInteractive(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.on("error", () => resolve(-1));
    child.on("exit", (code) => resolve(code ?? -1));
  });
}

// `ant auth login` (no flags) opens the OAuth URL itself and runs a local
// callback listener that completes the login automatically once the browser
// tab finishes — no code to copy/paste back. That's the flow we want to
// keep; the earlier `--no-browser` approach traded it away for a hosted
// "copy this code" page just to control which browser opened, which was the
// wrong fix.
//
// `ant` opens the URL by invoking the plain `open` command on darwin (common
// practice for Go CLIs, e.g. github.com/pkg/browser), which gets resolved
// via $PATH — so a directory containing our own `open` script, prepended to
// PATH for *only* this one child process's env, intercepts that call without
// touching the real /usr/bin/open, the system default-browser setting, or
// anything outside this single spawn. The shim redirects URL args to
// AUTH_BROWSER_APP via `open -a`, and falls back to the real `open` (default
// browser) for anything else, or if AUTH_BROWSER_APP isn't installed.
function makeBrowserShimEnv(): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ant-browser-shim-"));
  const shimPath = join(dir, "open");
  writeFileSync(
    shimPath,
    "#!/bin/sh\n" +
      'for arg in "$@"; do\n' +
      "  case \"$arg\" in\n" +
      "    http://*|https://*)\n" +
      `      /usr/bin/open -a "${AUTH_BROWSER_APP}" "$@" 2>/dev/null && exit 0\n` +
      '      exec /usr/bin/open "$@"\n' +
      "      ;;\n" +
      "  esac\n" +
      "done\n" +
      'exec /usr/bin/open "$@"\n',
  );
  chmodSync(shimPath, 0o755);
  return {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
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

  console.log(`Starting \`ant auth login\` — it will open in ${AUTH_BROWSER_APP}.`);
  console.log("");
  const { env, cleanup } = makeBrowserShimEnv();
  const code = await runInteractive("ant", ["auth", "login"], env);
  cleanup();
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
