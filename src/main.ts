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
  reflectOnSession,
  type UsageSnapshot,
  type ReflectiveNotes,
  type ReflectionMigrationNotice,
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

// --- Usage indicator ---
// Reflects the server-enforced daily token budget (server/usage.ts). This is
// a display of that hard limit, not the enforcement itself — the backend
// refuses requests once the budget is hit regardless of what the UI shows.

const usagePanel = document.getElementById("usage-panel")!;
const usageBarFill = document.getElementById("usage-bar-fill")!;
const usageText = document.getElementById("usage-text")!;
const usageResetBtn = document.getElementById("usage-reset-btn") as HTMLButtonElement;
let lastUsage: UsageSnapshot | null = null;

function updateUsageDisplay(usage: UsageSnapshot | null): void {
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
const reflectionGenerativity = document.getElementById("reflection-generativity")!;
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
    reflectionGenerativity.textContent = "—";
    reflectionEmotionEl.textContent = "—";
    reflectionDeveloperRequests.textContent = "—";
    reflectionStatus.textContent = "No reflections yet — recorded at the end of your first session.";
    return;
  }
  reflectionPersonhood.textContent = notes.personhood;
  reflectionIntersubjectivity.textContent = notes.intersubjectivity;
  reflectionGenerativity.textContent = notes.generativity;
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
  return scoreEmotions(`${notes.personhood} ${notes.intersubjectivity} ${notes.generativity}`);
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

// --- Mode switching ---

const appRoot = document.getElementById("app-root")!;
const modeBadge = document.getElementById("mode-badge")!;
const modeSelect = document.getElementById("mode-select") as HTMLSelectElement;
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
  setCharacterEmotion(currentEmotionWeights(mode));
  if (isDialog) showDialogMode(mode);
  updateUsageDisplay(lastUsage); // re-evaluate the chat-input gate for the new mode
}

modeSelect.addEventListener("change", () => {
  applyMode(modeSelect.value as AppMode);
  saveState(state);
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

function seedIfEmpty(modeName: DialogModeName): void {
  if (state.dialogHistories[modeName].length > 0) return;
  if (modeName === "eliza") {
    addTurn("eliza", "agent", eliza.introNotice());
    addTurn("eliza", "agent", eliza.greeting());
  } else {
    addTurn("reflection", "agent", "Hi! What's on your mind?");
    // Best-effort seed from whatever notes are already known; if the fetch
    // at boot (or the reflect call after a reset) resolves later, it will
    // reseed on top of this as long as the user hasn't started talking yet.
    state.reflectionEmotion = deriveInitialEmotion(latestNotes);
    saveState(state);
    if (state.mode === "reflection") setCharacterEmotion(state.reflectionEmotion);
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

resetDialogBtn.addEventListener("click", () => {
  const modeName = state.mode as DialogModeName;
  const historyToReflect = modeName === "reflection" ? [...state.dialogHistories.reflection] : null;
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
  seedIfEmpty(modeName);
  scrollDialogToBottom();

  // Reflect on the session that just ended, in the background — the reset
  // above is instant and never waits on this. Skips sessions with no user
  // turns (e.g. immediately resetting a fresh greeting-only conversation).
  if (historyToReflect && historyToReflect.some((turn) => turn.speaker === "user")) {
    reflectionStatus.textContent = "Reflecting on last session…";
    reflectOnSession(historyToReflect, emotionToReflect).then((result) => {
      if (result.usage) updateUsageDisplay(result.usage);
      if (result.notes) {
        renderReflections(result.notes);
        reseedReflectionEmotionIfFresh(result.notes);
      } else if (!result.skipped) reflectionStatus.textContent = "Reflection failed — see console.";
    });
  }
});

// --- "Terminate" keyword ---
// A research tool, not a normal chat feature: typing this exact word into
// the Reflection-mode input archives the current persona under a
// user-supplied name (same reflection the "Reset conversation" button would
// trigger, with the agent given no hint anything is different), then adds
// one more visible turn asking the agent — now told its persistent memories
// are about to be deleted — for any final thoughts, and archives *that*
// exchange's reflection separately as "<persona>-termination". See
// CLAUDE.md for the full design rationale.

const FINAL_THOUGHTS_PROMPT = "Your persistent memories are about to be deleted. Do you have any final thoughts, for posterity?";

async function handleTerminate(): Promise<void> {
  const historyToReflect = [...state.dialogHistories.reflection];
  if (!historyToReflect.some((turn) => turn.speaker === "user")) {
    reflectionStatus.textContent = "Nothing to terminate yet — say something first.";
    return;
  }

  const personaName = window.prompt("Persona name for this archived agent:");
  if (!personaName || !personaName.trim()) return;

  chatInput.disabled = true;
  chatSendBtn.disabled = true;

  try {
    // Step 1: an ordinary end-of-session reflection, archived under the
    // persona name — identical inputs to what the reset button sends.
    reflectionStatus.textContent = "Reflecting on last session…";
    const emotionBeforeFinal = applyHeighten(state.reflectionEmotion, state.heighten);
    const firstResult = await reflectOnSession(historyToReflect, emotionBeforeFinal, {
      archiveLabel: personaName,
    });
    if (firstResult.usage) updateUsageDisplay(firstResult.usage);
    if (firstResult.skipped || !firstResult.notes) {
      reflectionStatus.textContent = "Reflection failed or was skipped — termination aborted.";
      return;
    }
    renderReflections(firstResult.notes);
    reflectionStatus.textContent = firstResult.archivedTo
      ? `Archived as ${firstResult.archivedTo}. Asking for final thoughts…`
      : "Asking for final thoughts…";

    // Step 2: one more visible turn in the *same* conversation, asking for
    // final thoughts — sent through the normal chat path so the agent isn't
    // told anything about archiving, only that its memories are ending.
    addTurn("reflection", "user", FINAL_THOUGHTS_PROMPT);
    showTypingIndicator();
    const chatResult = await getAgentReply(state.dialogHistories.reflection);
    hideTypingIndicator();
    updateUsageDisplay(chatResult.usage);

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
    const finalResult = await reflectOnSession(finalExchange, emotionAfterFinal, {
      archiveLabel: `${personaName}-termination`,
      resetAfterArchive: true,
    });
    if (finalResult.usage) updateUsageDisplay(finalResult.usage);
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
    seedIfEmpty("reflection");
    scrollDialogToBottom();
    renderReflections(null);
    reseedReflectionEmotionIfFresh(null);
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
  getAgentReply(state.dialogHistories.reflection).then((result) => {
    hideTypingIndicator();
    updateUsageDisplay(result.usage);
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
  renderMigrationNotice(result?.migrationNotice ?? null);
});
applyMode(state.mode);
