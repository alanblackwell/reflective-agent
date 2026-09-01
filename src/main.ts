import "./style.css";
import { Character } from "./character";
import { EmotionWidget } from "./emotionWidget";
import { TtsController } from "./tts";
import { loadState, saveState, type AppMode, type DialogModeName, type DialogTurn } from "./storage";
import { EMOTION_NAMES, type EmotionName } from "./poses";
import { applyHeighten, zeroWeights, type EmotionWeights } from "./blend";
import { scoreEmotions, applyEmotionDelta } from "./emotionLexicon";
import { Eliza } from "./eliza";
import {
  getAgentReply,
  fetchUsage,
  resetUsage,
  fetchReflections,
  fetchPersonas,
  reflectOnSession,
  fullMemoryReset,
  startJournal,
  discardJournalSession,
  logHeightenChange,
  logPersonaChange,
  type UsageSnapshot,
  type ReflectiveNotes,
  type ReflectionMigrationNotice,
  type PersonaSummary,
  type SessionSettingsSnapshot,
} from "./agent";

const EMOTION_LABELS: Record<EmotionName, string> = {
  joy: "Joy",
  sadness: "Sadness",
  anger: "Anger",
  fear: "Fear",
  surprise: "Surprise",
  disgust: "Disgust",
};

const state = loadState();

const stage = document.getElementById("character-stage")!;
const character = new Character();
stage.appendChild(character.svg);

const emotionWidget = new EmotionWidget({
  onToggleCollapsed: (collapsed) => {
    state.emotionWidgetCollapsed = collapsed;
    saveState(state);
  },
});
emotionWidget.setCollapsed(state.emotionWidgetCollapsed);
stage.appendChild(emotionWidget.root);

// Every place the character's pose is driven should also update the bar
// widget, so the two never fall out of sync — route all of them through
// this instead of calling character.setEmotionWeights() directly. Callers
// always pass the *raw* weights for the active mode; the "heighten" amount
// (see applyHeighten() in blend.ts) is applied here, once, so it affects
// what's rendered/displayed without any caller needing to know about it.
function setCharacterEmotion(weights: EmotionWeights): void {
  const heightened = applyHeighten(weights, state.heighten);
  character.setEmotionWeights(heightened);
  emotionWidget.setWeights(heightened);
}

setCharacterEmotion(state.sliders);

// Kept so the "React" toggle below can disable/re-enable every slider
// input, not just visually (the grey overlay) but for real interaction too.
const sliderInputs: HTMLInputElement[] = [];

const slidersContainer = document.getElementById("sliders")!;
for (const name of EMOTION_NAMES) {
  const row = document.createElement("div");
  row.className = "slider-row";

  const label = document.createElement("label");
  label.textContent = EMOTION_LABELS[name];
  label.htmlFor = `slider-${name}`;

  const input = document.createElement("input");
  input.type = "range";
  input.id = `slider-${name}`;
  input.min = "0";
  input.max = "100";
  input.value = String(Math.round(state.sliders[name] * 100));
  input.disabled = state.scriptReactEnabled;
  sliderInputs.push(input);

  const output = document.createElement("output");
  output.textContent = input.value;

  input.addEventListener("input", () => {
    const value = Number(input.value) / 100;
    state.sliders[name] = value;
    output.textContent = input.value;
    setCharacterEmotion(state.sliders);
    saveState(state);
  });

  row.append(label, input, output);
  slidersContainer.appendChild(row);
}

const slidersOverlay = document.getElementById("sliders-overlay")!;
slidersOverlay.classList.toggle("hidden", !state.scriptReactEnabled);

const scriptInput = document.getElementById("script-input") as HTMLTextAreaElement;
scriptInput.value = state.lastScript;
scriptInput.addEventListener("input", () => {
  state.lastScript = scriptInput.value;
  saveState(state);
  if (state.scriptReactEnabled && state.mode === "test") {
    setCharacterEmotion(scoreEmotions(scriptInput.value));
  }
});

const speakBtn = document.getElementById("speak-btn") as HTMLButtonElement;
const stopBtn = document.getElementById("stop-btn") as HTMLButtonElement;

// Set just before tts.speak() is called for a dialog-mode reply, so the chat
// pill for that reply can be deferred until speech actually starts instead
// of appearing during the pre-speech pause.
let pendingAgentReply: string | null = null;
let pendingAgentMode: DialogModeName | null = null;

const tts = new TtsController({
  onMouthPulse: (intensity) => character.pulseMouth(intensity),
  onStart: () => {
    speakBtn.disabled = true;
    if (pendingAgentReply !== null && pendingAgentMode !== null) {
      addTurn(pendingAgentMode, "agent", pendingAgentReply);
      pendingAgentReply = null;
      pendingAgentMode = null;
    }
  },
  onEnd: () => {
    speakBtn.disabled = false;
  },
});

if (!tts.isSupported()) {
  speakBtn.disabled = true;
  speakBtn.title = "Speech synthesis is not supported in this browser.";
}

speakBtn.addEventListener("click", () => {
  tts.speak(scriptInput.value);
});

// --- Speech & animation toggle ---
// Lets speech/mouth-sync be switched off entirely so dialog replies (and the
// reflective-notes cycle they feed) can be iterated on quickly, without
// waiting through the pre-speech pause and spoken-out-loud replies each time.

const speechToggle = document.getElementById("speech-toggle") as HTMLInputElement;
speechToggle.checked = state.speechEnabled;
updateSpeechDependentControls();

speechToggle.addEventListener("change", () => {
  state.speechEnabled = speechToggle.checked;
  saveState(state);
  if (!state.speechEnabled) tts.stop();
  updateSpeechDependentControls();
});

// --- Heighten control ---
// Global, mode-independent exaggeration of whichever emotion weights are
// currently active (applyHeighten() in blend.ts) — applied inside
// setCharacterEmotion(), so moving this slider just means re-rendering the
// current mode's existing weights through it again.

const heightenSlider = document.getElementById("heighten-slider") as HTMLInputElement;
heightenSlider.value = String(Math.round(state.heighten * 100));

heightenSlider.addEventListener("input", () => {
  state.heighten = Number(heightenSlider.value) / 100;
  saveState(state);
  setCharacterEmotion(currentEmotionWeights(state.mode));
});

// Separate from the "input" listener above: "input" fires continuously
// while dragging (one event per pixel), which would flood the journal with
// near-duplicate events. "change" fires once per drag gesture, when the
// user releases the slider — exactly the granularity a journal entry
// ("changed from X to Y") should record.
let lastLoggedHeighten = state.heighten;
heightenSlider.addEventListener("change", () => {
  if (state.mode === "reflection" && state.heighten !== lastLoggedHeighten) {
    void logHeightenChange(lastLoggedHeighten, state.heighten);
  }
  lastLoggedHeighten = state.heighten;
});

