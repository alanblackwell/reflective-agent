import "./style.css";
import { Character } from "./character";
import { TtsController } from "./tts";
import { loadState, saveState, type AppMode, type DialogTurn } from "./storage";
import { EMOTION_NAMES, type EmotionName } from "./poses";
import { zeroWeights } from "./blend";
import { Eliza } from "./eliza";

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

const tts = new TtsController({
  onMouthPulse: (intensity) => character.pulseMouth(intensity),
  onStart: () => {
    speakBtn.disabled = true;
    if (pendingAgentReply !== null) {
      addTurn("agent", pendingAgentReply);
      pendingAgentReply = null;
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

// --- Mode toggle ---

const appRoot = document.getElementById("app-root")!;
const modeBadge = document.getElementById("mode-badge")!;
const modeToggleBtn = document.getElementById("mode-toggle") as HTMLButtonElement;
const testModePanels = document.getElementById("test-mode-panels")!;
const dialogModePanels = document.getElementById("dialog-mode-panels")!;

function applyMode(mode: AppMode): void {
  state.mode = mode;
  const isDialog = mode === "dialog";
  appRoot.classList.toggle("dialog-mode", isDialog);
  testModePanels.classList.toggle("hidden", isDialog);
  dialogModePanels.classList.toggle("hidden", !isDialog);
  modeBadge.textContent = isDialog ? "dialog mode" : "test mode";
  modeToggleBtn.textContent = isDialog ? "Switch to test mode" : "Switch to dialog mode";
  // No slider UI in dialog mode, so the character reads as neutral there;
  // switching back to test mode restores whatever the sliders are set to.
  character.setEmotionWeights(isDialog ? zeroWeights() : state.sliders);
  if (isDialog) scrollDialogToBottom();
}

modeToggleBtn.addEventListener("click", () => {
  applyMode(state.mode === "dialog" ? "test" : "dialog");
  saveState(state);
});

// --- Dialog mode ---

const dialogHistoryEl = document.getElementById("dialog-history")!;
const chatForm = document.getElementById("chat-form") as HTMLFormElement;
const chatInput = document.getElementById("chat-input") as HTMLInputElement;
const resetDialogBtn = document.getElementById("reset-dialog-btn") as HTMLButtonElement;
const eliza = new Eliza();

// Natural-feeling conversational beat before the agent's reply is spoken,
// as if it were briefly composing its answer.
const AGENT_PAUSE_MIN_MS = 500;
const AGENT_PAUSE_MAX_MS = 1200;
let pendingSpeakTimer: number | null = null;

function scrollDialogToBottom(): void {
  dialogHistoryEl.scrollTop = dialogHistoryEl.scrollHeight;
}

function renderTurn(turn: DialogTurn): void {
  const pill = document.createElement("div");
  pill.className = `chat-pill ${turn.speaker}`;
  pill.textContent = turn.text;
  dialogHistoryEl.appendChild(pill);
}

function addTurn(speaker: DialogTurn["speaker"], text: string): void {
  const turn: DialogTurn = { speaker, text };
  state.dialogHistory.push(turn);
  saveState(state);
  renderTurn(turn);
  scrollDialogToBottom();
}

function seedInitialDialog(): void {
  addTurn("agent", eliza.introNotice());
  addTurn("agent", eliza.greeting());
}

if (state.dialogHistory.length === 0) {
  seedInitialDialog();
} else {
  for (const turn of state.dialogHistory) renderTurn(turn);
}

resetDialogBtn.addEventListener("click", () => {
  if (pendingSpeakTimer !== null) {
    window.clearTimeout(pendingSpeakTimer);
    pendingSpeakTimer = null;
  }
  pendingAgentReply = null;
  tts.stop();
  eliza.reset();
  state.dialogHistory = [];
  dialogHistoryEl.innerHTML = "";
  saveState(state);
  seedInitialDialog();
});

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;

  chatInput.value = "";
  addTurn("user", text);

  const reply = eliza.respond(text);

  if (pendingSpeakTimer !== null) window.clearTimeout(pendingSpeakTimer);
  if (!tts.isSupported()) {
    // No speech to wait for — fall back to showing the reply immediately.
    addTurn("agent", reply);
    return;
  }

  const pause = AGENT_PAUSE_MIN_MS + Math.random() * (AGENT_PAUSE_MAX_MS - AGENT_PAUSE_MIN_MS);
  pendingAgentReply = reply;
  pendingSpeakTimer = window.setTimeout(() => {
    pendingSpeakTimer = null;
    tts.speak(reply);
  }, pause);
});

applyMode(state.mode);
