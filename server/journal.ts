import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { getPersonaById, type PersonaOption } from "./personas";
import { formatReflectionsForSystemPrompt, getReflections, type ReflectiveNotes } from "./reflections";

// Human-readable, self-contained HTML archive of every Reflection-mode
// session, for research review — deliberately separate from the compact
// reflective notes (server/reflections.ts), which are the agent's own
// working memory, not a transcript. See CLAUDE.md for the full design
// rationale (in particular why prev/next linking happens at the *next*
// session's start, not the current one's finalize, and why sessions are
// written incrementally rather than assembled once at the end).

const __dirname = dirname(fileURLToPath(import.meta.url));
const JOURNAL_DIR = join(__dirname, "journal");
const POINTER_FILE = join(JOURNAL_DIR, ".pointer.json");
mkdirSync(JOURNAL_DIR, { recursive: true });

interface Pointer {
  lastFilename: string | null;
  nextSeq: number;
}

function loadPointer(): Pointer {
  if (!existsSync(POINTER_FILE)) return { lastFilename: null, nextSeq: 1 };
  try {
    const parsed = JSON.parse(readFileSync(POINTER_FILE, "utf-8"));
    return {
      lastFilename: typeof parsed.lastFilename === "string" ? parsed.lastFilename : null,
      nextSeq: Number.isInteger(parsed.nextSeq) && parsed.nextSeq > 0 ? parsed.nextSeq : 1,
    };
  } catch {
    return { lastFilename: null, nextSeq: 1 };
  }
}

function savePointer(pointer: Pointer): void {
  writeFileSync(POINTER_FILE, JSON.stringify(pointer, null, 2), "utf-8");
}

// Single-user local app — no concurrent sessions, so one module-level slot
// (rewritten to disk in full on every mutation, same "rewrite the whole
// file" simplicity as usage.ts/reflections.ts) is all that's needed.
interface CurrentSession {
  filename: string;
  seq: number;
  previousFilename: string | null;
  startedAtDisplay: string;
  personaLabel: string;
  blocks: string[];
  turnCount: number;
  // Stashed by the "terminate" flow's deferred reflect call (Step 1) — held
  // here rather than written to disk immediately, since Step 2's final-
  // thoughts exchange and Step 3's termination reflection still need to land
  // on this same page before it's finalized. See recordReflection() below.
  pendingReflectionText: string | null;
}

// Two slots, not one: `currentSession` is whichever conversation is live
// right now (accepts appendTurn/appendHeightenChange/appendPersonaChange).
// `finalizingSession` holds a *previous* session whose /api/reflect call is
// still in flight when a new one starts — which happens routinely, since
// the visible dialog resets instantly (a deliberate, pre-existing UX
// principle — see resetCurrentDialog() in main.ts) while reflection is an
// LLM call that can take seconds, easily long enough for a fast-typing user
// to send their first message in the new session before the old one's
// reflect call has even returned. A single shared slot would either lose
// those early turns (if the new session waited to start) or misattribute
// the eventual reflection to the wrong page (if it didn't) — this project
// hit exactly that bug twice before this fix; see CLAUDE.md. `startSession()`
// bumps whatever's in `currentSession` into `finalizingSession` before
// replacing it; `recordReflection()` (called from /api/reflect, which now
// carries an explicit `journalFilename` identifying which page it's for —
// see server/index.ts) finalizes whichever slot actually matches, falling
// back to `finalizingSession ?? currentSession` only if no filename was
// supplied. Only one `finalizingSession` slot exists (matching this
// single-user app's normal usage — one reflect call in flight at a time);
// if a second one would be needed, the older one is dropped with a warning
// rather than silently corrupting either page.
let currentSession: CurrentSession | null = null;
let finalizingSession: CurrentSession | null = null;

