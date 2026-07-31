# Reflective Agent

## Every session, start here

**0. API credit/billing — check this first if Reflection mode won't work.**
As of the last session, the user had not yet set up payment for API access:
Claude Pro (the claude.ai subscription) does **not** include API credits —
they're a separate product, billed separately, requiring a payment method
or prepaid balance at console.anthropic.com → Settings → Billing. If this
still hasn't been done, remind the user to add a payment method there
*before* trying `ant auth login` below — otherwise login may succeed but
chat requests will fail with a billing/permission error, not the familiar
"no credential" one. Once billing is confirmed set up, this reminder (and
this whole numbered item) can be deleted from this file.

**1. Daily login.** To use **Reflection mode**, run `npm run server` in its
own terminal and leave it in the foreground. It checks for a working
Anthropic credential; if none is active, it walks you through `ant auth
login` right there (opens your browser). The server **shuts itself down and
logs out automatically at the next local midnight** — there's no
standing/global credential sitting around. If Reflection mode isn't
responding, the most likely cause is simply that this daily server isn't
running (or shut down overnight) — restart it with `npm run server` and
follow the login prompt. Test script mode and Eliza mode don't need this
server at all. See "Key decisions" below for why this exists.

## What this is

A chat agent with a line-drawn animated character styled to resemble Charlie
Brown from Peanuts. The character's face and posture blend smoothly across
the six basic (Ekman) emotions, and its mouth animates roughly in time with
text-to-speech output. The frontend runs entirely in the browser
(TypeScript, Vite); a small local Node backend proxies real LLM calls so an
API key is never exposed client-side. State persists across sessions via
`localStorage`.

The app has three modes, chosen via a dropdown in the header:

- **Test script** — no chat. A textarea for pasting a script, a "Speak"
  button, six emotion sliders (multiple can be non-zero at once — the
  character interpolates a blended pose across all active emotions), and
  voice controls (voice picker, pitch, rate). Built first so the
  animation/TTS/lip-sync work could be iterated on without the complexity of
  a real conversational backend.
