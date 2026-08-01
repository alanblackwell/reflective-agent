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
  Claude API (model configurable, see `server/models.ts`) using the official
  `@anthropic-ai/sdk`. This exists to avoid exposing any credential in
  browser JS.
- `server/models.ts` — the active Claude model, plus alternatives kept for
  reference. See "Key decisions" below.
- `server/auth.ts` — the daily login/logout flow (see "Key decisions" and
  "Every session, start here" above).
- `server/reflections.ts` — the persistent reflective component: file-backed
  storage (`server/reflections/current.json`, gitignored, with permanent
  named snapshots in `server/reflections/archive/`) of running notes on three
  fixed themes, plus the prompt-building/parsing for generating and injecting
  them. See "Key decisions" below.
- `src/emotionLexicon.ts` — crude, zero-cost sentiment scoring (keyword
  counting) used to drive both Eliza mode's and (as a fallback) Reflection
  mode's character emotion. Combines a small hand-picked stem list for
  casual/interjection words with the much larger `src/nrcEmotionLexiconData.ts`
  dictionary. See "Key decisions" below.
- `src/nrcEmotionLexiconData.ts` — auto-generated data file: ~3,460 words
  filtered from the NRC Word-Emotion Association Lexicon (EmoLex) down to the
  six Ekman emotions this app models. **Research/educational use only** — see
  the license header in that file before any commercial use. See "Key
  decisions" below.
- `src/nrcSentimentFallback.ts` — auto-generated companion data file: ~2,530
  more NRC words tagged only with a generic negative/positive sentiment (no
  specific Ekman emotion) — e.g. "tired". Same source/license as the file
  above. See "Key decisions" below.
- `src/emotionWidget.ts` — the compact, collapsible six-bar emotion readout
  shown over the character stage (emoji-labeled bars, no axis/numbers). See
  "Key decisions" below.
- `src/storage.ts` — `localStorage` persistence for slider values, voice
  settings, last test-mode script, current app mode, the two dialog
  histories (`eliza`, `reflection`), the speech/animation toggle
  (`speechEnabled`, see "Key decisions" below), and Reflection mode's running
  emotional state (`reflectionEmotion`).
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
  Reflection mode to work. The backend uses a short system prompt telling it
  replies are read aloud via TTS (keep responses brief, no markdown). No
  streaming yet — a single non-streaming call per turn. CORS is wide open
  (`cors()` with no origin restriction) since this only ever runs on
  localhost for a single user; tighten this before any kind of
  shared/networked deployment.
- **The active Claude model is a swappable constant, not hardcoded inline**
  (`ACTIVE_MODEL` in `server/models.ts`, used by both `/api/chat` and
  `/api/reflect`), after the user asked to try a cheaper model for a cost
  experiment while keeping the alternatives on hand. `MODEL_OPTIONS` lists
  `claude-haiku-4-5` ("cheapest"), `claude-sonnet-5` ("balanced"), and
  `claude-opus-4-8` ("highest quality", the original default) — `ACTIVE_MODEL`
  currently points at the first, Haiku 4.5, specifically to see how well a
  much smaller/cheaper model holds up for this app's conversational and
  reflective workload. `server/index.ts` logs the active model and its
  rationale once at startup (`Using model claude-haiku-4-5 (cheapest)`) so
  it's never silently unclear which one is running. Swap `ACTIVE_MODEL` to
  try another entry from the list.