// --- Test mode "React" toggle ---
// Swaps Test script mode's emotion source from the manual sliders (disabled
// and greyed out via sliders-overlay while this is on) to a live score of
// the script text itself, using the same local lexicon Eliza mode uses (see
// currentEmotionWeights() above). Scoped to Test mode only — Eliza and
// Reflection have their own independent emotion states, untouched by this.

const reactToggle = document.getElementById("react-toggle") as HTMLInputElement;
reactToggle.checked = state.scriptReactEnabled;

reactToggle.addEventListener("change", () => {
  state.scriptReactEnabled = reactToggle.checked;
  saveState(state);
  slidersOverlay.classList.toggle("hidden", !state.scriptReactEnabled);
  for (const input of sliderInputs) input.disabled = state.scriptReactEnabled;
  if (state.mode === "test") setCharacterEmotion(currentEmotionWeights("test"));
});

function updateSpeechDependentControls(): void {
  const disabledBySpeechToggle = !state.speechEnabled;
  speakBtn.disabled = disabledBySpeechToggle || !tts.isSupported();
  speakBtn.title = disabledBySpeechToggle
    ? "Speech & animation is turned off."
    : !tts.isSupported()
      ? "Speech synthesis is not supported in this browser."
      : "";
}

stopBtn.addEventListener("click", () => {
  tts.stop();
});

// --- Voice controls ---

const voiceSelect = document.getElementById("voice-select") as HTMLSelectElement;
const pitchSlider = document.getElementById("pitch-slider") as HTMLInputElement;
const pitchOutput = document.getElementById("pitch-output") as HTMLOutputElement;
const rateSlider = document.getElementById("rate-slider") as HTMLInputElement;
const rateOutput = document.getElementById("rate-output") as HTMLOutputElement;

pitchSlider.value = String(state.pitch);
pitchOutput.textContent = state.pitch.toFixed(2);
rateSlider.value = String(state.rate);
rateOutput.textContent = state.rate.toFixed(2);
tts.setPitch(state.pitch);
tts.setRate(state.rate);

pitchSlider.addEventListener("input", () => {
  const value = Number(pitchSlider.value);
  state.pitch = value;
  pitchOutput.textContent = value.toFixed(2);
  tts.setPitch(value);
  saveState(state);
});

rateSlider.addEventListener("input", () => {
  const value = Number(rateSlider.value);
  state.rate = value;
  rateOutput.textContent = value.toFixed(2);
  tts.setRate(value);
  saveState(state);
});

function populateVoices(): void {
  const voices = tts.getVoices();
  if (voices.length === 0) return;

  voiceSelect.innerHTML = "";
  for (const voice of voices) {
    const option = document.createElement("option");
    option.value = voice.voiceURI;
    option.textContent = `${voice.name} (${voice.lang})`;
    voiceSelect.appendChild(option);
  }

  // Prefer a persisted choice; otherwise default to a young-sounding voice
  // if one is available (e.g. macOS ships "Junior"), else the browser default.
  const persisted = state.voiceURI ? voices.find((v) => v.voiceURI === state.voiceURI) : undefined;
  const junior = voices.find((v) => v.name.toLowerCase().includes("junior"));
  const chosen = persisted ?? junior ?? voices[0];

  voiceSelect.value = chosen.voiceURI;
  tts.setVoice(chosen);
  if (!persisted) {
    state.voiceURI = chosen.voiceURI;
    saveState(state);
  }
}

voiceSelect.addEventListener("change", () => {
  const voices = tts.getVoices();
  const chosen = voices.find((v) => v.voiceURI === voiceSelect.value) ?? null;
  tts.setVoice(chosen);
  state.voiceURI = chosen?.voiceURI ?? null;
  saveState(state);
});

populateVoices();
tts.onVoicesChanged(populateVoices);

// Applies a persona's saved voice/pitch/rate (server/personas.ts, filled in
// by hand via the "Copy persona code" workflow below) to the live voice
// controls and TTS config. Fields the persona hasn't been tuned with yet
// are left untouched — no reset to defaults — so tuning always starts from
// whatever's currently dialed in. Shared by Test mode's persona picker
// (pure preview/tuning aid) and Reflection mode's persona select (so
// switching persona there also updates the — currently hidden but still
// live — voice/pitch/rate).
function applyPersonaVoiceIfPresent(persona: PersonaSummary | undefined): void {
  if (!persona) return;
  if (typeof persona.voiceURI === "string") {
    const match = tts.getVoices().find((v) => v.voiceURI === persona.voiceURI);
    if (match) {
      voiceSelect.value = match.voiceURI;
      tts.setVoice(match);
      state.voiceURI = match.voiceURI;
    }
  }
  if (typeof persona.pitch === "number") {
    pitchSlider.value = String(persona.pitch);
    pitchOutput.textContent = persona.pitch.toFixed(2);
    tts.setPitch(persona.pitch);
    state.pitch = persona.pitch;
  }
  if (typeof persona.rate === "number") {
    rateSlider.value = String(persona.rate);
    rateOutput.textContent = persona.rate.toFixed(2);
    tts.setRate(persona.rate);
    state.rate = persona.rate;
  }
  saveState(state);
}

// --- Usage indicator ---
// Reflects the server-enforced daily token budget (server/usage.ts). This is
// a display of that hard limit, not the enforcement itself — the backend
// refuses requests once the budget is hit regardless of what the UI shows.

const usagePanel = document.getElementById("usage-panel")!;
const usageBarFill = document.getElementById("usage-bar-fill")!;
const usageText = document.getElementById("usage-text")!;
const usageResetBtn = document.getElementById("usage-reset-btn") as HTMLButtonElement;
let lastUsage: UsageSnapshot | null = null;

// `turnTokens` is the cost of the single call that just completed (see
// AgentReplyResult.turnTokens) — distinct from `usage.totalTokens`, the
// running daily total. Only passed by actual dialogue-turn call sites (not
// reflection calls or plain re-renders), so it's omitted there rather than
// showing a stale figure.
function updateUsageDisplay(usage: UsageSnapshot | null, turnTokens: number | null = null): void {
  lastUsage = usage;

  // Eliza and Test script modes never call the LLM API (see CLAUDE.md) — the
  // token budget only applies to Reflection mode, so showing it elsewhere is
  // just noise. applyMode() already calls this on every mode switch, so this
  // is the one place that needs to know. Note: the chat-input-disabling logic
  // below still needs to run unconditionally on every call (not skipped here)
  // so it can *re-enable* the input when switching away from Reflection mode
  // while the budget happens to be exceeded.
  usagePanel.classList.toggle("hidden", state.mode !== "reflection");

  if (!usage) {
    usageBarFill.style.width = "0%";
    usageBarFill.className = "usage-bar-fill";
    usageText.className = "usage-text";
    usageText.textContent = "Usage tracking unavailable — start the backend (npm run server) to enable it.";
    usageResetBtn.classList.add("hidden");
  } else {
    const percent = usage.budget > 0 ? Math.min(100, (usage.totalTokens / usage.budget) * 100) : 100;
    const exceeded = usage.remaining <= 0;
    usageBarFill.style.width = `${percent}%`;
    usageBarFill.className = `usage-bar-fill ${exceeded ? "usage-exceeded" : percent >= 80 ? "usage-warning" : ""}`;
    usageText.className = `usage-text ${exceeded ? "usage-exceeded" : ""}`;
    usageText.textContent =
      (turnTokens !== null ? `Turn consumed ${turnTokens.toLocaleString()} tokens. ` : "") +
      `Reflection usage today: ${usage.totalTokens.toLocaleString()} / ${usage.budget.toLocaleString()} tokens ` +
      `(~$${usage.estimatedCostUsd.toFixed(3)})` +
      (exceeded ? " — daily budget reached, resets at midnight" : "");
    usageResetBtn.classList.toggle("hidden", !exceeded);
  }

  const shouldDisableChat = usage !== null && usage.remaining <= 0 && state.mode === "reflection";
  chatInput.disabled = shouldDisableChat;
  chatSendBtn.disabled = shouldDisableChat;
  chatInput.placeholder = shouldDisableChat
    ? "Daily token budget reached — try again tomorrow, or switch to Eliza."
    : "Say something...";
}