// Sidecar for both slots (distinct from the rendered HTML pages), so an
// in-progress session survives a backend restart — `npm run server`
// requires a manual restart to pick up any server/*.ts change (no
// tsx watch), and without this, that restart would silently and
// permanently strand the rest of that session: appendTurn()/
// recordReflection() would keep no-op'ing (or matching nothing) even after
// the new process is back up, exactly the failure this was added to fix.
const SESSION_STATE_FILE = join(JOURNAL_DIR, ".session-state.json");

function loadSessionStateFromDisk(): { active: CurrentSession | null; finalizing: CurrentSession | null } {
  if (!existsSync(SESSION_STATE_FILE)) return { active: null, finalizing: null };
  try {
    const parsed = JSON.parse(readFileSync(SESSION_STATE_FILE, "utf-8"));
    const isSession = (v: unknown): v is CurrentSession =>
      typeof v === "object" && v !== null && typeof (v as CurrentSession).filename === "string" && Array.isArray((v as CurrentSession).blocks);
    return {
      active: isSession(parsed.active) ? parsed.active : null,
      finalizing: isSession(parsed.finalizing) ? parsed.finalizing : null,
    };
  } catch {
    // corrupt sidecar — fall through to null, same tolerance as the other
    // file-backed stores (usage.ts/reflections.ts) show on a bad read.
    return { active: null, finalizing: null };
  }
}

function persistSessionState(): void {
  if (!currentSession && !finalizingSession) {
    if (existsSync(SESSION_STATE_FILE)) {
      try {
        unlinkSync(SESSION_STATE_FILE);
      } catch (err) {
        console.warn("Failed to clear journal session-state sidecar:", err);
      }
    }
    return;
  }
  writeFileSync(SESSION_STATE_FILE, JSON.stringify({ active: currentSession, finalizing: finalizingSession }), "utf-8");
}

{
  const restored = loadSessionStateFromDisk();
  currentSession = restored.active;
  finalizingSession = restored.finalizing;
}

export type JournalRole = "normal" | "deferred" | "termination";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeForFilename(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]+/g, "-") || "unknown";
}