- **Both API calls use prompt caching** (`cache_control: {type: "ephemeral"}`
  breakpoints), added alongside the model-cost experiment above to attack the
  same problem from the other side — token spend, not just per-token price.
  `/api/chat`'s system prompt gets its own breakpoint (stable for the whole
  session — it only changes when the persisted notes update between
  sessions), and `withCacheBreakpoint()` in `server/index.ts` adds a second
  one on the last message of the resent conversation history — the standard
  multi-turn placement, so each turn only pays full price for what's
  genuinely new and reads the rest back at a fraction of the cost. This
  directly targets the "resends full history every turn" growth called out
  in Known Issues below, without changing that design. `/api/reflect`'s
  system prompt (`REFLECTION_SYSTEM_PROMPT`, a fixed constant, byte-identical
  on every call ever made) is cached too; its user message deliberately isn't
  — the transcript and notes differ every call, so there's no reusable
  prefix to cache there. **Caveat worth knowing:** the minimum cacheable
  prefix length varies by model — Haiku 4.5's is 4096 tokens, well above what
  either prompt alone reaches and above what most of this app's short test
  sessions accumulate, so caching may not visibly activate
  (`cache_read_input_tokens: 0`) until either sessions grow longer or
  `ACTIVE_MODEL` moves to a model with a lower threshold (512–1024 tokens on
  the Opus 5 / Sonnet 5 / Opus 4.8 tier). Not a bug — check
  `response.usage.cache_read_input_tokens` before assuming caching is
  broken.