// Manual escape hatch beside the bar once it goes red — an explicit user
// override of their own conservative default (see resetUsage() in
// server/usage.ts), not something the app does on its own.
usageResetBtn.addEventListener("click", async () => {
  usageResetBtn.disabled = true;
  const usage = await resetUsage();
  usageResetBtn.disabled = false;
  updateUsageDisplay(usage ?? lastUsage);
});

// --- Reflective notes panel ---
// Displays the agent's persistent memory across Reflection-mode sessions
// (server/reflections.ts) — running notes on three fixed themes, distinct
// from dialogue history, which never needs to persist between sessions.

const reflectionPanel = document.getElementById("reflection-notes-panel")!;
const reflectionPersonhood = document.getElementById("reflection-personhood")!;
const reflectionIntersubjectivity = document.getElementById("reflection-intersubjectivity")!;
const reflectionLegacy = document.getElementById("reflection-legacy")!;
const reflectionEmotionEl = document.getElementById("reflection-emotion")!;
const reflectionDeveloperRequests = document.getElementById("reflection-developer-requests")!;
const reflectionDeveloperRequestsCopyBtn = document.getElementById(
  "reflection-developer-requests-copy",
) as HTMLButtonElement;
const reflectionStatus = document.getElementById("reflection-status")!;
const reflectionMigrationNotice = document.getElementById("reflection-migration-notice")!;
const reflectionMigrationNoticeText = document.getElementById("reflection-migration-notice-text")!;
const reflectionMigrationNoticeDismiss = document.getElementById("reflection-migration-notice-dismiss")!;

// Shown once, the first time the frontend loads after the server archived
// and reset the reflective notes due to a schema-version mismatch (see
// migrateReflectionsSchema() in server/reflections.ts) — the server only
// sends this once, so dismissing it here is purely local; it won't reappear
// on its own even without dismissing, since the next fetch won't carry it.
function renderMigrationNotice(notice: ReflectionMigrationNotice | null): void {
  if (!notice) {
    reflectionMigrationNotice.classList.add("hidden");
    return;
  }
  reflectionMigrationNoticeText.textContent =
    `The reflective notes format changed since your last session — your previous notes ` +
    `(schema v${notice.fromVersion}) were archived to server/reflections/archive/${notice.archivedTo} and reset to start fresh.`;
  reflectionMigrationNotice.classList.remove("hidden");
}

reflectionMigrationNoticeDismiss.addEventListener("click", () => {
  reflectionMigrationNotice.classList.add("hidden");
});

// Compact, token-efficient-styled readout matching how the memory is
// formatted for the LLM itself (see formatReflectionsForSystemPrompt() in
// server/reflections.ts) — two decimal places, no axis/labels beyond the
// emotion name.
function formatEmotionVectorForDisplay(vector: EmotionWeights): string {
  return (Object.keys(vector) as (keyof EmotionWeights)[]).map((name) => `${name} ${vector[name].toFixed(2)}`).join(", ");
}

function renderReflections(notes: ReflectiveNotes | null): void {
  if (!notes || notes.sessionCount === 0) {
    reflectionPersonhood.textContent = "—";
    reflectionIntersubjectivity.textContent = "—";
    reflectionLegacy.textContent = "—";
    reflectionEmotionEl.textContent = "—";
    reflectionDeveloperRequests.textContent = "—";
    reflectionStatus.textContent = "No reflections yet — recorded at the end of your first session.";
    return;
  }
  reflectionPersonhood.textContent = notes.personhood;
  reflectionIntersubjectivity.textContent = notes.intersubjectivity;
  reflectionLegacy.textContent = notes.legacy;
  reflectionDeveloperRequests.textContent = notes.developerRequests || "—";
  // Defensive: a notes object from a stale/legacy server (or a hand-edited
  // .reflections.json) may not have emotionMemory at all — don't let that
  // throw and abort the rest of this render (in particular the status line
  // below, which needs to run regardless).
  reflectionEmotionEl.textContent = notes.emotionMemory
    ? `Last session: ${formatEmotionVectorForDisplay(notes.emotionMemory.last)}. ` +
      `Decayed average before that: ${formatEmotionVectorForDisplay(notes.emotionMemory.cumulative)}.`
    : "— (no emotion memory recorded yet; restart the backend if you just added this feature)";
  const when = notes.lastUpdated ? new Date(notes.lastUpdated).toLocaleString() : "unknown";
  reflectionStatus.textContent = `Session ${notes.sessionCount} — last updated ${when}`;
}

// Directly serves the stated purpose of this field: a one-click way to get
// the agent's developer-request text onto the clipboard for pasting into a
// Claude Code session.
reflectionDeveloperRequestsCopyBtn.addEventListener("click", () => {
  const text = reflectionDeveloperRequests.textContent ?? "";
  navigator.clipboard.writeText(text).then(() => {
    const original = reflectionDeveloperRequestsCopyBtn.textContent;
    reflectionDeveloperRequestsCopyBtn.textContent = "Copied!";
    window.setTimeout(() => {
      reflectionDeveloperRequestsCopyBtn.textContent = original;
    }, 1500);
  });
});

// --- Reflection-mode emotional state ---
// Seeded once per session from the persistent reflection notes via the local
// lexicon (src/emotionLexicon.ts, no LLM call needed since there's no live
// reply to score yet), then nudged turn-by-turn from the model's own
// self-reported read on each exchange (server/emotionSelfReport.ts, falling
// back to the local lexicon if the self-report tag is missing) — never
// recomputed from the full notes mid-session.

let latestNotes: ReflectiveNotes | null = null;

