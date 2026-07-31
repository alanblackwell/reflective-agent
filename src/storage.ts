import { zeroWeights, type EmotionWeights } from "./blend";

const STORAGE_KEY = "reflective-agent:app-state";

export type AppMode = "test" | "eliza" | "reflection";
export type DialogModeName = "eliza" | "reflection";

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
  dialogHistories: Record<DialogModeName, DialogTurn[]>;
  speechEnabled: boolean;
  // Reflection-mode-only emotional state: seeded from the persistent
  // reflection notes at the start of a session, then nudged turn-by-turn by
  // a local sentiment score (see src/emotionLexicon.ts). Kept separate from
  // `sliders`, which is the manual test-mode UI control.
  reflectionEmotion: EmotionWeights;
}

// Tuned to make the "Junior" voice (macOS) read more child-like.
const DEFAULT_PITCH = 1.65;
const DEFAULT_RATE = 0.5;

function defaultState(): PersistedState {
  return {
    mode: "reflection",
    sliders: zeroWeights(),
    lastScript: "",
    voiceURI: null,
    pitch: DEFAULT_PITCH,
    rate: DEFAULT_RATE,
    dialogHistories: { eliza: [], reflection: [] },
    speechEnabled: true,
    reflectionEmotion: zeroWeights(),
  };
}

function isDialogTurn(value: unknown): value is DialogTurn {
  if (typeof value !== "object" || value === null) return false;
  const turn = value as Record<string, unknown>;
  return (turn.speaker === "user" || turn.speaker === "agent") && typeof turn.text === "string";
}

function parseHistories(value: unknown): Record<DialogModeName, DialogTurn[]> {
  const obj = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    eliza: Array.isArray(obj.eliza) ? obj.eliza.filter(isDialogTurn) : [],
    reflection: Array.isArray(obj.reflection) ? obj.reflection.filter(isDialogTurn) : [],
  };
}

export function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    const mode: AppMode =
      parsed.mode === "test" || parsed.mode === "eliza" || parsed.mode === "reflection"
        ? parsed.mode
        : "reflection";
    return {
      mode,
      sliders: { ...zeroWeights(), ...parsed.sliders },
      lastScript: typeof parsed.lastScript === "string" ? parsed.lastScript : "",
      voiceURI: typeof parsed.voiceURI === "string" ? parsed.voiceURI : null,
      pitch: typeof parsed.pitch === "number" ? parsed.pitch : DEFAULT_PITCH,
      rate: typeof parsed.rate === "number" ? parsed.rate : DEFAULT_RATE,
      dialogHistories: parseHistories(parsed.dialogHistories),
      speechEnabled: typeof parsed.speechEnabled === "boolean" ? parsed.speechEnabled : true,
      reflectionEmotion: { ...zeroWeights(), ...parsed.reflectionEmotion },
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
