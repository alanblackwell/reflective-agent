import { blendPoses, zeroWeights, type EmotionWeights } from "./blend";
import { NEUTRAL, type FacePose } from "./poses";

const SVG_NS = "http://www.w3.org/2000/svg";

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

// How quickly the rendered pose eases toward the target blended pose each
// frame (0..1, higher = snappier). Gives the "smooth transition" behaviour
// requested for emotion changes instead of instant jumps.
const EASE = 0.08;

// How quickly a speech mouth-pulse decays back toward zero, per frame.
const SPEECH_DECAY = 0.82;

export class Character {
  private weights: EmotionWeights = zeroWeights();
  private current: FacePose = { ...NEUTRAL };
  private speechIntensity = 0;
  private rafId: number | null = null;

  private group: SVGGElement;
  private browL: SVGLineElement;
  private browR: SVGLineElement;
  private eyeL: SVGEllipseElement;
  private eyeR: SVGEllipseElement;
  private mouth: SVGPathElement;
  private bodyGroup: SVGGElement;

  readonly svg: SVGSVGElement;

  constructor() {
    this.svg = el("svg", {
      viewBox: "0 0 200 240",
      xmlns: SVG_NS,
    });

    this.group = el("g");
    this.bodyGroup = el("g");

    // Body / shirt (classic Peanuts zigzag stripe on a round-collared shirt)
    const shirt = el("path", {
      d: "M 38 168 Q 30 205 32 234 L 168 234 Q 170 205 162 168 Q 131 190 100 168 Q 69 190 38 168 Z",
      fill: "#ffffff",
      stroke: "#1a1a1a",
      "stroke-width": 3,
      "stroke-linejoin": "round",
    });
    const zigzag = el("polyline", {
      points: "45,196 60,208 75,196 90,208 105,196 120,208 135,196 150,208 155,196",
      fill: "none",
      stroke: "#1a1a1a",
      "stroke-width": 3,
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
    });
    this.bodyGroup.append(shirt, zigzag);

    // Head
    const head = el("circle", {
      cx: 100,
      cy: 100,
      r: 66,
      fill: "#ffffff",
      stroke: "#1a1a1a",
      "stroke-width": 3,
    });

    // Signature single curl
    const curl = el("path", {
      d: "M 108 38 C 116 24, 134 24, 126 42",
      fill: "none",
      stroke: "#1a1a1a",
      "stroke-width": 3,
      "stroke-linecap": "round",
    });

    this.browL = el("line", {
      x1: 65,
      x2: 91,
      y1: 78,
      y2: 78,
      stroke: "#1a1a1a",
      "stroke-width": 3,
      "stroke-linecap": "round",
    });
    this.browR = el("line", {
      x1: 109,
      x2: 135,
      y1: 78,
      y2: 78,
      stroke: "#1a1a1a",
      "stroke-width": 3,
      "stroke-linecap": "round",
    });

    this.eyeL = el("ellipse", { cx: 78, cy: 96, rx: 5, ry: 6, fill: "#1a1a1a" });
    this.eyeR = el("ellipse", { cx: 122, cy: 96, rx: 5, ry: 6, fill: "#1a1a1a" });

    this.mouth = el("path", {
      fill: "#1a1a1a",
      stroke: "#1a1a1a",
      "stroke-width": 1,
      "stroke-linejoin": "round",
    });

    this.group.append(head, curl, this.browL, this.browR, this.eyeL, this.eyeR, this.mouth);
    this.svg.append(this.bodyGroup, this.group);

    this.applyPose(this.current);
    this.loop = this.loop.bind(this);
    this.rafId = requestAnimationFrame(this.loop);
  }

  setEmotionWeights(weights: EmotionWeights): void {
    this.weights = { ...weights };
  }

  // Nudges the mouth open for one speech "beat"; decays automatically.
  pulseMouth(intensity: number): void {
    this.speechIntensity = Math.max(this.speechIntensity, intensity);
  }

  destroy(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
  }

  private loop(): void {
    const target = blendPoses(this.weights);
    for (const key of Object.keys(this.current) as (keyof FacePose)[]) {
      this.current[key] += (target[key] - this.current[key]) * EASE;
    }
    this.speechIntensity *= SPEECH_DECAY;
    if (this.speechIntensity < 0.01) this.speechIntensity = 0;

    this.applyPose(this.current);
    this.rafId = requestAnimationFrame(this.loop);
  }

  private applyPose(pose: FacePose): void {
    const browLY = 78 + pose.browY;
    const browRY = 78 + pose.browY;
    this.browL.setAttribute("y1", String(browLY));
    this.browL.setAttribute("y2", String(browLY));
    this.browL.setAttribute("transform", `rotate(${-pose.browAngle} 78 ${browLY})`);

    this.browR.setAttribute("y1", String(browRY));
    this.browR.setAttribute("y2", String(browRY));
    this.browR.setAttribute("transform", `rotate(${pose.browAngle} 122 ${browRY})`);

    const eyeRy = Math.max(1, 6 * pose.eyeOpen);
    this.eyeL.setAttribute("ry", String(eyeRy));
    this.eyeR.setAttribute("ry", String(eyeRy));

    this.mouth.setAttribute("d", this.mouthPath(pose));

    const lean = pose.bodyLean;
    const posture = pose.posture;
    this.group.setAttribute("transform", `rotate(${lean} 100 160)`);
    this.bodyGroup.setAttribute(
      "transform",
      `translate(0 ${(1 - posture) * 40}) scale(1 ${posture})`,
    );
  }

  private mouthPath(pose: FacePose): string {
    const cx = 100;
    const cy = 136;
    const halfWidth = 20 * pose.mouthWidth;
    const curveAmount = pose.mouthCurve * 12;
    const openAmount = Math.min(1.4, pose.mouthOpen + this.speechIntensity) * 16;
    const asymL = -pose.mouthAsymmetry * 6;
    const asymR = pose.mouthAsymmetry * 6;

    const leftX = cx - halfWidth;
    const rightX = cx + halfWidth;
    const leftY = cy + asymL;
    const rightY = cy + asymR;
    const controlTopY = cy + curveAmount - openAmount / 2;
    const controlBottomY = cy + curveAmount + openAmount / 2;

    return `M ${leftX} ${leftY} Q ${cx} ${controlTopY} ${rightX} ${rightY} Q ${cx} ${controlBottomY} ${leftX} ${leftY} Z`;
  }
}