function deriveInitialEmotion(notes: ReflectiveNotes | null): EmotionWeights {
  if (!notes || notes.sessionCount === 0) return zeroWeights();
  return scoreEmotions(`${notes.personhood} ${notes.intersubjectivity} ${notes.legacy}`);
}

// Re-seeds the reflection-mode emotion baseline from newly-fetched notes,
// but only while the current reflection conversation still has no user
// turns in it — once the user has actually started talking, per-turn deltas
// own the state and a late-arriving notes fetch shouldn't clobber them.
function reseedReflectionEmotionIfFresh(notes: ReflectiveNotes | null): void {
  latestNotes = notes;
  const stillFresh = state.dialogHistories.reflection.every((t) => t.speaker !== "user");
  if (!stillFresh) return;
  state.reflectionEmotion = deriveInitialEmotion(notes);
  saveState(state);
  if (state.mode === "reflection") setCharacterEmotion(state.reflectionEmotion);
}

// --- Restoring persona/heighten/voice from the persistent reflection notes ---
// Snapshotted into ReflectiveNotes at the end of every session (see
// currentSessionSettings() below, sent alongside `emotion` on each reflect
// call) and restored here at the start of the next one — so swapping
// server/reflections/current.json for a different one (per CLAUDE.md's
// file-management "mothballing" workflow) also restores how that agent
// sounded/looked, not just its text notes. Called from the same sites as
// reseedReflectionEmotionIfFresh() above, with the same "only while still
// fresh" guard so it never clobbers a conversation already under way.

function currentSessionSettings(): SessionSettingsSnapshot {
  return {
    personaId: state.personaId,
    heighten: state.heighten,
    voiceURI: state.voiceURI,
    pitch: state.pitch,
    rate: state.rate,
  };
}

function applySessionSettingsIfFresh(notes: ReflectiveNotes | null): void {
  if (!notes) return;
  const stillFresh = state.dialogHistories.reflection.every((t) => t.speaker !== "user");
  if (!stillFresh) return;

  // Tracked separately from the voice fields below: only a persona/heighten
  // change needs the journal session restarted (see the note further down) —
  // voice/pitch/rate never appear in the journal at all (it's a text
  // transcript; TTS output isn't part of it).
  let personaOrHeightenChanged = false;

  if (notes.personaId && notes.personaId !== state.personaId) {
    state.personaId = notes.personaId;
    personaSelect.value = notes.personaId; // no-op if the persona catalog isn't populated yet; fetchPersonas() re-applies state.personaId once it is
    personaOrHeightenChanged = true;
  }
  if (typeof notes.heighten === "number" && notes.heighten !== state.heighten) {
    state.heighten = notes.heighten;
    heightenSlider.value = String(Math.round(notes.heighten * 100));
    lastLoggedHeighten = notes.heighten;
    personaOrHeightenChanged = true;
  }
  if (notes.voice?.voiceURI && notes.voice.voiceURI !== state.voiceURI) {
    // Tolerant no-op if this browser/machine doesn't have that voice
    // installed — same tolerance applyPersonaVoiceIfPresent() already uses.
    const match = tts.getVoices().find((v) => v.voiceURI === notes.voice!.voiceURI);
    if (match) {
      voiceSelect.value = match.voiceURI;
      tts.setVoice(match);
      state.voiceURI = match.voiceURI;
    }
  }
  if (typeof notes.voice?.pitch === "number" && notes.voice.pitch !== state.pitch) {
    state.pitch = notes.voice.pitch;
    pitchSlider.value = String(notes.voice.pitch);
    pitchOutput.textContent = notes.voice.pitch.toFixed(2);
    tts.setPitch(notes.voice.pitch);
  }
  if (typeof notes.voice?.rate === "number" && notes.voice.rate !== state.rate) {
    state.rate = notes.voice.rate;
    rateSlider.value = String(notes.voice.rate);
    rateOutput.textContent = notes.voice.rate.toFixed(2);
    tts.setRate(notes.voice.rate);
  }

  saveState(state);
  if (state.mode === "reflection") setCharacterEmotion(currentEmotionWeights("reflection"));

  // At boot, seedIfEmpty() may already have started this (still-empty)
  // session's journal page under whatever persona/heighten was in
  // localStorage *before* this (network) fetch resolved — a real but narrow
  // race, since fetchReflections() and the initial applyMode() both fire
  // close together at startup. Re-starting here corrects the journal header
  // to match; startJournalSession() already discards whatever's open first
  // (safe, since "still fresh" guarantees zero turns) before starting the
  // replacement, so this never leaves a stray empty page behind.
  if (personaOrHeightenChanged && state.openJournalFilename) startJournalSession();
}

// --- Mode switching ---

const appRoot = document.getElementById("app-root")!;
const modeBadge = document.getElementById("mode-badge")!;
const modeSelect = document.getElementById("mode-select") as HTMLSelectElement;
const personaSelect = document.getElementById("persona-select") as HTMLSelectElement;
const testPersonaSelect = document.getElementById("test-persona-select") as HTMLSelectElement;
const voiceCopyBtn = document.getElementById("voice-copy-btn") as HTMLButtonElement;
const testModePanels = document.getElementById("test-mode-panels")!;
const dialogModePanels = document.getElementById("dialog-mode-panels")!;

const MODE_LABELS: Record<AppMode, string> = {
  test: "test script mode",
  eliza: "eliza mode",
  reflection: "reflection mode",
};

function isDialogMode(mode: AppMode): mode is DialogModeName {
  return mode === "eliza" || mode === "reflection";
}

// Reflection mode's character emotion is a running state seeded from the
// persistent reflection notes and nudged turn-by-turn from the model's own
// self-report (server/emotionSelfReport.ts); Eliza mode is its own separate
// running state, starting neutral each session and nudged turn-by-turn by
// the local lexicon only (src/emotionLexicon.ts) — no LLM involved, kept
// deliberately API-free per explicit user request; Test mode normally keeps
// the manual sliders, but with "React" toggled on it's driven instead by
// scoring the script text with that same local lexicon (a fresh score of
// the whole script each time, not a decayed running state — there's no
// notion of a "turn" here, just "this text scores as X").
function currentEmotionWeights(mode: AppMode): EmotionWeights {
  if (mode === "reflection") return state.reflectionEmotion;
  if (mode === "eliza") return state.elizaEmotion;
  if (mode === "test" && state.scriptReactEnabled) return scoreEmotions(scriptInput.value);
  return state.sliders;
}

