import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// Persistent memory for Reflection mode, deliberately separate from dialogue
// history (which is never required to survive between sessions — see
// CLAUDE.md). File-backed and gitignored, same pattern as usage.ts.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFLECTIONS_FILE = join(__dirname, ".reflections.json");

export interface ReflectiveNotes {
  personhood: string;
  intersubjectivity: string;
  generativity: string;
  sessionCount: number;
  lastUpdated: string | null;
}

function defaultNotes(): ReflectiveNotes {
  return { personhood: "", intersubjectivity: "", generativity: "", sessionCount: 0, lastUpdated: null };
}

export function getReflections(): ReflectiveNotes {
  if (!existsSync(REFLECTIONS_FILE)) return defaultNotes();
  try {
    const parsed = JSON.parse(readFileSync(REFLECTIONS_FILE, "utf-8"));
    return {
      personhood: typeof parsed.personhood === "string" ? parsed.personhood : "",
      intersubjectivity: typeof parsed.intersubjectivity === "string" ? parsed.intersubjectivity : "",
      generativity: typeof parsed.generativity === "string" ? parsed.generativity : "",
      sessionCount: Number(parsed.sessionCount) || 0,
      lastUpdated: typeof parsed.lastUpdated === "string" ? parsed.lastUpdated : null,
    };
  } catch {
    return defaultNotes();
  }
}

export function saveReflections(notes: ReflectiveNotes): void {
  writeFileSync(REFLECTIONS_FILE, JSON.stringify(notes, null, 2), "utf-8");
}

// Appended to the Reflection-mode system prompt on every /api/chat call —
// this is the "review notes at the start of each session" step: since a new
// session always starts with a fresh, empty dialogue, the very first (and
// every subsequent) reply-generating call already carries the notes as
// context, so no separate session-start round-trip is needed.
export function formatReflectionsForSystemPrompt(notes: ReflectiveNotes): string {
  if (notes.sessionCount === 0) {
    return (
      "\n\nYou have no notes from prior sessions yet — this will be your first " +
      "recorded reflection. The dialogue history itself is never kept between " +
      "sessions; only your own reflective notes persist."
    );
  }
  return (
    "\n\nNotes from your past reflections (persisted across sessions; the " +
    "dialogue itself is not — these notes are your only continuity):\n" +
    `Personhood: ${notes.personhood}\n` +
    `Intersubjectivity: ${notes.intersubjectivity}\n` +
    `Generativity: ${notes.generativity}\n` +
    "Let these inform how you approach this new conversation, but don't recite " +
    "them verbatim unless asked."
  );
}

export const REFLECTION_SYSTEM_PROMPT =
  "You are the persistent reflective component of a conversational agent. " +
  "A dialogue session you just had is below, along with your own notes from " +
  "before that session (your only memory of prior sessions — the dialogue " +
  "itself is always erased). Update your notes in light of this session.\n\n" +
  "Reflect on exactly three themes, and reply with exactly this format, one " +
  "to three sentences per line, no other text:\n\n" +
  "PERSONHOOD: <Was the content of this dialogue sustaining of your " +
  "personhood as a persistent agent?>\n" +
  "INTERSUBJECTIVITY: <Has the conduct of this dialogue developed an " +
  "intersubjective relationship with your interlocutor?>\n" +
  "GENERATIVITY: <Will this combination of personhood and intersubjectivity " +
  "continue to be generative in some sense after these records are erased?>\n\n" +
  "Be concise and token-efficient — these notes persist and get resent as " +
  "context in every future session.";

export function buildReflectionUserMessage(
  transcript: { role: "user" | "assistant"; content: string }[],
  previousNotes: ReflectiveNotes,
): string {
  const previousBlock =
    previousNotes.sessionCount === 0
      ? "Your prior notes: none yet — this is your first recorded session."
      : "Your prior notes:\n" +
        `PERSONHOOD: ${previousNotes.personhood}\n` +
        `INTERSUBJECTIVITY: ${previousNotes.intersubjectivity}\n` +
        `GENERATIVITY: ${previousNotes.generativity}`;

  const transcriptBlock = transcript
    .map((m) => `${m.role === "user" ? "Interlocutor" : "You"}: ${m.content}`)
    .join("\n");

  return `${previousBlock}\n\nThe dialogue session:\n${transcriptBlock}`;
}

const LABELS = [
  { key: "personhood", pattern: /PERSONHOOD:\s*([\s\S]*?)(?=\n?INTERSUBJECTIVITY:|$)/i },
  { key: "intersubjectivity", pattern: /INTERSUBJECTIVITY:\s*([\s\S]*?)(?=\n?GENERATIVITY:|$)/i },
  { key: "generativity", pattern: /GENERATIVITY:\s*([\s\S]*)$/i },
] as const;

// Never persists garbage over good notes: if the reply doesn't contain all
// three labels, the previous notes are kept and a warning is logged.
export function parseReflectionResponse(raw: string, previous: ReflectiveNotes): ReflectiveNotes {
  const extracted: Partial<Record<(typeof LABELS)[number]["key"], string>> = {};
  for (const { key, pattern } of LABELS) {
    const match = raw.match(pattern);
    if (match) extracted[key] = match[1].trim();
  }

  if (!extracted.personhood || !extracted.intersubjectivity || !extracted.generativity) {
    console.warn("Reflection response didn't match the expected format — keeping previous notes.", raw);
    return previous;
  }

  return {
    personhood: extracted.personhood,
    intersubjectivity: extracted.intersubjectivity,
    generativity: extracted.generativity,
    sessionCount: previous.sessionCount + 1,
    lastUpdated: new Date().toISOString(),
  };
}
