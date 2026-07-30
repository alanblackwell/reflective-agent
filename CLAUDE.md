# Reflective Agent

## What this is

A chat agent that runs entirely in the browser (TypeScript, no backend), with
a line-drawn animated character styled to resemble Charlie Brown from
Peanuts. The character's face and posture blend smoothly across the six
basic (Ekman) emotions, and its mouth animates roughly in time with
text-to-speech output. State persists across sessions via `localStorage`.

The app has two modes, toggled by a button in the header:

- **Test mode** — no chat. A textarea for pasting a script, a "Speak"
  button, six emotion sliders (multiple can be non-zero at once — the
  character interpolates a blended pose across all active emotions), and
  voice controls (voice picker, pitch, rate). Built first so the
  animation/TTS/lip-sync work could be iterated on without the complexity of
  a real conversational backend.
- **Dialog mode** — a scrollable chat history (message pills, right-aligned
  for the user / left for the agent) with a chat input pinned to the bottom.
  Currently backed by a placeholder ELIZA implementation (see below), not a
  real LLM. Sliders/voice controls are hidden here; the character sits at
  neutral emotion while chatting.

## Architecture

- `src/poses.ts` — `FacePose` parameters (brow, eye, mouth, posture) for
  neutral and each of the six emotions.
- `src/blend.ts` — blends active emotion-slider weights into a single pose.
  Weights aren't required to sum to 1: leftover budget under 1 is filled by
  the neutral pose, and totals over 1 are renormalized, so multiple
  maxed-out sliders still produce a bounded result.
- `src/character.ts` — builds the SVG line character and runs the
  `requestAnimationFrame` loop that eases the rendered pose toward the
  target blended pose each frame (smooth transitions), plus mouth-open
  pulses driven by speech.
- `src/tts.ts` — wraps the browser's `SpeechSynthesis` API (free, no
  server/API key). Exposes voice/pitch/rate setters and drives mouth pulses
  via word-boundary events where supported, with an interval-based fallback
  everywhere else.
- `src/eliza.ts` — thin wrapper around the `elizabot` npm package (see
  "Known issues / open items" below).
- `src/storage.ts` — `localStorage` persistence for slider values, voice
  settings, last test-mode script, current app mode, and full dialog
  history.
- `src/main.ts` — wires everything together; owns the mode toggle and all
  DOM event handling.

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
  deliberately *not* rendered until speech actually starts (tied to the
  TTS `onstart` event, with a fallback to show immediately if speech
  synthesis is unsupported).
- **Default voice tuning**: macOS ships a voice named "Junior" that reads
  younger; it's auto-selected as the default when available, with pitch
  1.65 / rate 0.50 tuned by ear to sound more child-like (closer to the
  Charlie Brown character). See `DEFAULT_PITCH`/`DEFAULT_RATE` in
  `storage.ts`.
- **Real agent backend decision (not yet implemented)**: the plan is for
  dialog mode to eventually call an LLM API rather than run a model fully
  client-side. This means an API key would be exposed if called directly
  from browser JS — a backend proxy will be needed before wiring in a real
  LLM. This has been discussed but not built.

## Known issues / open items for the next session

1. **ELIZA is a placeholder, not the real agent.** Dialog mode currently
   uses the `elizabot` npm package (Norbert Landsteiner's 2005 JS port of
   Weizenbaum's 1966 DOCTOR script) purely to exercise the chat UI. It has
   **no clear OSS license** on npm (shows as "Proprietary" in registry
   metadata, i.e. no `license` field) — freely redistributed for ~20 years
   but not unambiguous. The app surfaces this to the user directly: the
   first thing the agent says each session (`Eliza.introNotice()` in
   `src/eliza.ts`) discloses the provenance/licensing ambiguity. Options for
   later: swap in a from-scratch reimplementation of the same published
   rule structure (uncontroversial — the algorithm is public), or replace
   ELIZA entirely once real LLM-backed agent logic is built.
2. **No backend proxy yet.** Needed before dialog mode can call a real LLM
   API without exposing a key client-side.
3. **No automated tests.** Verification so far has been `npx tsc --noEmit`
   plus manually starting the dev server and checking it serves/compiles
   (and for TTS/animation specifically, manual browser testing — this
   agent's tool access couldn't drive a real browser to see or hear
   output). Actual UX correctness (does it sound right, does the mouth
   look synced, does layout hold up on a resized window) has been
   eyeballed by the user, not verified automatically.
4. **Pre-speech pause is dialog-mode only.** The test-mode "Speak" button
   fires immediately by design (it's a manual animation/TTS testing tool),
   not part of the "more realistic" conversational pacing added to dialog
   mode.

## Running it

```
npm install
npm run dev       # starts Vite dev server
npx tsc --noEmit -p tsconfig.json   # type-check
npm run build     # production build
```

No test suite exists yet. Chrome is recommended for development — it has
the most complete Web Speech API support (voices list, word-boundary
events) of the major browsers.
