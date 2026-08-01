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

// Ekman term + canonical short definition, shown on hover over each bar
// (including its emoji) via a small custom tooltip below — not the native
// `title` attribute, because browsers hardcode that tooltip's dwell time
// (~1s in Chrome) with no way to shorten it from HTML/CSS/JS. The widget
// itself is deliberately unlabeled beyond the emoji, so this is where the
// actual term is available on demand.
const DEFINITION: Record<EmotionName, string> = {
  joy: "Joy — a feeling of great pleasure and happiness.",
  sadness: "Sadness — emotional pain associated with loss, disappointment, or grief.",
  anger: "Anger — a strong feeling of displeasure or hostility in response to a perceived wrong.",
  fear: "Fear — an unpleasant emotion caused by the threat of danger, pain, or harm.",
  surprise: "Surprise — a brief mental and physiological state in reaction to an unexpected event.",
  disgust: "Disgust — a feeling of revulsion or strong disapproval toward something offensive.",
};

export interface EmotionWidgetOptions {
  onToggleCollapsed: (collapsed: boolean) => void;
}

// Much snappier than a native title tooltip's browser-default delay.
const TOOLTIP_SHOW_DELAY_MS = 150;

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
  private readonly tooltip: HTMLDivElement;
  private tooltipTimer: number | null = null;

  constructor(options: EmotionWidgetOptions) {
    this.root = document.createElement("div");
    this.root.className = "emotion-widget";

    // Appended to <body>, not this.root, so `position: fixed` coordinates
    // (computed from the hovered bar's own bounding rect) aren't affected by
    // any ancestor's positioning/overflow/transform.
    this.tooltip = document.createElement("div");
    this.tooltip.className = "emotion-tooltip hidden";
    document.body.appendChild(this.tooltip);

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
      bar.setAttribute("aria-label", DEFINITION[name]);
      bar.addEventListener("mouseenter", () => this.scheduleTooltip(bar, DEFINITION[name]));
      bar.addEventListener("mouseleave", () => this.hideTooltip());

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

  // Positioned above the target, centered on it — deliberately simple/
  // unclamped, since the widget is always anchored well below the app's
  // header, so there's always room above a bar for the tooltip to appear.
  private scheduleTooltip(target: HTMLElement, text: string): void {
    this.hideTooltip();
    this.tooltipTimer = window.setTimeout(() => {
      this.tooltip.textContent = text;
      const rect = target.getBoundingClientRect();
      this.tooltip.style.left = `${rect.left + rect.width / 2}px`;
      this.tooltip.style.top = `${rect.top - 8}px`;
      this.tooltip.classList.remove("hidden");
    }, TOOLTIP_SHOW_DELAY_MS);
  }

  private hideTooltip(): void {
    if (this.tooltipTimer !== null) {
      window.clearTimeout(this.tooltipTimer);
      this.tooltipTimer = null;
    }
    this.tooltip.classList.add("hidden");
  }

  setCollapsed(collapsed: boolean): void {
    this.panel.classList.toggle("hidden", collapsed);
    this.reopenBtn.classList.toggle("hidden", !collapsed);
    if (collapsed) this.hideTooltip(); // don't leave a tooltip stranded over a hidden bar
  }

  setWeights(weights: EmotionWeights): void {
    for (const name of EMOTION_NAMES) {
      const clamped = Math.max(0, Math.min(1, weights[name]));
      this.fills[name].style.height = `${clamped * 100}%`;
    }
  }
}
