import ElizaBot from "elizabot";

// Thin wrapper around the classic masswerk.at ELIZA/DOCTOR port (N. Landsteiner,
// 2005), the well-known faithful JS reimplementation of Weizenbaum's original
// 1966 algorithm. Stands in for real agent logic during dialog-mode testing.
export class Eliza {
  private bot = new ElizaBot();

  // Surfaced as the agent's own opening line so the OSS-licensing ambiguity
  // of this dependency (see project notes) is visible in the UI, not just
  // buried in source comments.
  introNotice(): string {
    return "Before we start — I'm running on a classic ELIZA script (Norbert Landsteiner's 2005 JS port of Weizenbaum's 1966 DOCTOR program). It's the well-known original, but it doesn't carry a clear open-source license, so treat me as a placeholder for real agent logic, not a permanent dependency.";
  }

  greeting(): string {
    return this.bot.getInitial();
  }

  respond(input: string): string {
    return this.bot.transform(input) || this.bot.getFinal();
  }

  reset(): void {
    this.bot.reset();
  }
}