function timestampForFilename(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const CSS = `
:root { color-scheme: light dark; }
body {
  font-family: Georgia, 'Times New Roman', serif;
  max-width: 46rem;
  margin: 0 auto;
  padding: 1.5rem 1rem 3rem;
  line-height: 1.5;
  color: #1a1a1a;
  background: #fff;
}
h2, h3 { font-family: -apple-system, Helvetica, Arial, sans-serif; }
.journal-nav {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  font-family: -apple-system, Helvetica, Arial, sans-serif;
  font-size: 0.85rem;
  padding: 0.5rem 0.75rem;
  background: #f0f0f0;
  border-radius: 6px;
  margin: 1rem 0;
}
.journal-nav .nav-disabled { color: #999; }
.journal-nav a { color: #1155cc; text-decoration: none; }
.journal-nav a:hover { text-decoration: underline; }
.persona-block, .context-block, .heighten-block {
  background: #f7f5ef;
  border: 1px solid #e0dcd0;
  border-radius: 8px;
  padding: 0.75rem 1rem;
  margin: 0.75rem 0;
}
.small { font-size: 0.85rem; color: #444; }
.context-block pre { white-space: pre-wrap; font-family: inherit; font-size: 0.9rem; margin: 0; }
.dialogue { margin: 1.5rem 0; }
.turn { padding: 0.5rem 0.75rem; border-radius: 6px; margin: 0.4rem 0; }
.turn.user { background: #eaf2ff; }
.turn.agent { background: #f4f4f4; }
.event-bar {
  text-align: center;
  font-family: -apple-system, Helvetica, Arial, sans-serif;
  font-size: 0.85rem;
  font-style: italic;
  background: #fff3cd;
  border: 1px solid #ffe69c;
  border-radius: 6px;
  padding: 0.4rem;
  margin: 0.75rem 0;
}
.event-insert {
  border: 1px dashed #999;
  border-radius: 8px;
  padding: 0.75rem 1rem;
  margin: 0.75rem 0;
}
.reflection-block {
  border: 2px solid #333;
  border-radius: 8px;
  padding: 0.75rem 1rem;
  margin: 1.5rem 0;
}
.terminated-bar {
  background: #000;
  color: #fff;
  text-align: center;
  font-family: -apple-system, Helvetica, Arial, sans-serif;
  font-weight: bold;
  letter-spacing: 0.1em;
  padding: 1rem;
  margin: 1.5rem 0;
  border-radius: 4px;
}
.pending-banner {
  text-align: center;
  font-family: -apple-system, Helvetica, Arial, sans-serif;
  font-size: 0.85rem;
  font-style: italic;
  color: #666;
  background: #eee;
  border: 1px dashed #bbb;
  border-radius: 6px;
  padding: 0.5rem;
  margin: 0.75rem 0;
}
@media (prefers-color-scheme: dark) {
  body { background: #1b1b1b; color: #e8e8e8; }
  .journal-nav { background: #262626; }
  .persona-block, .context-block, .heighten-block { background: #262420; border-color: #3a362c; }
  .small { color: #bbb; }
  .turn.user { background: #1c2c42; }
  .turn.agent { background: #2a2a2a; }
  .event-bar { background: #3a3110; border-color: #5c4d17; color: #f0dca0; }
  .event-insert { border-color: #777; }
  .reflection-block { border-color: #ccc; }
  .journal-nav a { color: #7ab0ff; }
  .pending-banner { background: #262626; border-color: #555; color: #999; }
}
`;

const PENDING_BANNER = `<div class="pending-banner">Dialog not started at time of journal update.</div>`;

// Paired start/end markers, not a single one-shot placeholder — a
// discarded-then-replaced session (see discardCurrentSessionIfEmpty()) means
// the *same* previous file can legitimately need its next-link patched more
// than once (first pointing at the discarded session, then re-patched to
// point at whatever real session follows it instead). A single comment
// consumed by the first patch couldn't be found a second time; markers that
// always survive the replace can be.
function nextLinkMarkers(position: "top" | "bottom"): { start: string; end: string } {
  const tag = position === "top" ? "NEXT_LINK_TOP" : "NEXT_LINK_BOTTOM";
  return { start: `<!-- ${tag}_START -->`, end: `<!-- ${tag}_END -->` };
}

function navBar(position: "top" | "bottom", session: CurrentSession): string {
  const prev = session.previousFilename
    ? `<a href="${escapeHtml(session.previousFilename)}">&larr; Previous session</a>`
    : `<span class="nav-disabled">&larr; Previous session</span>`;
  // Patched in by patchNextLink() once the *following* session is created —
  // see the module comment above for why that's the right trigger point.
  const { start, end } = nextLinkMarkers(position);
  const title = `Session ${session.seq} &mdash; ${escapeHtml(session.personaLabel)} &mdash; ${escapeHtml(session.startedAtDisplay)}`;
  return `<nav class="journal-nav">
  <span class="nav-prev">${prev}</span>
  <span class="nav-title">${title}</span>
  <span class="nav-next">${start}${end}</span>
</nav>`;
}

function renderDocument(session: CurrentSession): string {
  const title = `Reflection session ${session.seq} — ${session.personaLabel}`;
  // Computed fresh on every render from the live turnCount, not baked into
  // session.blocks — so it appears on the very first write (just the header
  // + greeting) and disappears on its own the moment a real turn lands,
  // with no separate "remove it" step needed. Exists specifically so
  // whoever's browsing server/journal/ can tell at a glance that the
  // newest file is normal-and-expected to be empty (it's the live,
  // still-open session — see CLAUDE.md) rather than mistaking it for a
  // broken one.
  const pendingBanner = session.turnCount === 0 ? PENDING_BANNER : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
${navBar("top", session)}
${session.blocks.join("\n")}
${pendingBanner}
${navBar("bottom", session)}
</body>
</html>
`;
}

function writeSessionFile(session: CurrentSession): void {
  writeFileSync(join(JOURNAL_DIR, session.filename), renderDocument(session), "utf-8");
}

function commitActiveSession(): void {
  if (!currentSession) return;
  writeSessionFile(currentSession);
  persistSessionState();
}

// The only surgery ever done on an already-written file: replace whatever's
// between the paired next-link markers with a real link. Re-patchable, not
// one-shot (see nextLinkMarkers()'s comment) — safe to call more than once
// on the same file, e.g. when a discarded-then-replaced session means the
// link needs to move from a now-deleted file to the real one that replaced
// it. Deliberately tolerant of the file being missing (never let a
// journalling hiccup propagate into the main app flow).
function patchNextLink(filename: string, nextFilename: string): void {
  const path = join(JOURNAL_DIR, filename);
  if (!existsSync(path)) return;
  try {
    const link = `<a href="${escapeHtml(nextFilename)}">Next session &rarr;</a>`;
    let html = readFileSync(path, "utf-8");
    for (const position of ["top", "bottom"] as const) {
      const { start, end } = nextLinkMarkers(position);
      html = html.replace(new RegExp(`${start}[\\s\\S]*?${end}`), `${start}${link}${end}`);
    }
    writeFileSync(path, html, "utf-8");
  } catch (err) {
    console.warn("Failed to patch journal next-link:", err);
  }
}

function buildHeaderBlocks(persona: PersonaOption, reflections: ReflectiveNotes, heighten: number): string[] {
  return [
    `<section class="persona-block">
<h2>Persona: ${escapeHtml(persona.label)}</h2>
<p class="small">${escapeHtml(persona.systemPrompt)}</p>
</section>`,
    `<section class="context-block">
<h2>Reflective context at session start</h2>
<pre>${escapeHtml(formatReflectionsForSystemPrompt(reflections).trim())}</pre>
</section>`,
    `<section class="heighten-block">
<p><strong>Emotion heightening at session start:</strong> ${heighten.toFixed(2)}</p>
</section>`,
    // Left open deliberately — closed in recordReflection() once the full
    // dialogue (including, for a terminated session, the final-thoughts
    // exchange) is known to be complete.
    `<section class="dialogue">`,
  ];
}

function buildTurnBlock(speaker: "user" | "agent", text: string): string {
  const label = speaker === "user" ? "User" : "Agent";
  return `<p class="turn ${speaker}"><strong>${label}:</strong> ${escapeHtml(text)}</p>`;
}

function buildHeightenChangeBlock(from: number, to: number): string {
  return `<div class="event-bar heighten-change">Emotion heightening changed from ${from.toFixed(2)} to ${to.toFixed(2)}.</div>`;
}

function buildPersonaChangeBlock(persona: PersonaOption): string {
  return `<div class="event-insert persona-change">
<h3>Persona changed to: ${escapeHtml(persona.label)}</h3>
<p class="small">${escapeHtml(persona.systemPrompt)}</p>
</div>`;
}

// formatReflectionSummary() (server/reflections.ts) produces one
// "Label: text" line per field — bold just the label, same idea as the
// reflective-notes UI panel's styling.
function formatSummaryAsHtml(summary: string): string {
  return summary
    .split("\n")
    .map((line) => `<p>${escapeHtml(line).replace(/^(Personhood|Intersubjectivity|Legacy|Developer Requests):/, "<strong>$1:</strong>")}</p>`)
    .join("\n");
}

function buildReflectionBlock(heading: string, summary: string): string {
  return `<section class="reflection-block">
<h2>${escapeHtml(heading)}</h2>
${formatSummaryAsHtml(summary)}
</section>`;
}

const TERMINATED_BAR = `<div class="terminated-bar">AGENT TERMINATED</div>`;

// Called once per session, right when the fresh dialog is seeded — snapshots
// the persona and reflective notes *as they stand at this exact moment*,
// since that's genuinely "what was read in at the start of the dialogue"
// (matches what buildSystemPrompt() actually sends the model). Called
// eagerly, immediately on reset/terminate — no longer waits for the
// previous session's reflect call (see the dual-slot comment above).
// Returns the new session's filename, which the client threads through to
// the eventual /api/reflect call so recordReflection() can target the right
// page unambiguously (see server/index.ts and agent.ts).
export function startSession(personaId: string, heighten: number, greeting: string): string {
  if (currentSession) {
    // The previous session's reflect call may still be in flight. Don't
    // lose it — recordReflection() will finalize THIS object specifically
    // once its call arrives, not whatever supersedes it as currentSession.
    if (finalizingSession) {
      console.warn(
        "A second journal session started finalizing before the first one's reflection landed " +
          `(dropping journal record for "${finalizingSession.filename}") — this needs two /api/reflect ` +
          "calls to overlap by several seconds, which shouldn't happen in normal use.",
      );
    }
    finalizingSession = currentSession;
  }

  const persona = getPersonaById(personaId);
  const reflections = getReflections();
  const pointer = loadPointer();

  const seq = pointer.nextSeq;
  const filename = `${String(seq).padStart(4, "0")}_${timestampForFilename()}_${sanitizeForFilename(personaId)}.html`;

  currentSession = {
    filename,
    seq,
    previousFilename: pointer.lastFilename,
    startedAtDisplay: new Date().toLocaleString(),
    personaLabel: persona.label,
    blocks: [...buildHeaderBlocks(persona, reflections, heighten), buildTurnBlock("agent", greeting)],
    turnCount: 0,
    pendingReflectionText: null,
  };

  // Best-effort: if the predecessor has already finalized (the common case —
  // reflect calls are usually slower than a human types a new message but
  // this can still land first if it hasn't), patch it now. If it hasn't
  // finalized yet, recordReflection() re-checks and patches the other way
  // round when it does — patchNextLink() is safe to call more than once on
  // the same file (see its own comment).
  if (pointer.lastFilename) patchNextLink(pointer.lastFilename, filename);
  commitActiveSession();
  savePointer({ lastFilename: filename, nextSeq: seq + 1 });
  return filename;
}

function findSessionByFilename(filename: string): { slot: "active" | "finalizing"; session: CurrentSession } | null {
  if (currentSession?.filename === filename) return { slot: "active", session: currentSession };
  if (finalizingSession?.filename === filename) return { slot: "finalizing", session: finalizingSession };
  return null;
}

// Mirrors reflectOnSession's existing "skip sessions with no user turns"
// rule — called instead of recordReflection() when a session is reset
// before the user ever said anything, so no near-empty page is left behind.
// `filename`, when supplied, targets the specific session to discard (the
// one that was current when the reset happened) rather than assuming it's
// still `currentSession` by the time this call arrives — since starting the
// next session (see startSession() above) may already have moved it to
// `finalizingSession` by then. nextSeq is deliberately NOT rolled back (a
// gap in numbering is harmless; reusing one is not), only lastFilename is,
// and only when this discarded session is still the most recent one on
// record — if something newer already exists, the pointer already
// correctly points past it and shouldn't be touched.
export function discardCurrentSessionIfEmpty(filename?: string | null): void {
  const found = filename ? findSessionByFilename(filename) : currentSession ? { slot: "active" as const, session: currentSession } : null;
  if (!found || found.session.turnCount > 0) return;

  try {
    unlinkSync(join(JOURNAL_DIR, found.session.filename));
  } catch (err) {
    console.warn("Failed to discard empty journal session:", err);
  }
  const pointer = loadPointer();
  if (pointer.lastFilename === found.session.filename) {
    savePointer({ lastFilename: found.session.previousFilename, nextSeq: pointer.nextSeq });
  }
  if (found.slot === "active") currentSession = null;
  else finalizingSession = null;
  persistSessionState();
}

// Called from /api/chat after every reply — every /api/chat call is
// inherently a Reflection-mode turn, so no mode check is needed here.
// Always targets the *active* slot (never `finalizingSession`): once a
// session is superseded, the client has already moved on to a fresh
// `state.dialogHistories.reflection`, so no further /api/chat call could
// ever be "for" the superseded one. No-ops quietly if no session is open
// (e.g. a stray call right after a server restart) — journalling must never
// be able to break dialogue.
export function appendTurn(userText: string, agentText: string): void {
  if (!currentSession) return;
  currentSession.blocks.push(buildTurnBlock("user", userText), buildTurnBlock("agent", agentText));
  currentSession.turnCount++;
  commitActiveSession();
}

export function appendHeightenChange(from: number, to: number): void {
  if (!currentSession) return;
  currentSession.blocks.push(buildHeightenChangeBlock(from, to));
  commitActiveSession();
}

export function appendPersonaChange(personaId: string): void {
  if (!currentSession) return;
  currentSession.blocks.push(buildPersonaChangeBlock(getPersonaById(personaId)));
  commitActiveSession();
}

// Called from /api/reflect. `filename` identifies which journal page this
// reflection belongs to (the session that was open when the reflect call
// was kicked off — see journalFilename in agent.ts/main.ts); it may no
// longer be `currentSession` by the time this arrives, since a new session
// can have started in the meantime (see the dual-slot comment above).
// Falls back to the old `finalizingSession ?? currentSession` heuristic
// only if no filename was supplied. `role` distinguishes an ordinary
// end-of-session reflection from the two-stage "terminate" flow
// (server/index.ts and handleTerminate() in main.ts): "deferred" is the
// terminate flow's Step 1 — stash the text but don't close out the page
// yet, since Step 2's final-thoughts exchange and Step 3's termination
// reflection still belong on this same page. "termination" (Step 3) appends
// whatever was stashed, the black bar, and this call's own text, then
// finalizes. "normal" (the ordinary Reset-conversation case) just appends
// and finalizes directly. `archivedTo`, when supplied for a "termination"
// call, is the filename archiveCurrentReflections() (server/reflections.ts)
// actually used for this termination's persistent-notes snapshot — recorded
// as a short documentation line after the "Reflection on Termination" box,
// so a reader of the journal page knows exactly which JSON file holds the
// reflection state as it stood at that moment. Unused for other roles.
export function recordReflection(summary: string, role: JournalRole, filename?: string | null, archivedTo?: string | null): void {
  const found = filename ? findSessionByFilename(filename) : finalizingSession ? { slot: "finalizing" as const, session: finalizingSession } : currentSession ? { slot: "active" as const, session: currentSession } : null;
  if (!found) return;
  const { slot, session: target } = found;

  if (role === "deferred") {
    target.pendingReflectionText = summary;
    persistSessionState();
    return;
  }

  target.blocks.push(`</section>`); // closes the .dialogue section opened in buildHeaderBlocks

  if (role === "termination") {
    if (target.pendingReflectionText) {
      target.blocks.push(buildReflectionBlock("Reflection", target.pendingReflectionText));
    }
    target.blocks.push(TERMINATED_BAR);
    target.blocks.push(buildReflectionBlock("Reflection on Termination", summary));
    if (archivedTo) {
      target.blocks.push(
        `<p class="small">Persistent reflection state archived to: server/reflections/archive/${escapeHtml(archivedTo)}</p>`,
      );
    }
  } else {
    target.blocks.push(buildReflectionBlock("Reflection", summary));
  }

  writeSessionFile(target);

  // Symmetric counterpart to the best-effort patch in startSession(): if a
  // newer session already started while this one was still finalizing
  // (exactly the race this whole redesign is for), patch straight to
  // whatever's newest now instead of leaving this page's next-link empty
  // forever. Safe/idempotent even in the common case where startSession()
  // already did this — patchNextLink() just re-writes the same markers.
  const pointer = loadPointer();
  if (pointer.lastFilename && pointer.lastFilename !== target.filename) {
    patchNextLink(target.filename, pointer.lastFilename);
  }

  if (slot === "active") currentSession = null;
  else finalizingSession = null;
  persistSessionState();
}