- **Eliza** — a scrollable chat (message pills, right-aligned for the user /
  left for the agent) backed by the classic ELIZA algorithm (see "Key
  decisions" below). Kept around deliberately as a free, deterministic,
  zero-latency chat backend for exercising the UI/animation pipeline — the
  user explicitly asked to keep this alongside the real LLM mode rather than
  replace it.
- **Reflection** (default mode) — the same chat UI, backed by a real LLM
  (Claude, via the local backend in `server/`). Shows a typing indicator
  while waiting on the network call.

Eliza and Reflection each keep their **own independent conversation
history** (`state.dialogHistories.eliza` / `.reflection`) — switching the
dropdown swaps which history is rendered into the shared chat UI; sending a
message only affects the currently-selected mode's history. "Reset
conversation" only clears the currently active mode's history.

## Architecture

- `src/poses.ts` — `FacePose` parameters (brow, eye, mouth, posture) for
  neutral and each of the six emotions.
- `src/blend.ts` — blends active emotion-slider weights into a single pose.
  Weights aren't required to sum to 1: leftover budget under 1 is filled by
  the neutral pose, and totals over 1 are renormalized, so multiple
  maxed-out sliders still produce a bounded result.
- `assets/charlie-brown.svg` — the character artwork: a full-body,
  hand-illustrated Charlie Brown (replacing an earlier procedurally-drawn
  head-and-shoulders version). Colors (face `#fed5bf`, sweater `#fdd30c`) are
  plain shapes (`face-fill`, `sweater-fill`) painted *underneath* the
  original black linework, not edits to the linework itself — the source art
  is one big hand-traced silhouette path, not per-feature shapes, so
  recoloring by underlay was far less risky than trying to split fill
  regions out of it. The mouth and both eyes *were* surgically extracted
  from that same monolithic path into their own `<path id="mouth"/"eye-l"/"eye-r">`
  elements (see `src/character.ts` below for why), and two `<line
  id="brow-l"/"brow-r">` elements were added from scratch — the original
  artwork had no eyebrows at all, and eyebrows are what the emotion system
  needs for anger/sadness/surprise. The nose was left baked into the static
  path since nothing needs to animate it. Two more small face-colored shapes
  (`ear-l-fill`/`ear-r-fill` ellipses, a `neck-fill` rect) cover the ears and
  the short neck gap between chin and collar, which the main `face-fill`
  ellipse doesn't reach without overshooting the cheeks — their exact
  position/radius was hand-tuned directly in the SVG (not computed), so
  nudge those numbers by eye if the art changes.
- `src/character.ts` — loads `charlie-brown.svg` (via Vite's `?raw` import,
  parsed with `DOMParser`) rather than building the figure procedurally like
  the old version did. Pulls `mouth`/`eye-l`/`eye-r`/`brow-l`/`brow-r` out by
  id and drives them every frame from the blended `FacePose`: brows get
  `y1`/`y2` + a `rotate(angle, pivotX, y)` transform around their own
  midpoint; eyes get a `translate→scale(1,ry)→translate` transform around
  their own center (there's no `ry` attribute to tweak now that they're
  paths, not ellipses); the mouth's `d` is fully regenerated each frame from
  width/curve/open/asymmetry, same technique as the old design, just
  recentered on the new art's mouth position. Runs the same
  `requestAnimationFrame` easing loop as before. **Simplification from the
  old design:** `bodyLean`/`posture` now transform the *whole* figure as one
  group, not head-lean and body-slump independently — the monolithic source
  path mixes head and body geometry inseparably, and splitting that out too
  wasn't worth the risk for this pass. **Bug fixed while wiring this up:**
  the old brow-rotation sign convention was inverted (anger rendered with
  sad-looking upturned inner corners, sadness with an angry furrow) —
  confirmed by rendering all six emotion poses standalone and eyeballing
  them; the sign is now correct (positive `browAngle` furrows the inner
  corners down, matching anger/disgust).
- `src/tts.ts` — wraps the browser's `SpeechSynthesis` API (free, no
  server/API key). Exposes voice/pitch/rate setters and drives mouth pulses
  via word-boundary events where supported, with an interval-based fallback
  everywhere else.
- `src/eliza.ts` — thin wrapper around the `elizabot` npm package (see
  "Key decisions" below for the licensing caveat).
- `src/agent.ts` — frontend client for Reflection mode: POSTs the
  conversation history to the local backend (`server/`) and returns the
  reply text, with a friendly fallback string if the backend is unreachable.
- `server/index.ts` — small Express server (run separately from the Vite
  dev server via `npm run server`) that proxies `POST /api/chat` to the
  Claude API (`claude-opus-4-8`) using the official `@anthropic-ai/sdk`.
  This exists to avoid exposing any credential in browser JS.
- `server/auth.ts` — the daily login/logout flow (see "Key decisions" and
  "Every session, start here" above).
- `server/reflections.ts` — the persistent reflective component: file-backed
  storage (`server/.reflections.json`, gitignored) of running notes on three
  fixed themes, plus the prompt-building/parsing for generating and injecting
  them. See "Key decisions" below.
- `src/storage.ts` — `localStorage` persistence for slider values, voice
  settings, last test-mode script, current app mode, the two dialog
  histories (`eliza`, `reflection`), and the speech/animation toggle
  (`speechEnabled`, see "Key decisions" below).
- `src/main.ts` — wires everything together; owns the mode dropdown and all
  DOM event handling, including the shared pause/typing-indicator/mouth-sync
  pipeline used by both dialog modes.

## Key decisions worth knowing before changing things

- **`localStorage`, not cookies**, despite persistence originally being
  described as "browser cookie" storage. Cookies are sent to a server on
  every request and capped ~4KB — neither property is relevant here since
  everything is client-side. This was a deliberate correction, not an
  oversight.