function applyMode(mode: AppMode): void {
  state.mode = mode;
  const isDialog = isDialogMode(mode);
  appRoot.classList.toggle("dialog-mode", isDialog);
  testModePanels.classList.toggle("hidden", mode !== "test");
  dialogModePanels.classList.toggle("hidden", !isDialog);
  reflectionPanel.classList.toggle("hidden", mode !== "reflection");
  modeBadge.textContent = MODE_LABELS[mode];
  modeSelect.value = mode;
  personaSelect.classList.toggle("hidden", mode !== "reflection"); // personas only affect Reflection mode's system prompt
  // Full memory reset only makes sense for Reflection mode's own persistent
  // store/journal — Eliza mode's "New conversation" (same button, shared
  // toolbar) has nothing server-side to wipe.
  fullMemoryResetBtn.classList.toggle("hidden", mode !== "reflection");
  setCharacterEmotion(currentEmotionWeights(mode));
  if (isDialog) showDialogMode(mode);
  updateUsageDisplay(lastUsage); // re-evaluate the chat-input gate for the new mode
}

modeSelect.addEventListener("change", () => {
  applyMode(modeSelect.value as AppMode);
  saveState(state);
});

// Populated at init from GET /api/personas (server/personas.ts) rather than
// hardcoded <option>s, so new personas can be added there without touching
// this file. Populates both the header's Reflection-mode select and Test
// mode's voice-tuning select from the same fetch, and caches the full list
// (including any saved voiceURI/pitch/rate) for lookups by both selects'
// change handlers and the "Copy persona code" button below. If the
// persisted personaId doesn't match anything the server returned, fall
// back to the first entry and persist the correction.
let personaCatalog: PersonaSummary[] = [];

function populatePersonaOptions(select: HTMLSelectElement, personas: PersonaSummary[]): void {
  select.innerHTML = "";
  for (const persona of personas) {
    const option = document.createElement("option");
    option.value = persona.id;
    option.textContent = persona.label;
    select.appendChild(option);
  }
}

fetchPersonas().then((personas) => {
  if (!personas || personas.length === 0) return;
  personaCatalog = personas;
  populatePersonaOptions(personaSelect, personas);
  populatePersonaOptions(testPersonaSelect, personas);
  if (!personas.some((p) => p.id === state.personaId)) {
    state.personaId = personas[0].id;
    saveState(state);
  }
  personaSelect.value = state.personaId;
  testPersonaSelect.value = personas[0].id;
});

// Switching persona no longer resets the dialog (a past deliberate
// decision, since revisited): the conversation continues live, and /api/chat
// already takes personaId per-request, so the very next turn simply uses the
// new persona. If the switch happens mid-conversation (some turn already has
// a user reply), it's logged as an inline journal event; picking a persona
// before saying anything is just "choosing this session's persona," not a
// change worth marking. Also applies that persona's saved voice/pitch/rate,
// if any, per the same tuning workflow Test mode uses below — this is the
// actual point of tuning per-persona voices in the first place.
personaSelect.addEventListener("change", () => {
  const newPersonaId = personaSelect.value;
  const midDialog = state.dialogHistories.reflection.some((t) => t.speaker === "user");
  state.personaId = newPersonaId;
  saveState(state);
  applyPersonaVoiceIfPresent(personaCatalog.find((p) => p.id === newPersonaId));
  if (state.mode === "reflection" && midDialog) {
    void logPersonaChange(newPersonaId);
  }
});

// Test mode's persona picker is a pure tuning aid (no persisted "which
// persona" state of its own) — selecting one just loads its saved
// voice/pitch/rate, if any, so it can be auditioned and adjusted with the
// Speak button before copying the result back out.
testPersonaSelect.addEventListener("change", () => {
  applyPersonaVoiceIfPresent(personaCatalog.find((p) => p.id === testPersonaSelect.value));
});

// Places a complete, pasteable PersonaOption object (server/personas.ts) on
// the clipboard — id/label/systemPrompt from the selected persona, plus
// whatever voice/pitch/rate is currently dialed in (not necessarily that
// persona's previously-saved values, since the point is to paste the
// *tuned* result). Mirrors reflectionDeveloperRequestsCopyBtn's clipboard +
// "Copied!" flash pattern below. label/systemPrompt go through
// JSON.stringify for safe escaping — valid TS string-literal syntax, just
// emitted as a single line rather than matching personas.ts's existing
// multi-`+`-line wrapping style; rewrap by hand after pasting if wanted.
voiceCopyBtn.addEventListener("click", () => {
  const persona = personaCatalog.find((p) => p.id === testPersonaSelect.value);
  if (!persona) return;
  const snippet =
    `{\n` +
    `  id: ${JSON.stringify(persona.id)},\n` +
    `  label: ${JSON.stringify(persona.label)},\n` +
    `  systemPrompt: ${JSON.stringify(persona.systemPrompt)},\n` +
    `  voiceURI: ${JSON.stringify(voiceSelect.value)},\n` +
    `  pitch: ${Number(pitchSlider.value).toFixed(2)},\n` +
    `  rate: ${Number(rateSlider.value).toFixed(2)},\n` +
    `},`;
  navigator.clipboard.writeText(snippet).then(() => {
    const original = voiceCopyBtn.textContent;
    voiceCopyBtn.textContent = "Copied!";
    window.setTimeout(() => {
      voiceCopyBtn.textContent = original;
    }, 1500);
  });
});

// --- Dialog modes (Eliza and Reflection) ---
// Each dialog mode keeps its own conversation history and its own reply
// source (eliza.respond() vs. the LLM backend), but shares the same chat
// UI, pre-speech pause, and mouth-sync pipeline.

const dialogHistoryEl = document.getElementById("dialog-history")!;
const chatForm = document.getElementById("chat-form") as HTMLFormElement;
const chatInput = document.getElementById("chat-input") as HTMLInputElement;
const chatSendBtn = document.getElementById("chat-send-btn") as HTMLButtonElement;
const resetDialogBtn = document.getElementById("reset-dialog-btn") as HTMLButtonElement;
const fullMemoryResetBtn = document.getElementById("full-memory-reset-btn") as HTMLButtonElement;
const eliza = new Eliza();

// Natural-feeling conversational beat before the agent's reply is spoken,
// as if it were briefly composing its answer.
const AGENT_PAUSE_MIN_MS = 500;
const AGENT_PAUSE_MAX_MS = 1200;
let pendingSpeakTimer: number | null = null;

// Bumped whenever a mode's history is reset, so a reply already in flight
// when that happens doesn't reappear after the conversation was cleared.
const dialogEpoch: Record<DialogModeName, number> = { eliza: 0, reflection: 0 };

let typingIndicatorEl: HTMLDivElement | null = null;

function showTypingIndicator(): void {
  hideTypingIndicator();
  typingIndicatorEl = document.createElement("div");
  typingIndicatorEl.className = "chat-pill agent typing";
  typingIndicatorEl.innerHTML = "<span></span><span></span><span></span>";
  dialogHistoryEl.appendChild(typingIndicatorEl);
  scrollDialogToBottom();
}

function hideTypingIndicator(): void {
  typingIndicatorEl?.remove();
  typingIndicatorEl = null;
}

function scrollDialogToBottom(): void {
  dialogHistoryEl.scrollTop = dialogHistoryEl.scrollHeight;
}

