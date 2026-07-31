import { EMOTION_NAMES, type EmotionName } from "./poses";
import type { EmotionWeights } from "./blend";

// Emoji used to label each bar on the widget's "x axis" — no numeric scale,
// axis line, or text label, just the six Ekman emotions in the same fixed
// order used everywhere else in the app (see EMOTION_NAMES).
const EMOJI: Record<EmotionName, string> = {
  joy: "😄",
  sadness: "😢",
  anger: "😠",
  fear: "😨",
  surprise: "😲",
  disgust: "🤢",
};

export interface EmotionWidgetOptions {
  onToggleCollapsed: (collapsed: boolean) => void;
}

// A compact, deliberately non-intrusive readout of the six emotion weights
// currently driving the character — the blended pose on the cartoon figure
// itself can be hard to judge precisely, so this gives an exact-ish visual
// alongside it. Six small bars, each labeled by an emoji instead of an axis
// line or numbers, growing upward from a shared baseline. Collapses to a
// small reopen tab via the ✕ in its own upper-right corner.
export class EmotionWidget {
  readonly root: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly reopenBtn: HTMLButtonElement;
  private readonly fills: Record<EmotionName, HTMLDivElement>;

  constructor(options: EmotionWidgetOptions) {
    this.root = document.createElement("div");
    this.root.className = "emotion-widget";

    this.panel = document.createElement("div");
    this.panel.className = "emotion-widget-panel";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "emotion-widget-close";
    closeBtn.textContent = "✕";
    closeBtn.title = "Minimize";
    closeBtn.setAttribute("aria-label", "Minimize emotion widget");
    closeBtn.addEventListener("click", () => {
      this.setCollapsed(true);
      options.onToggleCollapsed(true);
    });

    const bars = document.createElement("div");
    bars.className = "emotion-widget-bars";

    this.fills = {} as Record<EmotionName, HTMLDivElement>;
    for (const name of EMOTION_NAMES) {
      const bar = document.createElement("div");
      bar.className = "emotion-bar";

      const track = document.createElement("div");
      track.className = "emotion-bar-track";

      const fill = document.createElement("div");
      fill.className = "emotion-bar-fill";
      track.appendChild(fill);
      this.fills[name] = fill;

      const emoji = document.createElement("span");
      emoji.className = "emotion-bar-emoji";
      emoji.textContent = EMOJI[name];
      emoji.setAttribute("aria-hidden", "true");

      bar.append(track, emoji);
      bars.appendChild(bar);
    }

    this.panel.append(closeBtn, bars);

    this.reopenBtn = document.createElement("button");
    this.reopenBtn.type = "button";
    this.reopenBtn.className = "emotion-widget-reopen";
    this.reopenBtn.textContent = "🙂";
    this.reopenBtn.title = "Show emotion levels";
    this.reopenBtn.setAttribute("aria-label", "Show emotion widget");
    this.reopenBtn.addEventListener("click", () => {
      this.setCollapsed(false);
      options.onToggleCollapsed(false);
    });

    this.root.append(this.panel, this.reopenBtn);
  }

  setCollapsed(collapsed: boolean): void {
    this.panel.classList.toggle("hidden", collapsed);
    this.reopenBtn.classList.toggle("hidden", !collapsed);
  }

  setWeights(weights: EmotionWeights): void {
    for (const name of EMOTION_NAMES) {
      const clamped = Math.max(0, Math.min(1, weights[name]));
      this.fills[name].style.height = `${clamped * 100}%`;
    }
  }
}
