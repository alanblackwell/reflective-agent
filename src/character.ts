import { blendPoses, zeroWeights, type EmotionWeights } from "./blend";
import { NEUTRAL, type FacePose } from "./poses";
import charlieSvgSource from "../assets/charlie-brown.svg?raw";

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

// Geometry measured directly from assets/charlie-brown.svg (a 210x297
// viewBox). The source art's eyes/mouth are otherwise-static shapes; these
// are the anchor points animation is built around. The brows' x1/x2 are
// authored directly on the <line> elements and never change — only y and
// rotation do.
const EYE_L_CENTER = { x: 89.6, y: 81.9 };
const EYE_R_CENTER = { x: 124.6, y: 81.9 };
const BROW_BASE_Y = 67;
const BROW_L_PIVOT_X = 90;
const BROW_R_PIVOT_X = 122;
const MOUTH_CX = 109;
const MOUTH_CY = 129;
// Floor on the mouth's rendered thickness so its resting (closed) stroke
// reads at the same visual weight as the brows/outline (~5 units) instead of
// collapsing to a hairline — animation adds on top of this floor, it doesn't
// replace it.
const MOUTH_MIN_THICKNESS = 5;
// Pivot for whole-figure lean/posture, roughly at the neck/collar.
const FIGURE_PIVOT = { x: 106, y: 160 };

export class Character {
  private weights: EmotionWeights = zeroWeights();
  private current: FacePose = { ...NEUTRAL };
  private speechIntensity = 0;
  private rafId: number | null = null;

  // The source SVG is one hand-traced silhouette path plus a handful of
  // separately-extracted features (see charlie-brown.svg's header comment).
  // There's no clean way to split "just the head" from "just the body" out
  // of that single path, so lean/posture transform the whole figure as one
  // group rather than head-only/body-only the way the old procedural
  // drawing did.
  private figureGroup: SVGGElement;
  private browL: SVGLineElement;
  private browR: SVGLineElement;
  private eyeL: SVGGraphicsElement;
  private eyeR: SVGGraphicsElement;
  private mouth: SVGPathElement;

  readonly svg: SVGSVGElement;

  constructor() {
    const parsed = new DOMParser().parseFromString(charlieSvgSource, "image/svg+xml");
    this.svg = document.importNode(parsed.documentElement, true) as unknown as SVGSVGElement;

    this.figureGroup = this.svg.getElementById("layer1") as unknown as SVGGElement;
    this.browL = this.svg.getElementById("brow-l") as unknown as SVGLineElement;
    this.browR = this.svg.getElementById("brow-r") as unknown as SVGLineElement;
    this.eyeL = this.svg.getElementById("eye-l") as unknown as SVGGraphicsElement;
    this.eyeR = this.svg.getElementById("eye-r") as unknown as SVGGraphicsElement;

    // The static mouth shape in the source art is a fixed neutral smile —
    // swap it for a dynamically-redrawn path so it can flex for
    // emotion (curve/width/asymmetry) and speech (mouthOpen + pulses),
    // the same way the original procedural mouth worked.
    const staticMouth = this.svg.getElementById("mouth") as unknown as SVGPathElement;
    this.mouth = el("path", { fill: "#000000" });
    staticMouth.replaceWith(this.mouth);

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
    const browY = BROW_BASE_Y + pose.browY;
    this.browL.setAttribute("y1", String(browY));
    this.browL.setAttribute("y2", String(browY));
    this.browL.setAttribute("transform", `rotate(${pose.browAngle} ${BROW_L_PIVOT_X} ${browY})`);

    this.browR.setAttribute("y1", String(browY));
    this.browR.setAttribute("y2", String(browY));
    this.browR.setAttribute("transform", `rotate(${-pose.browAngle} ${BROW_R_PIVOT_X} ${browY})`);

    const eyeScale = Math.max(0.05, pose.eyeOpen);
    this.eyeL.setAttribute("transform", eyeScaleTransform(EYE_L_CENTER, eyeScale));
    this.eyeR.setAttribute("transform", eyeScaleTransform(EYE_R_CENTER, eyeScale));

    this.mouth.setAttribute("d", this.mouthPath(pose));

    const lean = pose.bodyLean;
    const posture = pose.posture;
    this.figureGroup.setAttribute(
      "transform",
      `rotate(${lean} ${FIGURE_PIVOT.x} ${FIGURE_PIVOT.y}) translate(0 ${(1 - posture) * 40}) scale(1 ${posture})`,
    );
  }

  private mouthPath(pose: FacePose): string {
    const halfWidth = 26 * pose.mouthWidth;
    const curveAmount = pose.mouthCurve * 12;
    const openAmount = MOUTH_MIN_THICKNESS + Math.min(1.4, pose.mouthOpen + this.speechIntensity) * 16;
    const asymL = -pose.mouthAsymmetry * 6;
    const asymR = pose.mouthAsymmetry * 6;

    const leftX = MOUTH_CX - halfWidth;
    const rightX = MOUTH_CX + halfWidth;
    const leftY = MOUTH_CY + asymL;
    const rightY = MOUTH_CY + asymR;
    const controlTopY = MOUTH_CY + curveAmount - openAmount / 2;
    const controlBottomY = MOUTH_CY + curveAmount + openAmount / 2;

    return `M ${leftX} ${leftY} Q ${MOUTH_CX} ${controlTopY} ${rightX} ${rightY} Q ${MOUTH_CX} ${controlBottomY} ${leftX} ${leftY} Z`;
  }
}

function eyeScaleTransform(center: { x: number; y: number }, scale: number): string {
  return `translate(${center.x} ${center.y}) scale(1 ${scale}) translate(${-center.x} ${-center.y})`;
}