- **TTS is the Web Speech API** (`speechSynthesis`) specifically because
  it's free and built-in. Trade-off: no phoneme/viseme-level timing data is
  exposed, so mouth animation is a *heuristic* (rhythmic pulsing on word
  boundaries + a timed fallback), not phonetically accurate lip-sync. Don't
  expect to "fix" this into true viseme accuracy without swapping to a
  fundamentally different (non-free) TTS engine.
- **Dialog-mode agent replies pause before speaking** (~0.5–1.2s random
  delay) to feel more conversational, and the reply's chat pill is
  deliberately *not* rendered until speech actually starts (tied to the TTS
  `onstart` event, with a fallback to show immediately if speech synthesis
  is unsupported). This applies to both Eliza and Reflection modes
  (`scheduleAgentSpeech()` in `main.ts`), not just one.
- **"Speech & animation" header toggle** (`speechEnabled` in `storage.ts`,
  checked in `scheduleAgentSpeech()`) exists purely to speed up manual
  testing — when off, dialog-mode replies skip the pre-speech pause and
  `tts.speak()` entirely and post immediately (same code path as "TTS
  unsupported"), and the test-mode Speak button is disabled. Doesn't affect
  the character's emotion-pose rendering itself, only the speech-driven
  pause/lip-sync — useful when iterating on the Reflection-mode reflective
  notes without waiting through spoken-out-loud replies each turn.
- **Default voice tuning**: macOS ships a voice named "Junior" that reads
  younger; it's auto-selected as the default when available, with pitch
  1.65 / rate 0.50 tuned by ear to sound more child-like (closer to the
  Charlie Brown character). See `DEFAULT_PITCH`/`DEFAULT_RATE` in
  `storage.ts`.
- **ELIZA licensing is unresolved but disclosed, not hidden.** `elizabot`
  (Norbert Landsteiner's 2005 JS port of Weizenbaum's 1966 DOCTOR script) has
  **no clear OSS license** on npm (shows as "Proprietary" in registry
  metadata — no `license` field) — freely redistributed for ~20 years but
  not unambiguous. Eliza mode's first message each session
  (`Eliza.introNotice()` in `src/eliza.ts`) discloses this to the user
  directly. It's being kept intentionally (per explicit user request) as a
  zero-cost, zero-latency reference chat backend alongside the real LLM —
  not slated for removal.
- **Reflection mode calls the Claude API through a local Node proxy**
  (`server/`), never directly from the browser, to avoid shipping a
  credential to client JS. This is a separate process from the Vite dev
  server — both must be running (`npm run dev` and `npm run server`) for
  Reflection mode to work. The backend uses `claude-opus-4-8` with a short
  system prompt telling it replies are read aloud via TTS (keep responses
  brief, no markdown). No streaming yet — a single non-streaming call per
  turn. CORS is wide open (`cors()` with no origin restriction) since this
  only ever runs on localhost for a single user; tighten this before any
  kind of shared/networked deployment.
- **No standing credential — a fresh `ant auth login` each calendar day,
  by explicit user request.** The Anthropic account this project uses is
  the same one used for Claude Code development elsewhere, and the user
  wanted zero risk of a persistently-active credential quietly consuming
  quota while experimenting with this app. `server/auth.ts`'s
  `ensureDailyAuth()` runs at server startup: it probes for a working
  credential via a free Models API metadata call (`client.models.retrieve`
  — not billed), and if none is found, spawns `ant auth login`
  *interactively* (`stdio: "inherit"`) so the browser-login prompt appears
  right in whatever terminal `npm run server` was started from. A
  `setTimeout` computed to the next local midnight
  (`msUntilNextLocalMidnight()`) then runs `ant auth logout` and calls
  `process.exit(0)` — printing a clear reminder to the shell first. The same
  logout-then-exit also runs on `SIGINT`/`SIGTERM` (manual Ctrl-C), so
  nothing is left logged in beyond an intentional, active session.
  `npm run server` deliberately does **not** use `tsx watch` (unlike a more
  typical dev setup) — a file-watcher wrapper would keep the outer process
  alive after `process.exit()`, undermining "the server actually shuts
  itself down." Editing `server/*.ts` now requires a manual restart to pick
  up changes, which is an acceptable trade for a truthful shutdown.
  `ANTHROPIC_API_KEY` in `.env` still works as an alternative/override (SDK
  credential precedence: an explicit key always wins over an `ant` profile)
  for anyone who'd rather use a standing key — the default flow just doesn't
  set one up automatically.
  **Caveat worth knowing:** the credential-check logic initially had a bug
  where the SDK's "no credential source configured at all" error is a plain
  `Error`, not `Anthropic.AuthenticationError` — the original code only
  caught the latter and would have silently skipped the login prompt on the
  most common case (nothing set up yet). Fixed by inverting the check: only
  `Anthropic.APIConnectionError` (genuine network failure) is treated as
  "can't verify, don't block"; everything else is treated as "needs login."
  Worth remembering if this logic is touched again.
- **Hard daily token budget enforced server-side** (`server/usage.ts`),
  because the Anthropic account used for this project's own development also
  has daily/weekly/monthly usage caps, and the user was explicitly worried
  about the app eating into those while experimenting. `isBudgetExceeded()`
  is checked *before* `client.messages.create()` is ever called — a 429 is
  returned instead, so an exhausted budget cannot spend one more token.
  Usage (input/output tokens from `response.usage`) is persisted to
  `server/.usage.json` (gitignored) keyed by local calendar date, so it
  survives server restarts and resets automatically at local midnight with
  no scheduling logic — reading a stale-dated file just starts a fresh
  count. Default budget is a deliberately conservative 20,000 tokens/day
  (~$0.10–$0.50 depending on input/output mix); override via
  `TOKEN_BUDGET_DAILY` in `.env`. The frontend shows a persistent progress
  bar + estimated cost in the header (`updateUsageDisplay()` in
  `src/main.ts`, fed by `GET /api/usage`) and disables the Reflection chat
  input once the budget is hit — that's a UX courtesy, not the actual
  enforcement, which is server-side and mode-agnostic (Eliza and test-script
  modes never call the API at all, so they're unaffected regardless).

- **Persistent reflective component, deliberately separate from dialogue
  history.** This app exists to study the value of giving a conversational
  agent a persistent *reflective* memory, independent of whether the raw
  dialogue itself persists — dialogue content is intentionally disposable (a
  new Reflection-mode conversation can always start clean; nothing about the
  experiment requires the transcript to survive). What does persist is a
  compact set of running notes on three fixed themes: **personhood** (was
  this dialogue sustaining of the agent's personhood as a persistent agent?),
  **intersubjectivity** (did this dialogue develop an intersubjective
  relationship with the interlocutor?), and **generativity** (will this
  combination continue to be generative after the records are erased?).
  Stored server-side in `server/.reflections.json` (gitignored, same
  file-backed pattern as `server/usage.ts`) rather than browser
  `localStorage` — this is the agent's own memory, not the client's, so it
  should survive regardless of which browser/machine talks to the backend.
  Reflection is generated **once per session**, triggered by the existing
  "Reset conversation" button in Reflection mode specifically (`POST
  /api/reflect` in `server/index.ts`) — not after every turn, to keep this to
  one extra LLM call per session against the same tight daily token budget
  used for normal replies (`recordUsage`/`isBudgetExceeded` from
  `server/usage.ts` apply here too). Sessions with no user turns (e.g.
  resetting an untouched greeting-only conversation) are skipped. The model's
  reply is parsed from a fixed labeled-text format (`PERSONHOOD:` /
  `INTERSUBJECTIVITY:` / `GENERATIVITY:`, see `parseReflectionResponse` in
  `server/reflections.ts`); on a parse failure the previous notes are kept
  unchanged rather than persisting garbage. "Review notes at the start of
  each session" is satisfied by `buildSystemPrompt()` in `server/index.ts`
  appending the current notes to every `/api/chat` system prompt — since a
  new session always starts with an empty dialogue, its first (and every
  subsequent) reply-generating call already carries them as context, so no
  separate session-start round-trip is needed. Notes are shown in a visible,
  expandable panel in the UI (Reflection mode only) so they can actually be
  inspected as part of evaluating the mechanism, not just used as hidden
  context. Eliza mode is untouched by any of this — it's a deliberately
  separate deterministic baseline, not the thing under study.

## Known issues / open items for the next session

1. **No automated tests.** Verification so far has been `npx tsc --noEmit`
   (both `tsconfig.json` and `tsconfig.server.json`) plus manually starting
   the dev server and backend and checking they serve/compile (and for
   TTS/animation/LLM-reply quality specifically, manual browser testing —
   this agent's tool access couldn't drive a real browser to see, hear, or
   have a live conversation). Actual UX correctness (does it sound right,
   does the mouth look synced, do replies feel good, does layout hold up on
   a resized window) has been eyeballed by the user, not verified
   automatically.
2. **Pre-speech pause and typing indicator are dialog-mode only.** The
   test-mode "Speak" button fires immediately by design (it's a manual
   animation/TTS testing tool).
3. **No streaming, no conversation trimming.** Reflection mode resends the
   full conversation history every turn with no compaction — fine for short
   test conversations, but will grow unbounded token cost/latency in a long
   session. Not addressed yet.
4. **No persona/system-prompt tuning yet.** The backend's system prompt is a
   generic "brief, TTS-friendly assistant" — no connection to the Charlie
   Brown character or any specific personality. Easy to extend in
   `server/index.ts`'s `SYSTEM_PROMPT` if wanted.
5. **The token budget is daily only** — the user's actual Anthropic account
   has daily, weekly, *and* monthly caps, but only the daily one is modeled
   here (see "Key decisions" above). A conservative default (20,000
   tokens/day) makes this a reasonable proxy in practice, but it can't
   detect "we're already close to the weekly/monthly cap for other reasons."
   If tighter coverage is wanted, extend `server/usage.ts` with
   weekly/monthly rolling windows the same way the daily one works.
6. **Character geometry constants in `src/character.ts` are hand-measured
   from `assets/charlie-brown.svg`**, not computed at runtime (eye centers,
   brow pivots, mouth center — see the comment block above `EYE_L_CENTER` in
   that file). If the artwork is edited in Inkscape again (moved eyes,
   resized head, etc.), these constants will silently drift out of alignment
   and need re-measuring by hand; there's no automated check that catches
   this.
7. **No independent head-lean vs. body-slump.** `bodyLean`/`posture` move
   the whole figure together (see "Key decisions" above) — a deliberate
   scope cut, not an oversight. Doing it properly would mean splitting the
   monolithic outline path into head and body groups the same way
   mouth/eyes were split out.

## Running it

Two processes, both required for Reflection mode (Eliza mode and Test
script mode only need the first):

```
npm install
npm run dev       # Vite dev server (frontend)
npm run server    # local backend proxy for Reflection mode — run this in its
                   # own foreground terminal; it will prompt for `ant auth
                   # login` if needed, and shuts itself down + logs out at
                   # the next local midnight (see "Every session, start here")
```

`.env` is gitignored and normally not needed — see "Key decisions" above for
the daily-login flow. `ANTHROPIC_API_KEY` in `.env` remains a supported
override for anyone who wants a standing credential instead.

```
npx tsc --noEmit -p tsconfig.json          # type-check frontend
npx tsc --noEmit -p tsconfig.server.json   # type-check backend
npm run build                              # production build (frontend only)
```

No test suite exists yet. Chrome is recommended for development — it has
the most complete Web Speech API support (voices list, word-boundary
events) of the major browsers.
