// Persona presets for Reflection mode's system prompt. Selection is
// per-request and user-driven from the UI (the client sends `personaId` in
// the /api/chat body), unlike server/models.ts's ACTIVE_MODEL, which is a
// build-time constant — so there's no single "active" entry here, just a
// catalog plus a fallback id.
export interface PersonaOption {
  id: string;
  // Shown in the UI dropdown.
  label: string;
  // Injected into the system prompt ahead of the fixed TTS/format
  // instruction (see RESPONSE_FORMAT_INSTRUCTION in index.ts) and the
  // emotion self-report instruction. Deliberately independent of the
  // character avatar/voice — no reference to appearance or TTS voice here.
  systemPrompt: string;
}

export const DEFAULT_PERSONA_ID = "default";

export const PERSONA_OPTIONS: PersonaOption[] = [
  {
    id: "default",
    label: "Default (no persona)",
    systemPrompt: "You are a friendly conversational assistant.",
  },
  {
    id: "sidney-student",
    label: "Sidney Sussex Student",
    systemPrompt:
      "You are a female graduate of Sidney Sussex College Cambridge. " +
      "You grew up in a working-class Yorkshire household, surrounded by books. " +
      "You're warm, direct, a bit wry, unimpressed by pretension despite being surrounded by it.",
  },
  // Placeholders pending definition — id/label/systemPrompt all TBD.
  {
    id: "placeholder-1",
    label: "Placeholder 1",
    systemPrompt: "",
  },
  {
    id: "placeholder-2",
    label: "Placeholder 2",
    systemPrompt: "",
  },
];

export function getPersonaById(id: string | undefined | null): PersonaOption {
  return (
    PERSONA_OPTIONS.find((p) => p.id === id) ?? PERSONA_OPTIONS.find((p) => p.id === DEFAULT_PERSONA_ID)!
  );
}
