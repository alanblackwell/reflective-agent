import { zeroWeights, type EmotionWeights } from "./blend";

const STORAGE_KEY = "reflective-agent:app-state";

export type AppMode = "test" | "dialog";

export interface DialogTurn {
  speaker: "user" | "agent";
  text: string;
}

export interface PersistedState {
  mode: AppMode;
  sliders: EmotionWeights;
  lastScript: string;
  voiceURI: string | null;
  pitch: number;
  rate: number;
  dialogHistory: DialogTurn[];
}

// Tuned to make the "Junior" voice (macOS) read more child-like.
const DEFAULT_PITCH = 1.65;
const DEFAULT_RATE = 0.5;

function defaultState(): PersistedState {
  return {
    mode: "test",
    sliders: zeroWeights(),
    lastScript: "",
    voiceURI: null,
    pitch: DEFAULT_PITCH,
    rate: DEFAULT_RATE,
    dialogHistory: [],
  };
}

function isDialogTurn(value: unknown): value is DialogTurn {
  if (typeof value !== "object" || value === null) return false;
  const turn = value as Record<string, unknown>;
  return (turn.speaker === "user" || turn.speaker === "agent") && typeof turn.text === "string";
}

export function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return {
      mode: parsed.mode === "dialog" ? "dialog" : "test",
      sliders: { ...zeroWeights(), ...parsed.sliders },
      lastScript: typeof parsed.lastScript === "string" ? parsed.lastScript : "",
      voiceURI: typeof parsed.voiceURI === "string" ? parsed.voiceURI : null,
      pitch: typeof parsed.pitch === "number" ? parsed.pitch : DEFAULT_PITCH,
      rate: typeof parsed.rate === "number" ? parsed.rate : DEFAULT_RATE,
      dialogHistory: Array.isArray(parsed.dialogHistory)
        ? parsed.dialogHistory.filter(isDialogTurn)
        : [],
    };
  } catch {
    return defaultState();
  }
}

export function saveState(state: PersistedState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage unavailable (private browsing, quota, etc.) — fail silently,
    // persistence is a convenience, not a hard requirement for the app to work.
  }
}
