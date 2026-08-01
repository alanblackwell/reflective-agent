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
  // the model's own self-report (see server/emotionSelfReport.ts, with a
  // local-lexicon fallback in src/emotionLexicon.ts). Kept separate from
  // `sliders`, which is the manual test-mode UI control.
  reflectionEmotion: EmotionWeights;
  // Eliza-mode-only emotional state: starts neutral each session and is
  // nudged turn-by-turn by the local lexicon (src/emotionLexicon.ts) — no
  // LLM involved, per explicit user request to keep Eliza mode's API-free
  // design. Reset to neutral whenever Eliza's conversation is reset.
  elizaEmotion: EmotionWeights;
  // Whether the compact six-bar emotion readout (src/emotionWidget.ts) is
  // minimized. Persisted so the user's preference survives a reload rather
  // than the widget always reappearing.
  emotionWidgetCollapsed: boolean;
  // 0..1 "heighten" amount applied on top of whatever emotion weights are
  // currently active, in every mode (see applyHeighten() in blend.ts).
  // Models an exaggerated/altered emotional state, not a literal sentiment
  // reading. 0 = untouched.
  heighten: number;
  // Test script mode's "React" toggle: when true, the character's emotion is
  // driven by scoring `lastScript` with the local lexicon (see
  // src/emotionLexicon.ts, the same zero-cost method Eliza mode uses)
  // instead of the manual `sliders`, which are disabled (greyed out) while
  // this is on.
  scriptReactEnabled: boolean;
  // Reflection-mode-only: which persona preset (server/personas.ts) the
  // system prompt is built from. Not validated against the server's catalog
  // here — that's fetched asynchronously after load; src/main.ts corrects
  // this to a known id once the catalog arrives.
  personaId: string;
}

// Tuned to make the "Junior" voice (macOS) read more child-like.
const DEFAULT_PITCH = 1.65;
const DEFAULT_RATE = 0.5;

// Mirrors DEFAULT_PERSONA_ID in server/personas.ts — kept as a plain literal
// here since client and server don't share a module.
const DEFAULT_PERSONA_ID = "default";

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
    elizaEmotion: zeroWeights(),
    emotionWidgetCollapsed: false,
    heighten: 0,
    scriptReactEnabled: false,
    personaId: DEFAULT_PERSONA_ID,
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
      elizaEmotion: { ...zeroWeights(), ...parsed.elizaEmotion },
      emotionWidgetCollapsed: typeof parsed.emotionWidgetCollapsed === "boolean" ? parsed.emotionWidgetCollapsed : false,
      heighten: typeof parsed.heighten === "number" ? Math.max(0, Math.min(1, parsed.heighten)) : 0,
      scriptReactEnabled: typeof parsed.scriptReactEnabled === "boolean" ? parsed.scriptReactEnabled : false,
      personaId: typeof parsed.personaId === "string" ? parsed.personaId : DEFAULT_PERSONA_ID,
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