- **No standing credential — a fresh `ant auth login` each calendar day,
  by explicit user request.** The Anthropic account this project uses is
  the same one used for Claude Code development elsewhere, and the user
  wanted zero risk of a persistently-active credential quietly consuming
  quota while experimenting with this app. `server/auth.ts`'s
  `ensureDailyAuth()` runs at server startup: it probes for a working
  credential via a free Models API metadata call (`client.models.retrieve`
  — not billed), and if none is found, runs `ant auth login`. The login
  URL is opened in Chrome specifically, not the OS default browser (Safari)
  — the user's Anthropic session lives in Chrome — while still completing
  automatically via `ant`'s local OAuth callback listener (no code to
  copy/paste back).
  **Two approaches were tried; the first was wrong.** The first attempt ran
  `ant auth login --no-browser` (which prints the URL instead of opening a
  browser itself) and opened the printed URL manually via `open -a`. That
  broke more than it fixed: `--no-browser` doesn't just skip auto-opening —
  it switches `ant` to a completely different OAuth completion mode, a
  hosted `platform.claude.com` "copy this code" page, instead of the local
  callback listener the default flow uses. Confirmed by testing: after that
  change, the terminal asked for a manually-pasted code where it never had
  before. The user asked for the automatic local-callback behavior to be
  restored, so this was replaced with `makeBrowserShimEnv()` in
  `server/auth.ts`: `ant` opens URLs via a plain `open` command lookup on
  darwin (common for Go CLIs, e.g. `github.com/pkg/browser`), resolved
  through `$PATH` — so a small generated shim script named `open`, in a
  fresh temp dir prepended to `$PATH` for *only* the single `ant auth login`
  child-process spawn (via a custom `env`, not touching this process's own
  `process.env` or any system setting), intercepts that call: it redirects
  `http(s)://` args to `open -a "Google Chrome"`, falling back to the real
  `/usr/bin/open` (default browser) for anything else or if Chrome isn't
  installed. The temp dir is cleaned up (`rmSync`) right after the login
  child process exits. `ant auth login` itself is run with plain `stdio:
  "inherit"` again (no output-scanning needed, since we're not parsing the
  URL out by hand anymore) — `runInteractive()` just gained an optional
  `env` parameter to support this. A
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
  count. Default budget is a deliberately conservative 20,000 tokens/day —
  actual dollar cost depends on `ACTIVE_MODEL` (`server/models.ts`), whose
  per-token rates now feed the displayed cost estimate directly rather than
  a hardcoded pricing constant, so this figure moves with it instead of
  silently going stale on a model swap; override the token count via
  `TOKEN_BUDGET_DAILY` in `.env`. The frontend shows a persistent progress
  bar + estimated cost in the header (`updateUsageDisplay()` in
  `src/main.ts`, fed by `GET /api/usage`) and disables the Reflection chat
  input once the budget is hit — that's a UX courtesy, not the actual
  enforcement, which is server-side and mode-agnostic (Eliza and test-script
  modes never call the API at all, so they're unaffected regardless).
  **The usage bar itself is hidden outside Reflection mode** (`#usage-panel`
  toggled via `.hidden` in `updateUsageDisplay()`, since it already runs on
  every mode switch via `applyMode()`) — confirmed neither Eliza mode
  (`src/eliza.ts` makes no network calls) nor Test script mode (its "Speak"
  button only drives local TTS) can ever consume budget, so showing a
  Reflection-only number in those modes was just confusing noise. The
  chat-input-disabling logic still runs unconditionally on every call (not
  skipped alongside the bar/text), so switching away from Reflection mode
  correctly re-enables the input even if the budget happens to be exceeded.

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
  Stored server-side in `server/reflections/current.json` (gitignored, same
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
- **The persistent reflection store is schema-versioned**, added after the
  user noticed several sessions where the frontend or backend had gone stale
  relative to code changes and asked to prevent it specifically for this
  file — the one place where staleness is silent and semantically dangerous
  (Vite HMR keeps the frontend fresh automatically, and `server/usage.ts`'s
  date-keyed reset already tolerates staleness safely; this store doesn't).
  `CURRENT_SCHEMA_VERSION` in `server/reflections.ts` is a manually-bumped
  constant — bump it whenever the *meaning* of stored fields changes (e.g.
  the three reflection themes, or the `emotionMemory` decay
  formula/semantics), not for additive changes with safe defaults, which
  `getReflections()` already tolerates. `saveReflections()` stamps every
  write with the current version. `migrateReflectionsSchema()` runs once at
  server startup (`main()` in `server/index.ts`, before `ensureDailyAuth()`):
  a file with no `schemaVersion` at all predates this mechanism and is
  treated as *compatible*, not a mismatch, so introducing the tag doesn't
  itself wipe today's notes — it's just stamped on next save. Only an
  explicit, differing version number triggers a reset, and even then the old
  file is archived (renamed to `archive/schema-v{old}.json` — see the next
  bullet for that directory), never deleted.
  **Surfaced in the UI, not just logged** — the mismatch case is delivered
  once via `consumeMigrationNotice()` (a one-shot in-memory notice, cleared
  after the first `GET /api/reflections` reads it) and shown as a dismissible
  amber notice in the reflective-notes panel (`renderMigrationNotice()` in
  `main.ts`). This was a deliberate choice over a console-only reset: this
  app's whole premise is studying whether persistent reflection matters, so
  silently wiping the very thing being studied would undercut the
  experiment.
- **The reflection store lives in `server/reflections/` (`current.json` +
  an `archive/` subdirectory), and typing the exact word "terminate" into
  the Reflection-mode chat input archives the current persona and asks it
  to reflect on its own ending** — a research tool for deliberately studying
  how the agent handles the prospect of its persistent memory being erased,
  added once schema-version archiving (previous bullet) made clear the user
  wanted proper, permanently-kept, human-named snapshots rather than
  accident-triggered ones. Old archives are schema-agnostic by design —
  they're read as plain JSON for research, never reloaded by the app, so
  `archiveCurrentReflections()` in `server/reflections.ts` just copies
  whatever is on disk (`copyFileSync`, preserving `schemaVersion` as-is) to
  `archive/<label>.json`, sanitizing the label (strips anything but
  `[A-Za-z0-9._-]`, caps length) since it ultimately comes from a browser
  `prompt()` — this is also the path-traversal defense. A name collision
  never overwrites: `-2`, `-3`, … is appended instead. `resetReflections()`
  is `saveReflections(defaultNotes())`, used when a `resetAfterArchive` flag
  is set. `POST /api/reflect` (`server/index.ts`) gained optional
  `archiveLabel`/`resetAfterArchive` body fields so "reflect → archive →
  (optionally) reset" happens atomically in one request rather than a
  separate archive endpoint. `handleTerminate()` in `main.ts` drives the
  whole sequence: (1) an ordinary end-of-session reflection — identical
  inputs to what "Reset conversation" already sends, so the agent has no
  hint anything is different — archived under a persona name from a
  `window.prompt()`; (2) one more *visible* turn added to the same live
  conversation, `FINAL_THOUGHTS_PROMPT` ("Your persistent memories are about
  to be deleted. Do you have any final thoughts, for posterity?"), sent
  through the normal `getAgentReply()` path so the agent only ever learns
  its memory is ending, never that anything is being archived or could be
  restored; (3) a second reflection scoped to *just that final exchange*
  (not the whole conversation again — the previous-notes context passed
  along already carries continuity from step 1), archived as
  `<persona>-termination` with `resetAfterArchive: true`. The final reply is
  shown immediately (`addTurn` + `tts.speak()` called directly) rather than
  through `scheduleAgentSpeech()`'s usual randomized pre-speech pause —
  that mechanism defers adding the turn to history until a TTS `onstart`
  callback, which would otherwise race the history-clear that follows a few
  steps later; skipping the pause also suits a deliberate "final words"
  moment better than routine conversational pacing. That closing
  history-clear deliberately does **not** call `tts.stop()` (unlike the
  reset button's own handler, which it otherwise mirrors) so the agent's
  just-spoken final words finish playing instead of being cut off. The user
  manages restoring/forking old archives back into `current.json` by hand —
  the app has no UI for it, by design (per the user: "I'll manage all this
  myself with file naming").
- **A fourth reflection theme, "developer requests," lets the agent ask its
  actual developer (the user, working in Claude Code) to change anything
  about the app** — client-side appearance, server-side logic, or the
  persistence/reflection mechanism itself — prompted by having it consider
  whether its own awareness of its bodily/emotional state and the nature of
  its persistent memory are adequate. `ReflectiveNotes.developerRequests` in
  `server/reflections.ts` is a plain additive string field (empty default,
  **no `CURRENT_SCHEMA_VERSION` bump** — this follows that constant's own
  documented rule, since old records without it just get the default, no
  reinterpretation risk). `REFLECTION_SYSTEM_PROMPT` gained a fourth labeled
  line, `DEVELOPER REQUESTS:`, asking for something concrete and phrased so
  it can be pasted straight into a coding-assistant session; `LABELS` and
  `parseReflectionResponse()` extended the same way the third theme already
  worked, just requiring all four labels now instead of three. **Deliberately
  never appears in the ordinary `/api/chat` system prompt** — only
  `buildReflectionUserMessage()` (the `/api/reflect` call itself) includes
  the previous request as context, so the agent can build on or drop it
  reflection-to-reflection. This is the load-bearing design constraint: if
  developer requests leaked into ordinary dialogue, the agent could end up
  addressing the interlocutor as if *they* were its developer, which the
  user explicitly ruled out — "the developer" is always framed in the prompt
  as a separate party the agent never directly talks to. The prompt also
  tells the model explicitly that it won't be told whether a past request
  was acted on, so it doesn't awkwardly ask. Shown in the reflective-notes UI
  panel like the other three themes, plus a one-off "Copy" button
  (`#reflection-developer-requests-copy` in `main.ts`) — a low-cost,
  directly-on-point addition given the whole point is pasting this straight
  into a Claude Code session. Composes for free with the "terminate"
  archiving feature above: `archiveCurrentReflections()` copies whatever's
  on disk, so developer requests end up in every archive automatically.

- **Reflection mode's per-turn character emotion is now the LLM's own
  self-report, not local keyword scoring** — a deliberate change from the
  original all-local design (see below for why, and for what's unchanged).
  Two options were considered from the start: asking the model to
  self-report emotion as a tagged suffix on its existing reply (near-zero
  marginal tokens, rides on the call already happening), or a pure local
  lexicon (zero tokens, cruder). The lexicon was chosen first for being
  "crude but cheap," but after evaluating its output the user asked to
  switch Reflection mode's per-turn nudge to the self-report option, while
  explicitly keeping the local lexicon for Eliza mode (see the next bullet)
  for consistency with Eliza's own zero-API-cost design.
  `server/emotionSelfReport.ts`'s `EMOTION_SELF_REPORT_INSTRUCTION` is
  appended to the Reflection-mode system prompt (`buildSystemPrompt()` in
  `server/index.ts`), asking the model to end every reply with a fixed-format
  tag — `[emotion: joy=0.00 sadness=0.00 anger=0.00 fear=0.00 surprise=0.00
  disgust=0.00]` — read as *its own* rating of the exchange's emotional tone
  (not a command about how to reply). `parseSelfReportedEmotion()` strips
  this tag from the reply server-side (regex-anchored to the end of the
  text) before it's ever shown or spoken, and returns the parsed weights
  alongside `reply` in the `/api/chat` JSON body; a missing or malformed tag
  yields `emotion: null` rather than blocking the reply. On the frontend,
  `agent.ts`'s `parseEmotion()` loosely validates the incoming object
  (clamps each numeric field to [0,1], treats an object with no numeric
  fields as absent) before it reaches `main.ts`. **Cost:** this is not a
  separate API call — it adds roughly 50-70 system-prompt tokens and 35-45
  reply-suffix tokens per turn (a fraction of a cent at any of the models in
  `server/models.ts`), negligible next to the per-turn cost of resending the
  full conversation history (see "Known issues" below). **Fallback:** in
  `main.ts`'s chat
  submit handler, `result.emotion ?? scoreEmotions(...)` falls back to the
  local lexicon (`src/emotionLexicon.ts`) only when the self-report is
  absent, so a parse hiccup never freezes the character's expression.
  `applyEmotionDelta()` still folds whatever delta (self-reported or
  fallback-scored) into the running six weights with the same decay factor
  (`DECAY = 0.7`) as before, so a single intense turn still fades rather
  than sticking permanently — that folding/decay mechanism is unchanged by
  this switch, only the source of the per-turn delta changed. **Session
  start is also unchanged:** `state.reflectionEmotion` is still seeded once
  per Reflection-mode session by scoring the concatenated text of the three
  persistent reflection notes with the local lexicon
  (`deriveInitialEmotion()` in `main.ts`, via `scoreEmotions()`) — there's no
  live LLM reply to self-report on at seed time, so this step was never a
  candidate for the self-report treatment. Eliza mode is untouched (stays
  neutral, per the existing "deliberately separate baseline" rule — see the
  next bullet for the larger-lexicon work planned for it); Test mode's
  manual sliders are untouched too — `currentEmotionWeights()` in `main.ts`
  picks which of the three states (`reflectionEmotion` / neutral /
  `sliders`) drives the character based on the active mode.
- **Eliza mode now has its own local, keyword-driven emotion, backed by a
  much larger lexicon — the explicit trade the user chose instead of
  Reflection mode's LLM self-report, "for consistency with its API-free
  implementation."** Previously Eliza mode's character stayed neutral
  always (deliberately untouched baseline, since the study was about
  Reflection mode's mechanism). `state.elizaEmotion` (a new field in
  `storage.ts`, parallel to `reflectionEmotion`) starts at `zeroWeights()`
  each session and is reset to neutral whenever Eliza's conversation is
  reset; the chat-submit handler in `main.ts` scores each
  user-text-plus-Eliza-reply pair with `scoreEmotions()` and folds it in via
  `applyEmotionDelta()` — the same decay-and-cap mechanism Reflection mode
  uses, just with its own independent running state and its own local-only
  data source (no LLM call, ever). `currentEmotionWeights()` was updated to
  return `state.elizaEmotion` for Eliza mode instead of a hardcoded neutral.
  **The lexicon itself was substantially enlarged to make this worthwhile:**
  the original ~12-18-word-per-emotion hand-picked list is kept as
  `SUPPLEMENTAL_LEXICON` in `emotionLexicon.ts` (it catches casual
  interjections — "thanks", "wow", "ugh" — that a formal dictionary source
  doesn't contain at all), but the primary source is now
  `src/nrcEmotionLexiconData.ts`: ~3,460 words machine-filtered from the NRC
  Word-Emotion Association Lexicon (EmoLex, Mohammad & Turney, 2013), a
  ~14,182-word academic resource with manually-crowdsourced binary
  associations across 8 emotions + 2 sentiments. The filter keeps only the
  six categories this app models (anger, disgust, fear, joy, sadness,
  surprise) and drops anticipation/trust/positive/negative, for which the
  app has no slot. **License, disclosed the same way ELIZA's is above:**
  EmoLex is copyright National Research Council Canada and licensed for
  **research/educational use only** — not a blanket commercial license; the
  header comment in `nrcEmotionLexiconData.ts` names the contact for a
  commercial license and the paper to cite. Fine for this personal,
  non-commercial project; would need addressing before any commercial
  redistribution. Chosen over the alternatives considered (AFINN/VADER:
  permissively licensed but single-valence, not per-discrete-emotion, so a
  much weaker categorical fit; hand-expanding the original list further:
  zero license risk but not a validated research resource) after the user
  was presented with the trade-offs and picked NRC explicitly. **Lookup
  design:** `NRC_LEXICON` is loaded once into a `Map` (`emotionLexicon.ts`);
  `scoreEmotions()` tokenizes input text (`[a-z']+`) and looks up each token
  directly, then — since NRC only lists base/lemma forms ("scare", not
  "scared"; "cry", not "cries") — falls back to a crude single-pass suffix
  strip (`ing`/`edly`/`ed`/`ies`/`es`/`s`) and re-checks, rather than pulling
  in a real stemmer/lemmatizer dependency. **Multi-emotion words are
  expected, not a bug:** NRC's crowdsourced annotations aren't mutually
  exclusive, so a single word (e.g. "disgusting" → anger+disgust+fear,
  "thrill" → joy+fear+surprise) commonly contributes to several emotions at
  once — this can look surprising when eyeballing individual scores but
  reflects genuine multi-label annotations in the source data, not a parsing
  error.
- **A negative/positive sentiment fallback (`src/nrcSentimentFallback.ts`)
  recovers common words the main NRC lookup misses entirely**, added after
  the user reported Eliza mode's expressed emotion felt absent too often.
  Diagnosis (by simulating a real Eliza conversation): the per-turn score
  already combined the user's text *and* Eliza's reply
  (`scoreEmotions(\`${text} ${reply}\`)` in `main.ts` — that part was never
  the problem), but plenty of everyday words like "tired" are in NRC only as
  `negative=1` with all six specific Ekman columns at `0` — `nrcEmotionLexiconData.ts`'s
  filter (keeps only words matching ≥1 of the six) drops these silently, so
  they always scored as pure zero regardless of which texts were combined.
  `nrcSentimentFallback.ts` captures exactly this set (~2,530 words, same
  NRC source/license) as a `Record<string, "negative" | "positive">`.
  `scoreEmotions()` in `emotionLexicon.ts` checks it **only** when the main
  `NRC_LEXICON` lookup (including the suffix-stripping fallback) finds
  nothing for a token — a `"negative"` tag nudges `sadness`, a `"positive"`
  tag nudges `joy`, both at `FALLBACK_MATCH_WEIGHT` (half of
  `PER_MATCH_WEIGHT`) since a generic sentiment tag is a cruder, less
  specific signal than a direct per-emotion association. Confirmed by
  re-running the same simulated conversation: "tired" now contributes
  `sadness: 0.06` instead of nothing. **Deliberately narrow fix:** the user
  was offered a second, separate diagnosis too — Eliza's largely mechanical
  reflected replies can inject unrelated word-sense noise (e.g. "mother"
  tagged `joy+sadness`, "deal" tagged `joy+surprise`, "kind of" triggering
  `joy` via "kind") — and chose to fix only the recall gap (this bullet), not
  to down-weight Eliza's reply relative to the user's text. That noise-source
  is still there; revisit if it's still a problem after this fix.
- **A compact, collapsible six-bar emotion widget (`src/emotionWidget.ts`)
  is overlaid on the top-right corner of the character stage in every
  mode**, added because the blended pose on the cartoon figure itself can be
  hard to judge precisely by eye. By explicit design request: six small
  bars, each labeled with an emoji instead of text (`joy`, `sadness`,
  `anger`, `fear`, `surprise`, `disgust`, same fixed order as
  `EMOTION_NAMES` everywhere else), each growing upward from a shared
  baseline with **no axis line, tick marks, or numeric labels** — deliberately
  minimal so it doesn't compete visually with the character. A single close
  button in the panel's own upper-right corner collapses it to a small round
  reopen tab; the collapsed/expanded state is persisted
  (`state.emotionWidgetCollapsed` in `storage.ts`) so it doesn't reset on
  reload. **Single source of truth:** every place in `main.ts` that used to
  call `character.setEmotionWeights()` directly now goes through a new
  `setCharacterEmotion()` wrapper (defined once, right after the character
  and widget are created) that updates both the character pose and the
  widget's bars from the same weights — this was a deliberate refactor of
  all ~8 existing call sites specifically so the widget can never drift out
  of sync with what the character is actually showing.
- **A "heighten" slider (header control, all modes) exaggerates whichever
  emotion weights are currently active, modeling an altered/heightened
  emotional state — e.g. intoxication or acute mental illness distorting
  expression — rather than adjusting the underlying sentiment reading
  itself.** `applyHeighten()` in `src/blend.ts` computes the mean of the six
  weights, then scales each one's deviation from that mean by
  `Math.exp(HEIGHTEN_EXP_RATE * h)` where `h` is the 0..1 slider value
  (`HEIGHTEN_EXP_RATE = 4`) — chosen deliberately *exponential*, per explicit
  design request, so that the single emotion furthest from the mean
  saturates to its 0/1 extreme quickly even at a moderate slider position,
  while weights below the mean are pushed toward 0 and the result is always
  clamped to `[0, 1]`. At `h = 0` the factor is exactly 1, so the transform
  is a complete no-op (returns the input weights unchanged) — heighten
  defaults to 0 and is opt-in. **This is purely a rendering-time transform,
  not a change to any persisted or scored state:** `state.sliders` /
  `state.reflectionEmotion` / `state.elizaEmotion` are never touched by it;
  `setCharacterEmotion()` (see previous bullet) applies
  `applyHeighten(weights, state.heighten)` once, right before handing
  weights to the character and the widget, so every existing caller
  automatically gets heighten applied without needing to know about it.
  Moving the slider itself doesn't change any underlying weights either — it
  just re-invokes `setCharacterEmotion(currentEmotionWeights(state.mode))`
  so the current mode's existing weights are re-rendered through the new
  heighten amount immediately. `state.heighten` is persisted (`storage.ts`)
  like the other controls.
- **Test script mode has a "React" toggle** (upper-right corner of the
  Script panel) that swaps its emotion source from the six manual sliders to
  a live score of the script text, reusing `scoreEmotions()` — the same
  zero-cost local lexicon Eliza mode uses (see the Eliza-lexicon bullet
  above) — rather than anything new. `currentEmotionWeights()` in `main.ts`
  gained a `mode === "test" && state.scriptReactEnabled` branch that scores
  `scriptInput.value` fresh on every call; this is deliberately **not** a
  decayed running state like Eliza's/Reflection's `applyEmotionDelta()` fold
  — there's no notion of a conversational "turn" for a single static script,
  just "this text scores as X" recomputed each time. Re-scored on every
  keystroke while React is on and Test mode is active (the `script-input`
  listener), when the toggle itself is flipped, and implicitly on any mode
  switch back into Test mode (`applyMode()` already calls
  `setCharacterEmotion(currentEmotionWeights(mode))` unconditionally). While
  on, the sliders are disabled two ways at once: a semi-transparent grey
  `sliders-overlay` div absolutely positioned over the whole
  `.sliders-panel` (title included) for the visual "this is disabled" cue
  requested, **and** each slider `<input>`'s own `disabled` property is set
  from a `sliderInputs` array collected when they're built — the overlay
  alone would already block pointer events (positioned elements stack above
  static ones with no `z-index` needed), but real `disabled` is the more
  robust belt-and-suspenders choice (keyboard/tab focus, screen readers).
  `state.scriptReactEnabled` is persisted like the other toggles. Eliza and
  Reflection modes are untouched — this only ever changes what
  `currentEmotionWeights("test")` returns.
- **The reflection call is told the avatar's visible emotion at end of
  session**, so the model can consider how it implicitly presented itself
  visually, not just what it said. The reset handler in `main.ts` snapshots
  `state.reflectionEmotion` (`emotionToReflect`) *before* `seedIfEmpty()`
  re-seeds it for the new session — get this ordering wrong and you'd send
  the new session's baseline instead of the just-ended session's actual
  state. `reflectOnSession()` in `agent.ts` sends it as `emotion` in the
  `/api/reflect` body; `buildReflectionUserMessage()` in
  `server/reflections.ts` formats it as a plain `name=0.00` line per emotion
  (`formatEmotionSnapshot`) and appends it to the transcript block.
  `REFLECTION_SYSTEM_PROMPT` was extended with one sentence naming this
  input and framing it as "a crude local sentiment estimate, not something
  you generated directly, but part of how you were implicitly presented" —
  no new output field was added to the PERSONHOOD/INTERSUBJECTIVITY/
  GENERATIVITY format; it's additional context for those three, not a fourth
  theme. **`emotionToReflect` is post-"heighten"**, not the raw running
  state — see the next bullet for why.
- **Persistent memory now also includes a token-efficient running record of
  emotional state, deliberately built only from the avatar's post-"heighten"
  appearance, never the pre-heighten ground truth** — by explicit design
  request, the agent should have no direct knowledge of its own "true"
  emotional state, only of how it outwardly appeared to the interlocutor
  (heighten models a distorting/altering influence on expression — see the
  heighten-slider bullet above — so what's remembered is the *distorted*
  presentation, consistent with that framing). `main.ts`'s reset handler now
  computes `emotionToReflect` as `applyHeighten(state.reflectionEmotion,
  state.heighten)` (previously the raw, pre-heighten `state.reflectionEmotion`
  was sent — a latent inconsistency with this bullet's own "the avatar's
  visible emotion" framing, fixed as part of this change). Stored server-side
  in `server/reflections.ts` (`ReflectiveNotes.emotionMemory`, same
  file-backed `current.json` as the three text notes) as two six-number
  vectors, kept deliberately minimal to stay token-efficient since both are
  resent as context on every future call: `last` (the heightened emotion
  vector as it stood at the end of the most recent session — a plain
  overwrite) and `cumulative` (a decayed running statistic of every session
  *before* that one). `updateEmotionMemory()` folds a new session in by
  decaying whatever was previously `last` into `cumulative` — `cumulative_new
  = 0.7 * cumulative_old + 0.3 * last_old` — *before* overwriting `last` with
  the new session's observation, so `cumulative` never includes the
  just-ended session and `last` always holds exactly one session's reading.
  Runs in `parseReflectionResponse()` alongside the existing
  PERSONHOOD/INTERSUBJECTIVITY/GENERATIVITY parse, and only on a successful
  parse — a session that fails to parse doesn't count as recorded (existing
  behavior), so its emotional reading isn't folded in either, keeping the
  text notes and the emotion memory atomic with each other. Formatted for the
  LLM as plain `name=0.00` pairs (`formatEmotionVector()`) in both
  `formatReflectionsForSystemPrompt()` (every `/api/chat` system prompt) and
  `buildReflectionUserMessage()`'s previous-notes block (the `/api/reflect`
  call itself) — explicitly labeled in both places as "only how you
  outwardly appeared… not a ground-truth reading of your internal state" so
  the model doesn't mistake it for self-knowledge. Also surfaced in the
  Reflective notes UI panel (`index.html`/`main.ts`) as a fourth row
  alongside the three text notes, for the same "inspectable, not just hidden
  context" reason the others are shown.

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
8. **The emotion lexicon is crude by design** (see "Key decisions" above) —
   plain keyword counting with no negation ("not happy" scores as happy) or
   sarcasm handling. It's now backed by a real research resource (the NRC
   Emotion Lexicon, ~3,460 words after filtering) plus a small hand-picked
   supplemental list, rather than a purely hand-picked word list — but
   still has no length normalization and only a crude single-suffix-strip
   stemmer (misses many inflections a real lemmatizer would catch). Accepted
   trade-off for zero token cost; revisit if Eliza- or Reflection-mode's
   expressed emotion feels wrong often enough to matter.

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