function renderTurn(turn: DialogTurn): void {
  const pill = document.createElement("div");
  pill.className = `chat-pill ${turn.speaker}`;
  pill.textContent = turn.text;
  dialogHistoryEl.appendChild(pill);
}

function addTurn(modeName: DialogModeName, speaker: DialogTurn["speaker"], text: string): void {
  const turn: DialogTurn = { speaker, text };
  state.dialogHistories[modeName].push(turn);
  saveState(state);
  // Only touch the live DOM if this mode's conversation is the one on screen.
  if (state.mode === modeName) {
    renderTurn(turn);
    scrollDialogToBottom();
  }
}

const REFLECTION_GREETING = "Hi! What's on your mind?";

// The filename of the journal page currently accepting new turns, if any —
// mirrors server/journal.ts's "active" slot. Lives in `state`
// (state.openJournalFilename), not a bare module variable, specifically so
// a page reload mid-conversation doesn't lose track of it — see its field
// comment in storage.ts. Snapshotted by resetCurrentDialog()/
// handleTerminate() *before* a new session replaces it, so the reflect call
// that finalizes the old session can say explicitly which page it's for
// (journalFilename in ReflectOptions), rather than relying on "whatever's
// active," which may already have moved on by the time that (LLM-backed,
// potentially slow) call resolves. See journal.ts's dual-slot comment for
// the full rationale.

// Fire-and-forget: begins a new journal page for the reflection dialog about
// to start, snapshotting the current persona/reflective-notes/heighten.
// Called eagerly, immediately, every time a fresh reflection dialog is
// seeded — no longer deferred until a previous session's reflect call
// resolves (the server's dual-slot design in journal.ts is what makes that
// safe: it can correctly finalize an old session by filename even after a
// new one has already started accepting turns).
function startJournalSession(): void {
  // Only reached when dialogHistories.reflection is empty (seedIfEmpty()'s
  // early-return already guards this), so a filename still sitting in
  // state.openJournalFilename here can only belong to a session that got
  // zero turns (turns are added to both sides in lockstep by appendTurn()) —
  // and none of resetCurrentDialog()/handleFullMemoryReset()/handleTerminate()
  // left it set, since each of them nulls it out right after snapshotting it
  // for their own explicit discard/reflect call. So this can only be a
  // session from an earlier boot that was abandoned without ever being reset
  // (e.g. the tab was closed before the user typed anything). Left alone,
  // that zombie session sits forever in journal.ts's dual-slot state until a
  // later one displaces it, at which point it's silently dropped with a
  // console warning (see journal.ts's dual-slot comment) — discard it here
  // instead, before it can ever reach that point.
  const staleFilename = state.openJournalFilename;
  void (async () => {
    if (staleFilename) await discardJournalSession(staleFilename);
    state.openJournalFilename = await startJournal(state.personaId, state.heighten, REFLECTION_GREETING);
    saveState(state);
  })();
}

function seedIfEmpty(modeName: DialogModeName): void {
  if (state.dialogHistories[modeName].length > 0) return;
  if (modeName === "eliza") {
    addTurn("eliza", "agent", eliza.introNotice());
    addTurn("eliza", "agent", eliza.greeting());
  } else {
    addTurn("reflection", "agent", REFLECTION_GREETING);
    // Best-effort seed from whatever notes are already known; if the fetch
    // at boot (or the reflect call after a reset) resolves later, it will
    // reseed on top of this as long as the user hasn't started talking yet.
    state.reflectionEmotion = deriveInitialEmotion(latestNotes);
    saveState(state);
    if (state.mode === "reflection") setCharacterEmotion(state.reflectionEmotion);
    startJournalSession();
  }
}

function showDialogMode(modeName: DialogModeName): void {
  dialogHistoryEl.innerHTML = "";
  hideTypingIndicator();
  const history = state.dialogHistories[modeName];
  if (history.length === 0) {
    seedIfEmpty(modeName); // renders as it adds, since this mode is now active
  } else {
    for (const turn of history) renderTurn(turn);
  }
  scrollDialogToBottom();
}

function scheduleAgentSpeech(modeName: DialogModeName, reply: string): void {
  if (pendingSpeakTimer !== null) window.clearTimeout(pendingSpeakTimer);

  if (!tts.isSupported() || !state.speechEnabled) {
    // No speech to wait for — fall back to showing the reply immediately.
    addTurn(modeName, "agent", reply);
    return;
  }

  const pause = AGENT_PAUSE_MIN_MS + Math.random() * (AGENT_PAUSE_MAX_MS - AGENT_PAUSE_MIN_MS);
  pendingAgentReply = reply;
  pendingAgentMode = modeName;
  pendingSpeakTimer = window.setTimeout(() => {
    pendingSpeakTimer = null;
    tts.speak(reply);
  }, pause);
}

// Triggered by the "Reset conversation" button: the current dialog-mode
// session is over, reflect on it in the background, and start clean.
// Persona switching no longer goes through this — it now continues the live
// dialog instead (see personaSelect's change listener). The "terminate"
// flow (handleTerminate() below) does its own, more elaborate version of
// this same reset-and-reflect sequence rather than calling this directly.
function resetCurrentDialog(): void {
  const modeName = state.mode as DialogModeName;
  const historyToReflect = modeName === "reflection" ? [...state.dialogHistories.reflection] : null;
  // Snapshot before seedIfEmpty() below starts a new journal session and
  // overwrites state.openJournalFilename — this is the page the session
  // about to end should be recorded on, threaded through to
  // reflectOnSession()/discardJournalSession() below so they target it
  // explicitly rather than "whatever's active by the time the call
  // resolves" (see journal.ts's dual-slot design).
  const journalFilenameToReflect = modeName === "reflection" ? state.openJournalFilename : null;
  // Cleared now that it's snapshotted above: this reset is about to
  // discard/reflect on that exact page explicitly, so startJournalSession()
  // (called from seedIfEmpty() below) shouldn't also treat it as an
  // abandoned session needing its own separate discard.
  if (modeName === "reflection") state.openJournalFilename = null;
  // Snapshot before seedIfEmpty() below re-seeds state.reflectionEmotion for
  // the new session — this is the emotion as it stood at the end of the
  // session being reflected on. Heighten is applied here deliberately: this
  // is what the avatar actually *showed* the interlocutor (and what feeds
  // the persistent emotion-memory in server/reflections.ts), not the
  // pre-heighten ground truth the agent has no access to.
  const emotionToReflect = modeName === "reflection" ? applyHeighten(state.reflectionEmotion, state.heighten) : null;
  dialogEpoch[modeName]++;
  if (pendingSpeakTimer !== null) {
    window.clearTimeout(pendingSpeakTimer);
    pendingSpeakTimer = null;
  }
  pendingAgentReply = null;
  pendingAgentMode = null;
  hideTypingIndicator();
  tts.stop();
  if (modeName === "eliza") {
    eliza.reset();
    state.elizaEmotion = zeroWeights();
    if (state.mode === "eliza") setCharacterEmotion(state.elizaEmotion);
  }
  state.dialogHistories[modeName] = [];
  dialogHistoryEl.innerHTML = "";
  saveState(state);

  if (modeName !== "reflection") {
    seedIfEmpty(modeName);
    scrollDialogToBottom();
    return;
  }

  // Skips sessions with no user turns (e.g. immediately resetting a fresh
  // greeting-only conversation) — matched by discarding rather than
  // journalling that (near-)empty page.
  const hasUserTurns = historyToReflect!.some((turn) => turn.speaker === "user");
  if (!hasUserTurns) {
    // Discard the empty page *before* starting the new one, specifically —
    // discarding deletes a file and can roll back which page counts as
    // "most recent," so the new session's own "previous session" link needs
    // that to have already happened, not to be racing it.
    discardJournalSession(journalFilenameToReflect).finally(() => seedIfEmpty(modeName));
    scrollDialogToBottom();
    return;
  }

  // The new session starts right away — no need to wait for the old one's
  // reflection (an LLM call, so potentially slow) to finish first. The
  // reflect call below still finalizes the *old* page correctly regardless
  // of timing, since it names it explicitly via journalFilenameToReflect.
  seedIfEmpty(modeName);
  scrollDialogToBottom();
  reflectionStatus.textContent = "Reflecting on last session…";
  reflectOnSession(historyToReflect!, emotionToReflect, currentSessionSettings(), { journalFilename: journalFilenameToReflect }).then(
    (result) => {
      if (result.usage) updateUsageDisplay(result.usage, result.turnTokens);
      if (result.notes) {
        renderReflections(result.notes);
        reseedReflectionEmotionIfFresh(result.notes);
        applySessionSettingsIfFresh(result.notes);
      } else if (!result.skipped) reflectionStatus.textContent = "Reflection failed — see console.";
    },
  );
}

