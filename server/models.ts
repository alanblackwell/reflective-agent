// Which Claude model powers both /api/chat and /api/reflect. Kept as an
// explicit list (rather than a single hardcoded string) so switching models
// for a cost/quality experiment is a one-line change, with the alternatives
// left in place for reference. Pricing/quality rationale reflects Anthropic's
// published tiers at the time this was written — recheck before trusting it
// long after the fact.
export interface ModelOption {
  id: string;
  rationale: string;
  // Published per-million-token rates, for server/usage.ts's cost estimate —
  // display only, not what actually gets billed (e.g. doesn't model Sonnet's
  // introductory discount). Recheck against current pricing if it matters.
  inputCostPerMTok: number;
  outputCostPerMTok: number;
}

export const MODEL_OPTIONS: ModelOption[] = [
  { id: "claude-haiku-4-5", rationale: "cheapest", inputCostPerMTok: 1, outputCostPerMTok: 5 },
  { id: "claude-sonnet-5", rationale: "balanced", inputCostPerMTok: 3, outputCostPerMTok: 15 },
  { id: "claude-opus-4-8", rationale: "highest quality", inputCostPerMTok: 5, outputCostPerMTok: 25 },
];

// Cost-experiment default: cheapest option, to see how well a smaller model
// holds up for this app's conversational + reflective workload. Swap the
// index (or point at a different entry above) to try another option — see
// CLAUDE.md's "Key decisions" for why this is the active choice.
export const ACTIVE_MODEL: ModelOption = MODEL_OPTIONS[0];
