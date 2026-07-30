export interface TtsHandlers {
  onMouthPulse: (intensity: number) => void;
  onStart?: () => void;
  onEnd?: () => void;
}

// Wraps the browser's built-in SpeechSynthesis API (free, no server/API key
// needed). It does not expose phoneme-level timing, so mouth movement is a
// heuristic: a steady pulse while speech is active, boosted on each word
// boundary where the browser supports that event. This is rhythmically
// plausible lip-sync, not phonetically accurate viseme mapping.
export class TtsController {
  private speaking = false;
  private fallbackTimer: number | null = null;
  private voice: SpeechSynthesisVoice | null = null;
  private pitch = 1;
  private rate = 1;

  constructor(private handlers: TtsHandlers) {}

  isSupported(): boolean {
    return "speechSynthesis" in window;
  }

  // Voices load asynchronously in most browsers; call this once up front
  // and again whenever the "voiceschanged" event fires.
  getVoices(): SpeechSynthesisVoice[] {
    return this.isSupported() ? window.speechSynthesis.getVoices() : [];
  }

  onVoicesChanged(callback: () => void): void {
    if (this.isSupported()) {
      window.speechSynthesis.addEventListener("voiceschanged", callback);
    }
  }

  setVoice(voice: SpeechSynthesisVoice | null): void {
    this.voice = voice;
  }

  setPitch(pitch: number): void {
    this.pitch = pitch;
  }

  setRate(rate: number): void {
    this.rate = rate;
  }

  speak(text: string): void {
    if (!this.isSupported()) {
      console.warn("SpeechSynthesis is not supported in this browser.");
      return;
    }
    const trimmed = text.trim();
    if (!trimmed) return;

    this.stop();

    const utterance = new SpeechSynthesisUtterance(trimmed);
    utterance.pitch = this.pitch;
    utterance.rate = this.rate;
    if (this.voice) utterance.voice = this.voice;
    utterance.onstart = () => {
      this.speaking = true;
      this.handlers.onStart?.();
      this.startFallbackPulse();
    };
    utterance.onend = () => this.handleEnd();
    utterance.onerror = () => this.handleEnd();
    utterance.onboundary = (event) => {
      if (event.name === "word" || event.name === undefined) {
        this.handlers.onMouthPulse(0.7 + Math.random() * 0.3);
      }
    };

    window.speechSynthesis.speak(utterance);
  }

  stop(): void {
    if (this.isSupported() && (window.speechSynthesis.speaking || window.speechSynthesis.pending)) {
      window.speechSynthesis.cancel();
    }
    this.handleEnd();
  }

  private handleEnd(): void {
    const wasSpeaking = this.speaking;
    this.speaking = false;
    this.stopFallbackPulse();
    if (wasSpeaking) this.handlers.onEnd?.();
  }

  private startFallbackPulse(): void {
    this.stopFallbackPulse();
    this.fallbackTimer = window.setInterval(() => {
      if (!this.speaking) return;
      this.handlers.onMouthPulse(0.35 + Math.random() * 0.35);
    }, 130);
  }

  private stopFallbackPulse(): void {
    if (this.fallbackTimer !== null) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }
}