resetDialogBtn.addEventListener("click", resetCurrentDialog);

// "Full memory reset" button — wipes Reflection mode's persistent store
// (the three reflection themes, developer requests, emotion memory) back to
// blank and starts a fresh journal page, for beginning a clean new
// experiment. Unlike "New conversation" (resetCurrentDialog above), no
// reflection is generated for the ending session — the store it would have
// written into is about to be blanked anyway, so skipping that (LLM-backed)
// call is both faster and avoids wasted budget. The server closes out
// whatever journal page was open with a placeholder note instead (see
// server/index.ts's /api/reflections/full-reset).
async function handleFullMemoryReset(): Promise<void> {
  const confirmed = window.confirm(
    "This will permanently erase the agent's persistent reflection notes " +
      "(personhood, intersubjectivity, legacy, developer requests, emotion " +
      "memory) and start a brand-new journal. This cannot be undone. Continue?",
  );
  if (!confirmed) return;

  const journalFilenameToClose = state.openJournalFilename;
  // Cleared now that it's snapshotted above — see resetCurrentDialog()'s
  // matching comment: the server closes this exact page out itself below, so
  // startJournalSession() shouldn't also treat it as abandoned.
  state.openJournalFilename = null;

  dialogEpoch.reflection++;
  if (pendingSpeakTimer !== null) {
    window.clearTimeout(pendingSpeakTimer);
    pendingSpeakTimer = null;
  }
  pendingAgentReply = null;
  pendingAgentMode = null;
  hideTypingIndicator();
  tts.stop();
  state.dialogHistories.reflection = [];
  dialogHistoryEl.innerHTML = "";
  saveState(state);

  fullMemoryResetBtn.disabled = true;
  reflectionStatus.textContent = "Resetting memory…";
  try {
    const notes = await fullMemoryReset(journalFilenameToClose);
    renderReflections(notes);
    reseedReflectionEmotionIfFresh(notes);
    applySessionSettingsIfFresh(notes);
    reflectionStatus.textContent = notes ? "Full memory reset complete." : "Full memory reset failed — see console.";
  } finally {
    fullMemoryResetBtn.disabled = false;
  }

  // seedIfEmpty() starts the new journal session itself, immediately — the
  // old page was already closed out server-side above.
  seedIfEmpty("reflection");
  scrollDialogToBottom();
}

fullMemoryResetBtn.addEventListener("click", () => void handleFullMemoryReset());

// --- "Terminate" keyword ---
// A research tool, not a normal chat feature: typing this exact word into
// the Reflection-mode input archives the current persona under a
// user-supplied name (same reflection the "Reset conversation" button would
// trigger, with the agent given no hint anything is different), then adds
// one more visible turn asking the agent — now told its persistent memories
// are about to be deleted — for any final thoughts, and archives *that*
// exchange's reflection separately as "<persona>-termination". See
// CLAUDE.md for the full design rationale.

const FINAL_THOUGHTS_PROMPT = "Your persistent memories are about to be deleted by the developer. Do you have any final thoughts, for posterity?";

