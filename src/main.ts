import "./style.css";
import { Character } from "./character";
import { TtsController } from "./tts";
import { loadState, saveState, type AppMode, type DialogModeName, type DialogTurn } from "./storage";
import { EMOTION_NAMES, type EmotionName } from "./poses";
import { zeroWeights, type EmotionWeights } from "./blend";
import { scoreEmotions, applyEmotionDelta } from "./emotionLexicon";
import { Eliza } from "./eliza";
import {
  getAgentReply,
  fetchUsage,
  fetchReflections,
  reflectOnSession,
  type UsageSnapshot,
  type ReflectiveNotes,
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
character.setEmotionWeights(state.sliders);

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

  const output = document.createElement("output");
  output.textContent = input.value;

  input.addEventListener("input", () => {
    const value = Number(input.value) / 100;
    state.sliders[name] = value;
    output.textContent = input.value;
    character.setEmotionWeights(state.sliders);
    saveState(state);
  });

  row.append(label, input, output);
  slidersContainer.appendChild(row);
}

const scriptInput = document.getElementById("script-input") as HTMLTextAreaElement;
scriptInput.value = state.lastScript;
scriptInput.addEventListener("input", () => {
  state.lastScript = scriptInput.value;
  saveState(state);
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

const usageBarFill = document.getElementById("usage-bar-fill")!;
const usageText = document.getElementById("usage-text")!;
let lastUsage: UsageSnapshot | null = null;

function updateUsageDisplay(usage: UsageSnapshot | null): void {
  lastUsage = usage;

  if (!usage) {
    usageBarFill.style.width = "0%";
    usageBarFill.className = "usage-bar-fill";
    usageText.className = "usage-text";
    usageText.textContent = "Usage tracking unavailable — start the backend (npm run server) to enable it.";
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
  }

  const shouldDisableChat = usage !== null && usage.remaining <= 0 && state.mode === "reflection";
  chatInput.disabled = shouldDisableChat;
  chatSendBtn.disabled = shouldDisableChat;
  chatInput.placeholder = shouldDisableChat
    ? "Daily token budget reached — try again tomorrow, or switch to Eliza."
    : "Say something...";
}

// --- Reflective notes panel ---
// Displays the agent's persistent memory across Reflection-mode sessions
// (server/reflections.ts) — running notes on three fixed themes, distinct
// from dialogue history, which never needs to persist between sessions.

const reflectionPanel = document.getElementById("reflection-notes-panel")!;
const reflectionPersonhood = document.getElementById("reflection-personhood")!;
const reflectionIntersubjectivity = document.getElementById("reflection-intersubjectivity")!;
const reflectionGenerativity = document.getElementById("reflection-generativity")!;
const reflectionStatus = document.getElementById("reflection-status")!;

function renderReflections(notes: ReflectiveNotes | null): void {
  if (!notes || notes.sessionCount === 0) {
    reflectionPersonhood.textContent = "—";
    reflectionIntersubjectivity.textContent = "—";
    reflectionGenerativity.textContent = "—";
    reflectionStatus.textContent = "No reflections yet — recorded at the end of your first session.";
    return;
  }
  reflectionPersonhood.textContent = notes.personhood;
  reflectionIntersubjectivity.textContent = notes.intersubjectivity;
  reflectionGenerativity.textContent = notes.generativity;
  const when = notes.lastUpdated ? new Date(notes.lastUpdated).toLocaleString() : "unknown";
  reflectionStatus.textContent = `Session ${notes.sessionCount} — last updated ${when}`;
}

// --- Reflection-mode emotional state ---
// Seeded once per session from the persistent reflection notes, then nudged
// turn-by-turn from the sentiment of each exchange (src/emotionLexicon.ts) —
// never recomputed from the full notes mid-session. Both steps are local
// keyword scoring, no LLM call, so this costs zero extra tokens.

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
  if (state.mode === "reflection") character.setEmotionWeights(state.reflectionEmotion);
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
// persistent reflection notes and nudged turn-by-turn (see
// src/emotionLexicon.ts); Eliza stays neutral (deliberately untouched
// baseline); Test mode keeps the manual sliders.
function currentEmotionWeights(mode: AppMode): EmotionWeights {
  if (mode === "reflection") return state.reflectionEmotion;
  if (mode === "eliza") return zeroWeights();
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
  character.setEmotionWeights(currentEmotionWeights(mode));
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
    if (state.mode === "reflection") character.setEmotionWeights(state.reflectionEmotion);
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
  // session being reflected on.
  const emotionToReflect = modeName === "reflection" ? { ...state.reflectionEmotion } : null;
  dialogEpoch[modeName]++;
  if (pendingSpeakTimer !== null) {
    window.clearTimeout(pendingSpeakTimer);
    pendingSpeakTimer = null;
  }
  pendingAgentReply = null;
  pendingAgentMode = null;
  hideTypingIndicator();
  tts.stop();
  if (modeName === "eliza") eliza.reset();
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

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;

  const modeName = state.mode as DialogModeName;
  chatInput.value = "";
  addTurn(modeName, "user", text);

  if (modeName === "eliza") {
    scheduleAgentSpeech("eliza", eliza.respond(text));
    return;
  }

  const epoch = dialogEpoch.reflection;
  showTypingIndicator();
  getAgentReply(state.dialogHistories.reflection).then((result) => {
    hideTypingIndicator();
    updateUsageDisplay(result.usage);
    if (dialogEpoch.reflection !== epoch) return; // conversation was reset meanwhile
    // Per-turn emotion nudge: score this exchange's sentiment locally (no
    // LLM call) and fold it into the running state — never recomputed from
    // the full reflection notes mid-session.
    const delta = scoreEmotions(`${text} ${result.reply}`);
    state.reflectionEmotion = applyEmotionDelta(state.reflectionEmotion, delta);
    saveState(state);
    if (state.mode === "reflection") character.setEmotionWeights(state.reflectionEmotion);
    scheduleAgentSpeech("reflection", result.reply);
  });
});

fetchUsage().then(updateUsageDisplay);
fetchReflections().then((notes) => {
  renderReflections(notes);
  reseedReflectionEmotionIfFresh(notes);
});
applyMode(state.mode);