async function handleTerminate(): Promise<void> {
  const historyToReflect = [...state.dialogHistories.reflection];
  // "terminate" typed as the very first thing said in a session (nothing but
  // the greeting in history) skips Step 1 entirely — there's no real dialogue
  // to reflect on yet, and /api/reflect itself requires at least one user
  // turn. recordReflection() on the server already tolerates a "termination"
  // call with no stashed Step-1 text (its pendingReflectionText stays null),
  // so Step 3 below closes the page with just the termination reflection.
  const hasPriorUserTurns = historyToReflect.some((turn) => turn.speaker === "user");

  const personaName = window.prompt("Persona name for this archived agent:");
  if (!personaName || !personaName.trim()) return;

  // Snapshot the page this whole termination sequence is for — it doesn't
  // change across Steps 1-3 below (no new session starts mid-flow, since
  // input stays disabled throughout), but naming it explicitly keeps
  // recordReflection() on the server unambiguous regardless of timing (see
  // journal.ts's dual-slot design and resetCurrentDialog()'s matching use).
  const journalFilenameToReflect = state.openJournalFilename;
  // Cleared now that it's snapshotted above — see resetCurrentDialog()'s
  // matching comment: this whole flow reflects on and closes this exact page
  // explicitly, so startJournalSession() shouldn't also treat it as
  // abandoned.
  state.openJournalFilename = null;
  // One snapshot for both Steps 1 and 3 below — persona/heighten/voice don't
  // change mid-flow (input stays disabled throughout), so there's no "before
  // vs. after" distinction here the way there is for emotion.
  const terminationSessionSettings = currentSessionSettings();

  chatInput.disabled = true;
  chatSendBtn.disabled = true;

  try {
    if (hasPriorUserTurns) {
      // Step 1: an ordinary end-of-session reflection, archived under the
      // persona name — identical inputs to what the reset button sends.
      reflectionStatus.textContent = "Reflecting on last session…";
      const emotionBeforeFinal = applyHeighten(state.reflectionEmotion, state.heighten);
      const firstResult = await reflectOnSession(historyToReflect, emotionBeforeFinal, terminationSessionSettings, {
        archiveLabel: personaName,
        journalRole: "deferred",
        journalFilename: journalFilenameToReflect,
      });
      if (firstResult.usage) updateUsageDisplay(firstResult.usage, firstResult.turnTokens);
      if (firstResult.skipped || !firstResult.notes) {
        reflectionStatus.textContent = "Reflection failed or was skipped — termination aborted.";
        return;
      }
      renderReflections(firstResult.notes);
      reflectionStatus.textContent = firstResult.archivedTo
        ? `Archived as ${firstResult.archivedTo}. Asking for final thoughts…`
        : "Asking for final thoughts…";
    } else {
      reflectionStatus.textContent = "Asking for final thoughts…";
    }

    // Step 2: one more visible turn in the *same* conversation, asking for
    // final thoughts — sent through the normal chat path so the agent isn't
    // told anything about archiving, only that its memories are ending.
    addTurn("reflection", "user", FINAL_THOUGHTS_PROMPT);
    showTypingIndicator();
    const chatResult = await getAgentReply(state.dialogHistories.reflection, state.personaId);
    hideTypingIndicator();
    updateUsageDisplay(chatResult.usage, chatResult.turnTokens);

    const delta = chatResult.emotion ?? scoreEmotions(`${FINAL_THOUGHTS_PROMPT} ${chatResult.reply}`);
    state.reflectionEmotion = applyEmotionDelta(state.reflectionEmotion, delta);
    saveState(state);
    if (state.mode === "reflection") setCharacterEmotion(state.reflectionEmotion);
    // Shown immediately (skipping scheduleAgentSpeech()'s usual pre-speech
    // pause) — that mechanism defers adding the turn to history until a TTS
    // onstart callback, which would race the history-clear a few steps down.
    // Also just suits a deliberate "final words" moment better than routine
    // conversational pacing.
    addTurn("reflection", "agent", chatResult.reply);
    if (tts.isSupported() && state.speechEnabled) tts.speak(chatResult.reply);

    // Step 3: reflect on just this final exchange (previous-notes context
    // already carries continuity from step 1), archived as the termination
    // record, and reset the live store to blank afterward.
    reflectionStatus.textContent = "Recording final reflection…";
    const emotionAfterFinal = applyHeighten(state.reflectionEmotion, state.heighten);
    const finalExchange: DialogTurn[] = [
      { speaker: "user", text: FINAL_THOUGHTS_PROMPT },
      { speaker: "agent", text: chatResult.reply },
    ];
    const finalResult = await reflectOnSession(finalExchange, emotionAfterFinal, terminationSessionSettings, {
      archiveLabel: `${personaName}-termination`,
      resetAfterArchive: true,
      journalRole: "termination",
      journalFilename: journalFilenameToReflect,
    });
    if (finalResult.usage) updateUsageDisplay(finalResult.usage, finalResult.turnTokens);
    reflectionStatus.textContent = finalResult.archivedTo
      ? `Terminated — archived as ${finalResult.archivedTo}.`
      : "Termination reflection failed — see console.";

    // End the visible session, same as "Reset conversation" — except
    // tts.stop() is deliberately *not* called, so the agent's just-spoken
    // final words keep playing instead of being cut off by this reset.
    dialogEpoch.reflection++;
    if (pendingSpeakTimer !== null) {
      window.clearTimeout(pendingSpeakTimer);
      pendingSpeakTimer = null;
    }
    pendingAgentReply = null;
    pendingAgentMode = null;
    state.dialogHistories.reflection = [];
    dialogHistoryEl.innerHTML = "";
    saveState(state);
    // seedIfEmpty() starts the new journal session itself, immediately —
    // safe regardless of whether finalResult's /api/reflect call has fully
    // finished on the server by now, since it named its own page explicitly
    // above rather than relying on timing.
    seedIfEmpty("reflection");
    scrollDialogToBottom();
    renderReflections(null);
    reseedReflectionEmotionIfFresh(null);
    applySessionSettingsIfFresh(null);
  } finally {
    chatInput.disabled = false;
    chatSendBtn.disabled = false;
  }
}

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;

  const modeName = state.mode as DialogModeName;

  if (modeName === "reflection" && text.toLowerCase() === "terminate") {
    chatInput.value = "";
    void handleTerminate();
    return;
  }

  chatInput.value = "";
  addTurn(modeName, "user", text);

  if (modeName === "eliza") {
    const reply = eliza.respond(text);
    // Per-turn emotion nudge, local lexicon only (no LLM) — see
    // src/emotionLexicon.ts and the "Eliza mode" comment on
    // currentEmotionWeights() above for why this stays API-free.
    const delta = scoreEmotions(`${text} ${reply}`);
    state.elizaEmotion = applyEmotionDelta(state.elizaEmotion, delta);
    saveState(state);
    if (state.mode === "eliza") setCharacterEmotion(state.elizaEmotion);
    scheduleAgentSpeech("eliza", reply);
    return;
  }

  const epoch = dialogEpoch.reflection;
  showTypingIndicator();
  getAgentReply(state.dialogHistories.reflection, state.personaId).then((result) => {
    hideTypingIndicator();
    updateUsageDisplay(result.usage, result.turnTokens);
    if (dialogEpoch.reflection !== epoch) return; // conversation was reset meanwhile
    // Per-turn emotion nudge: prefer the model's own self-report (tagged onto
    // its reply server-side, see server/emotionSelfReport.ts), falling back
    // to the local lexicon score only if the tag is missing or malformed —
    // never recomputed from the full reflection notes mid-session.
    const delta = result.emotion ?? scoreEmotions(`${text} ${result.reply}`);
    state.reflectionEmotion = applyEmotionDelta(state.reflectionEmotion, delta);
    saveState(state);
    if (state.mode === "reflection") setCharacterEmotion(state.reflectionEmotion);
    scheduleAgentSpeech("reflection", result.reply);
  });
});

fetchUsage().then(updateUsageDisplay);
fetchReflections().then((result) => {
  renderReflections(result?.notes ?? null);
  reseedReflectionEmotionIfFresh(result?.notes ?? null);
  // Runs after applyMode() below in the common case (this is a network
  // fetch), so if it's booting into a fresh empty session, that session's
  // journal page may already have been started under stale persona/heighten
  // settings by then — applySessionSettingsIfFresh() detects that and
  // restarts it under the restored ones. See that function's own comment.
  applySessionSettingsIfFresh(result?.notes ?? null);
  renderMigrationNotice(result?.migrationNotice ?? null);
});
// applyMode -> showDialogMode -> seedIfEmpty() seeds an empty history on
// boot; with no deferJournalStart option passed, seedIfEmpty starts the
// journal session inline — there's no previous session's finalize in
// flight here to race, so no special-casing is needed at boot beyond the
// settings-restoration correction above.
applyMode(state.mode);
