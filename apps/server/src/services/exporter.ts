import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { Overlay, Project, SourceSegment } from "@content-tools/shared";
import { DEFAULT_PRESET_ID, EXPORT_PRESETS, getOverlayAssetHash } from "@content-tools/shared";
import { FFMPEG_PATH, REPO_ROOT, WORKSPACE_ROOT } from "../config.js";
import { ensureDir, fileExists } from "../utils/fs.js";
import { renderProjectAssets } from "./renderer.js";
import { probeVideo } from "./ffprobe.js";
import { getTemplateById } from "./templates.js";
import {
  assertRenderPresetAvailable,
  RenderPresetUnavailableError,
} from "./render-capabilities.js";

type RenderMode = "final" | "rough";

const STATIC_OVERLAY_INPUT_FPS = "1";

type ExportRequest = {
  presetId?: string;
  includeAudio?: boolean;
  includeSlug?: boolean;
  includeSlugStart?: boolean;
  includeSlugEnd?: boolean;
  speed?: 1 | 2;
  renderMode?: RenderMode;
};

export type RenderProgress = {
  stage: string;
  message?: string;
  percent?: number;
};

type ExportManifest = {
  projectId: string;
  createdAt: string;
  exportId: string;
  presetId: string;
  speed: 1 | 2;
  includeAudio: boolean;
  includeSlugStart: boolean;
  includeSlugEnd: boolean;
  source: string;
  timelineSource?: string;
  timelineAssetInputs?: string[];
  timelineInputs: string[];
  overlayInputs: string[];
  arrowInputs: string[];
  filterCards: string;
  filterCardsArrows: string;
  outputLabelCards: string;
  outputLabelCardsArrows: string;
  outputLabelCardsAudio?: string;
  outputLabelCardsArrowsAudio?: string;
  renderMode?: RenderMode;
  outputFps?: number;
  outputWidth?: number;
  outputHeight?: number;
  sourceSegmentOutputFrames?: number;
  sourceSegmentOutputDurationSec?: number;
  tailSlugStartSec?: number;
  assembledDurationSec?: number;
  externalAudioInput?: string;
  externalAudioFadeOutStartSec?: number;
  externalAudioFadeOutEndSec?: number;
  audioTrack?: Project["audioTrack"];
  mainOutput?: string;
  fingerprints?: ExportFingerprints;
  overlaySnapshots?: OverlayRenderSnapshot[];
  patch?: {
    baseExportId: string;
    changedOverlayIds: string[];
    affectedWindows: PatchWindow[];
  };
};

type ExportFingerprints = {
  source: string;
  timeline: string;
  render: string;
  slug: string;
  audio: string;
};

type OverlayRenderSnapshot = {
  id: string;
  kind: OverlayKind;
  visualHash: string;
  structuralHash: string;
  startSec: number;
  endSec: number;
};

export type PatchWindow = {
  startSec: number;
  endSec: number;
};

export type SurgicalPatchStatus = {
  patchable: boolean;
  reason?: string;
  latestExportId?: string;
  changedOverlayIds: string[];
  affectedWindows: PatchWindow[];
  estimatedPatchSec?: number;
};

type LatestExport = {
  exportId: string;
  exportDir: string;
  finalPath: string;
  manifest: ExportManifest;
};

type PatchAnalysis = SurgicalPatchStatus & {
  latest?: LatestExport;
  projectForRender?: Project;
  renderTuning?: RenderTuning;
  outputFrames?: number;
  speed?: 1 | 2;
  fingerprints?: ExportFingerprints;
  overlaySnapshots?: OverlayRenderSnapshot[];
};

type FilterResult = {
  script: string;
  outputLabel: string;
  audioLabel?: string;
};

type AudioPlan = {
  label: string;
  lines: string[];
};

type ExternalAudioContext = {
  tailSlugStartSec?: number;
};

type ExternalAudioFadePlan = {
  target: "tailSlug" | "end";
  startSec: number;
  endSec: number;
  durationSec: number;
};

type ExternalAudioApplyResult = {
  durationSec: number;
  fadeOut?: ExternalAudioFadePlan;
};

type OverlayTiming = {
  startSec: number;
  visStartSec: number;
  visEndSec: number;
  slideInSec: number;
  slideOutSec: number;
  holdSec: number;
  secondsPerFrame: number;
};

type OverlayKind = "card" | "arrow";

type OverlayInput = {
  overlay: Overlay;
  kind: OverlayKind;
  filePath: string;
};

type TimelineTransition = {
  type: "cut" | "crossfade";
  durationFrames: number;
};

type TimelineSegment = {
  kind: "source" | "image";
  startFrame: number;
  endFrame: number;
  durationFrames: number;
  outputStartFrame: number;
  playbackRate: number;
  audio: "preserve" | "mute";
  assetPath?: string;
  imageInputIndex?: number;
};

const DEFAULT_VIDEO_WIDTH = 1920;
const DEFAULT_VIDEO_HEIGHT = 1080;
const DEFAULT_CROSSFADE_FRAMES = 12;
const ROUGH_PREVIEW_MAX_WIDTH = 960;
const ROUGH_PREVIEW_MAX_HEIGHT = 540;
const ROUGH_PREVIEW_FPS = 15;
const ROUGH_PREVIEW_PRESET_ID = "roughPreview";

type RenderTuning = {
  mode: RenderMode;
  presetId: string;
  outputFps?: number;
  outputWidth?: number;
  outputHeight?: number;
  scaleX?: number;
  scaleY?: number;
};

function clampEven(value: number): number {
  if (!Number.isFinite(value)) return 2;
  const rounded = Math.round(value);
  const even = rounded % 2 === 0 ? rounded : rounded - 1;
  return Math.max(2, even);
}

function resolveRenderTuning(project: Project, options: ExportRequest): RenderTuning {
  const mode: RenderMode = options.renderMode === "rough" ? "rough" : "final";
  const presetId =
    mode === "rough"
      ? ROUGH_PREVIEW_PRESET_ID
      : options.presetId ?? project.lastExportPresetId ?? DEFAULT_PRESET_ID;

  if (mode !== "rough") {
    return { mode, presetId };
  }

  const width = project.video.width || DEFAULT_VIDEO_WIDTH;
  const height = project.video.height || DEFAULT_VIDEO_HEIGHT;
  const widthScale = ROUGH_PREVIEW_MAX_WIDTH / width;
  const heightScale = ROUGH_PREVIEW_MAX_HEIGHT / height;
  const scale = Math.min(1, widthScale, heightScale);
  const outputWidth = clampEven(width * scale);
  const outputHeight = clampEven(height * scale);
  const scaleX = outputWidth / width;
  const scaleY = outputHeight / height;
  const sourceFps = project.video.fpsNum / project.video.fpsDen || ROUGH_PREVIEW_FPS;
  const outputFps = Math.max(1, Math.min(ROUGH_PREVIEW_FPS, Math.round(sourceFps)));

  return {
    mode,
    presetId,
    outputFps,
    outputWidth,
    outputHeight,
    scaleX,
    scaleY,
  };
}

function scaleProjectForRender(project: Project, tuning: RenderTuning): Project {
  if (!tuning.outputWidth || !tuning.outputHeight || !tuning.scaleX || !tuning.scaleY) {
    return project;
  }
  const scaleX = tuning.scaleX;
  const scaleY = tuning.scaleY;
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) {
    return project;
  }

  const overlays = project.overlays.map((overlay) => {
    const rect = overlay.rect;
    const motion = overlay.motion ? { ...overlay.motion } : undefined;
    if (motion?.bouncePx) {
      const bounceScale =
        motion.bounceAxis === "y"
          ? scaleY
          : motion.bounceAxis === "x"
            ? scaleX
            : (scaleX + scaleY) / 2;
      motion.bouncePx = motion.bouncePx * bounceScale;
    }
    return {
      ...overlay,
      rect: {
        x: rect.x * scaleX,
        y: rect.y * scaleY,
        w: rect.w * scaleX,
        h: rect.h * scaleY,
      },
      motion,
    };
  });

  return {
    ...project,
    video: { ...project.video, width: tuning.outputWidth, height: tuning.outputHeight },
    overlays,
  };
}

function sortOverlays(overlays: Overlay[]): Overlay[] {
  return [...overlays].sort((a, b) => {
    if (a.zIndex !== b.zIndex) return a.zIndex - b.zIndex;
    if (a.startFrame !== b.startFrame) return a.startFrame - b.startFrame;
    return a.id.localeCompare(b.id);
  });
}

function isArrowOverlay(overlay: Overlay): boolean {
  return overlay.templateId.startsWith("arrow");
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value
    .toFixed(6)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
}

function escapeFilterExpr(expr: string): string {
  return expr.replace(/,/g, "\\,");
}

function frameToSeconds(frame: number, fps: number, speed: number): number {
  return (frame / fps) * (1 / speed);
}

function computeOverlayTiming(
  overlay: Overlay,
  fps: number,
  speed: number
): OverlayTiming {
  const motion = overlay.motion ?? {};
  const startFrame = overlay.startFrame;
  const slideInFrames = motion.slideInFrames ?? 0;
  const slideOutFrames = motion.slideOutFrames ?? 0;
  const displayFrames = motion.displayFrames;

  let derivedEndFrame = overlay.endFrame;
  if (!isArrowOverlay(overlay) && typeof displayFrames === "number") {
    derivedEndFrame = startFrame + slideInFrames + displayFrames + slideOutFrames;
  }

  const visStartFrame = motion.visibleStartFrame ?? startFrame;
  const visEndFrame = motion.visibleEndFrame ?? derivedEndFrame;

  const totalFrames = Math.max(0, visEndFrame - startFrame);
  const holdFrames =
    typeof displayFrames === "number"
      ? displayFrames
      : Math.max(0, totalFrames - slideInFrames - slideOutFrames);

  const startSec = frameToSeconds(startFrame, fps, speed);
  const secondsPerFrame = 1 / fps / speed;
  const visStartSec = frameToSeconds(visStartFrame, fps, speed);
  const visEndSec = frameToSeconds(
    Math.max(visStartFrame, visEndFrame),
    fps,
    speed
  );

  return {
    startSec,
    visStartSec,
    visEndSec,
    slideInSec: frameToSeconds(slideInFrames, fps, speed),
    slideOutSec: frameToSeconds(slideOutFrames, fps, speed),
    holdSec: frameToSeconds(holdFrames, fps, speed),
    secondsPerFrame,
  };
}

function resolveTemplateAlign(overlay: Overlay): "left" | "center" | "right" | null {
  const template = getTemplateById(overlay.templateId);
  if (template) return template.align;
  if (overlay.templateId.includes("right")) return "right";
  if (overlay.templateId.includes("center")) return "center";
  if (overlay.templateId.includes("left")) return "left";
  return null;
}

function resolveSlideDirection(
  overlay: Overlay,
  videoWidth: number
): "fromLeft" | "fromRight" | "none" {
  const motion = overlay.motion;
  if (motion?.slideDirection === "none") return "none";

  const align = resolveTemplateAlign(overlay);
  if (align === "right") return "fromRight";
  if (align === "left" || align === "center") return "fromLeft";

  if (motion?.slideDirection) return motion.slideDirection;
  const centerX = overlay.rect.x + overlay.rect.w / 2;
  return centerX < videoWidth / 2 ? "fromLeft" : "fromRight";
}

function resolveBounceAxis(overlay: Overlay): "x" | "y" {
  const motion = overlay.motion;
  if (motion?.bounceAxis) return motion.bounceAxis;
  if (overlay.templateId.includes("left") || overlay.templateId.includes("right")) {
    return "x";
  }
  return "y";
}

function buildOverlayExpressions(
  overlay: Overlay,
  timing: OverlayTiming,
  videoWidth: number
): { xExpr: string; yExpr: string; enableExpr: string } {
  const motion = overlay.motion ?? {};
  const enableExpr = `between(t,${formatNumber(timing.visStartSec)},${formatNumber(
    timing.visEndSec
  )})`;

  const xFinal = overlay.rect.x;
  const yFinal = overlay.rect.y;

  if (isArrowOverlay(overlay)) {
    const bouncePx = motion.bouncePx ?? 0;
    const bouncePeriodFrames = motion.bouncePeriodFrames ?? 0;
    const bounceAxis = resolveBounceAxis(overlay);
    const bouncePeriodSec =
      bouncePx > 0 && bouncePeriodFrames > 0
        ? bouncePeriodFrames * timing.secondsPerFrame
        : 0;

    if (bouncePx > 0 && bouncePeriodFrames > 0 && bouncePeriodSec > 0) {
      const period = formatNumber(bouncePeriodSec);
      const t0 = formatNumber(timing.visStartSec);
      const bounceExpr = `${formatNumber(bouncePx)}*sin(2*PI*(t-${t0})/${period})`;
      if (bounceAxis === "x") {
        return {
          xExpr: `${formatNumber(xFinal)}+${bounceExpr}`,
          yExpr: formatNumber(yFinal),
          enableExpr,
        };
      }
      return {
        xExpr: formatNumber(xFinal),
        yExpr: `${formatNumber(yFinal)}+${bounceExpr}`,
        enableExpr,
      };
    }

    return {
      xExpr: formatNumber(xFinal),
      yExpr: formatNumber(yFinal),
      enableExpr,
    };
  }

  const slideDirection = resolveSlideDirection(overlay, videoWidth);
  const slideInSec = timing.slideInSec;
  const slideOutSec = timing.slideOutSec;
  const holdSec = timing.holdSec;

  if (slideDirection === "none" || (slideInSec === 0 && slideOutSec === 0)) {
    return {
      xExpr: formatNumber(xFinal),
      yExpr: formatNumber(yFinal),
      enableExpr,
    };
  }

  const xStart = slideDirection === "fromLeft" ? -overlay.rect.w : videoWidth;
  const xExit = xStart;
  const slideInEnd = timing.startSec + slideInSec;
  const holdEnd = slideInEnd + holdSec;

  const slideInExpr =
    slideInSec === 0
      ? formatNumber(xFinal)
      : `${formatNumber(xStart)}+(${formatNumber(xFinal - xStart)})*((t-${formatNumber(
          timing.startSec
        )})/${formatNumber(slideInSec)})`;

  if (slideOutSec === 0) {
    const xExpr = `if(lt(t,${formatNumber(slideInEnd)}),${slideInExpr},${formatNumber(
      xFinal
    )})`;
    return {
      xExpr,
      yExpr: formatNumber(yFinal),
      enableExpr,
    };
  }

  const slideOutExpr = `${formatNumber(xFinal)}+(${formatNumber(
    xExit - xFinal
  )})*((t-${formatNumber(holdEnd)})/${formatNumber(slideOutSec)})`;

  const xExpr = `if(lt(t,${formatNumber(slideInEnd)}),${slideInExpr},if(lt(t,${formatNumber(
    holdEnd
  )}),${formatNumber(xFinal)},${slideOutExpr}))`;

  return {
    xExpr,
    yExpr: formatNumber(yFinal),
    enableExpr,
  };
}

function buildArrowPulseExpr(
  timing: OverlayTiming,
  motion: Overlay["motion"]
): string | null {
  if (!motion?.pulsePeriodFrames) return null;
  const minAlpha = motion.pulseMinAlpha ?? 0.65;
  const maxAlpha = motion.pulseMaxAlpha ?? 1.0;
  const periodSec = motion.pulsePeriodFrames * timing.secondsPerFrame;
  if (periodSec === 0) return null;
  const t0 = formatNumber(timing.visStartSec);
  const period = formatNumber(periodSec);
  const amplitude = formatNumber(maxAlpha - minAlpha);
  const base = formatNumber(minAlpha);
  return `alpha(X,Y)*(${base}+(${amplitude})*(0.5+0.5*sin(2*PI*(T-${t0})/${period})))`;
}

function buildOverlayInputLine(
  overlay: Overlay,
  inputIndex: number,
  timing: OverlayTiming
): string {
  const opacity = overlay.opacity;
  const pulseExpr = isArrowOverlay(overlay)
    ? buildArrowPulseExpr(timing, overlay.motion)
    : null;

  const chain: string[] = [`[${inputIndex}:v]format=rgba`];

  if (pulseExpr) {
    const alphaExpr = escapeFilterExpr(pulseExpr);
    chain.push(
      `,geq=r='r(X\\,Y)':g='g(X\\,Y)':b='b(X\\,Y)':a='${alphaExpr}'`
    );
  }

  if (typeof opacity === "number") {
    chain.push(`,colorchannelmixer=aa=${formatNumber(opacity)}`);
  }

  chain.push(`[ov${inputIndex}]`);
  return chain.join("");
}

function buildFilterScript(
  project: Project,
  overlays: Overlay[],
  speed: 1 | 2,
  baseLabel: string,
  preLines: string[],
  timelineInputCount: number,
  renderTuning?: {
    outputFps?: number;
    outputWidth?: number;
    outputHeight?: number;
    maxDurationSec?: number;
  },
  audioPlan?: AudioPlan
): FilterResult {
  const fps = project.video.fpsNum / project.video.fpsDen;
  const videoWidth = project.video.width || DEFAULT_VIDEO_WIDTH;
  const lines: string[] = [...preLines];
  if (audioPlan?.lines?.length) {
    lines.push(...audioPlan.lines);
  }
  const speedExpr = speed === 2 ? "0.5*PTS" : "PTS-STARTPTS";

  const baseChain = [`${baseLabel}setpts=${speedExpr}`];
  if (renderTuning?.outputFps && renderTuning.outputFps > 0) {
    baseChain.push(`fps=${formatNumber(renderTuning.outputFps)}`);
  }
  if (renderTuning?.outputWidth && renderTuning?.outputHeight) {
    baseChain.push(`scale=${renderTuning.outputWidth}:${renderTuning.outputHeight}`);
  }
  if (renderTuning?.maxDurationSec && renderTuning.maxDurationSec > 0) {
    baseChain.push(`trim=duration=${formatNumber(renderTuning.maxDurationSec)}`);
    baseChain.push("setpts=PTS-STARTPTS");
  }
  lines.push(`${baseChain.join(",")}[v0]`);

  let audioOutputLabel: string | undefined;
  if (audioPlan?.label) {
    const speedFilter = speed === 2 ? ",atempo=2.0" : "";
    lines.push(`${audioPlan.label}asetpts=PTS-STARTPTS${speedFilter}[aout]`);
    audioOutputLabel = "[aout]";
  }

  let prevLabel = "[v0]";

  overlays.forEach((overlay, index) => {
    const inputIndex = timelineInputCount + index + 1;
    const ovLabel = `[ov${inputIndex}]`;
    const timing = computeOverlayTiming(overlay, fps, speed);
    lines.push(buildOverlayInputLine(overlay, inputIndex, timing));

    const { xExpr, yExpr, enableExpr } = buildOverlayExpressions(
      overlay,
      timing,
      videoWidth
    );

    const overlayLine = `${prevLabel}${ovLabel}overlay=x='${escapeFilterExpr(
      xExpr
    )}':y='${escapeFilterExpr(yExpr)}':enable='${escapeFilterExpr(
      enableExpr
    )}':shortest=1[v${inputIndex}]`;

    lines.push(overlayLine);
    prevLabel = `[v${inputIndex}]`;
  });

  const script = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(";\n");

  return {
    script,
    outputLabel: prevLabel,
    audioLabel: audioOutputLabel,
  };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeTransition(input?: {
  type?: "cut" | "crossfade";
  durationFrames?: number;
}): TimelineTransition {
  if (input?.type === "crossfade") {
    return {
      type: "crossfade",
      durationFrames: Math.max(0, Math.floor(input.durationFrames ?? DEFAULT_CROSSFADE_FRAMES)),
    };
  }
  return { type: "cut", durationFrames: 0 };
}

function outputFramesForSegment(
  segment: Pick<TimelineSegment, "kind" | "durationFrames" | "playbackRate">
): number {
  if ("kind" in segment && segment.kind === "image") {
    return Math.max(1, Math.round(segment.durationFrames));
  }
  return Math.max(1, Math.round(segment.durationFrames / Math.max(0.01, segment.playbackRate)));
}

function scaleFrameCount(value: number | undefined, playbackRate: number, minimum = 0): number | undefined {
  if (typeof value !== "number") return undefined;
  return Math.max(minimum, Math.round(value / Math.max(0.01, playbackRate)));
}

function buildAtempoFilters(playbackRate: number): string {
  if (Math.abs(playbackRate - 1) < 0.0001) return "";
  const filters: number[] = [];
  let remaining = playbackRate;
  while (remaining > 2) {
    filters.push(2);
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push(0.5);
    remaining /= 0.5;
  }
  if (Math.abs(remaining - 1) >= 0.0001) {
    filters.push(remaining);
  }
  return filters.map((rate) => `,atempo=${formatNumber(rate)}`).join("");
}

function adjustOverlaysForSegments(project: Project, segments: TimelineSegment[]): Overlay[] {
  const mapFrame = (frame: number) => {
    for (const segment of segments) {
      if (segment.kind !== "source") continue;
      if (frame >= segment.startFrame && frame < segment.endFrame) {
        return {
          outputFrame:
            segment.outputStartFrame +
            (frame - segment.startFrame) / Math.max(0.01, segment.playbackRate),
          segment,
        };
      }
    }
    return null;
  };

  const adjustedOverlays: Overlay[] = [];
  for (const overlay of project.overlays) {
    const start = mapFrame(overlay.startFrame);
    if (!start) continue;
    const segment = start.segment;
    const segmentOutputFrames = outputFramesForSegment(segment);
    const segmentEndOutput = segment.outputStartFrame + segmentOutputFrames;
    const mappedEnd = mapFrame(overlay.endFrame);
    const nextEnd = mappedEnd
      ? Math.min(mappedEnd.outputFrame, segmentEndOutput)
      : segmentEndOutput;

    if (nextEnd <= start.outputFrame) continue;
    const outputStartFrame = Math.floor(start.outputFrame);
    const outputEndFrame = Math.max(outputStartFrame, Math.ceil(nextEnd));
    const nextOverlay: Overlay = {
      ...overlay,
      startFrame: outputStartFrame,
      endFrame: outputEndFrame,
    };

    if (overlay.motion) {
      const motion = { ...overlay.motion };
      if (typeof motion.visibleStartFrame === "number") {
        const visStart = mapFrame(motion.visibleStartFrame);
        motion.visibleStartFrame = visStart
          ? Math.floor(visStart.outputFrame)
          : nextOverlay.startFrame;
      }
      if (typeof motion.visibleEndFrame === "number") {
        const visEnd = mapFrame(motion.visibleEndFrame);
        motion.visibleEndFrame = visEnd
          ? Math.min(Math.ceil(visEnd.outputFrame), nextOverlay.endFrame)
          : nextOverlay.endFrame;
      }
      motion.slideInFrames = scaleFrameCount(motion.slideInFrames, segment.playbackRate);
      motion.slideOutFrames = scaleFrameCount(motion.slideOutFrames, segment.playbackRate);
      motion.pulsePeriodFrames = scaleFrameCount(
        motion.pulsePeriodFrames,
        segment.playbackRate,
        1
      );
      motion.bouncePeriodFrames = scaleFrameCount(
        motion.bouncePeriodFrames,
        segment.playbackRate,
        1
      );
      const scaledDisplayFrames = scaleFrameCount(
        motion.displayFrames,
        segment.playbackRate
      );
      if (!isArrowOverlay(overlay) && typeof scaledDisplayFrames === "number") {
        const slideIn = motion.slideInFrames ?? 0;
        const slideOut = motion.slideOutFrames ?? 0;
        const available = Math.max(0, segmentEndOutput - outputStartFrame - slideIn - slideOut);
        motion.displayFrames = Math.min(scaledDisplayFrames, available);
      } else {
        motion.displayFrames = scaledDisplayFrames;
      }
      nextOverlay.motion = motion;
    }
    adjustedOverlays.push(nextOverlay);
  }
  return adjustedOverlays;
}

function normalizeSourceSegmentsForRender(project: Project): SourceSegment[] {
  const totalFrames = Math.max(
    1,
    Math.floor((project.video.durationMs / 1000) * (project.video.fpsNum / project.video.fpsDen))
  );
  return (project.edits?.sourceSegments ?? [])
    .map((segment) => {
      if (segment.kind === "image") {
        return {
          ...segment,
          kind: "image" as const,
          startFrame: 0,
          endFrameExclusive: 1,
          playbackRate: 1,
          audio: "mute" as const,
          durationFrames: Math.max(1, Math.floor(segment.durationFrames ?? 1)),
          assetPath: segment.assetPath?.trim(),
          transition: normalizeTransition(segment.transition),
        };
      }
      const startFrame = clampNumber(segment.startFrame, 0, totalFrames - 1);
      const endFrameExclusive = clampNumber(segment.endFrameExclusive, startFrame + 1, totalFrames);
      return {
        ...segment,
        kind: "source" as const,
        startFrame,
        endFrameExclusive,
        playbackRate: Math.max(0.01, segment.playbackRate),
        audio: segment.audio ?? "preserve",
        transition: normalizeTransition(segment.transition),
      };
    })
    .filter((segment) =>
      segment.kind === "image"
        ? Boolean(segment.assetPath && segment.durationFrames && segment.durationFrames > 0)
        : segment.endFrameExclusive > segment.startFrame
    );
}

function combineVideoSegments(
  baseLines: string[],
  segments: TimelineSegment[],
  transitions: TimelineTransition[],
  segmentLabelPrefix: string,
  concatLabelPrefix: string,
  xfadeLabelPrefix: string,
  fps: number
): { label: string; outputFrames: number } {
  let currentLabel = `[${segmentLabelPrefix}0]`;
  let currentDurationFrames = outputFramesForSegment(segments[0]);

  segments.slice(1).forEach((segment, index) => {
    const nextLabel = `[${segmentLabelPrefix}${index + 1}]`;
    const transition = transitions[index] ?? { type: "cut", durationFrames: 0 };
    if (transition.type === "crossfade" && transition.durationFrames > 0) {
      const durationFrames = transition.durationFrames;
      const offsetFrames = Math.max(0, currentDurationFrames - durationFrames);
      const outLabel = `[${xfadeLabelPrefix}${index + 1}]`;
      baseLines.push(
        `${currentLabel}${nextLabel}xfade=transition=fade:duration=${formatNumber(
          durationFrames / fps
        )}:offset=${formatNumber(offsetFrames / fps)},setpts=PTS-STARTPTS${outLabel}`
      );
      currentDurationFrames =
        currentDurationFrames + outputFramesForSegment(segment) - durationFrames;
      currentLabel = outLabel;
      return;
    }

    const outLabel = `[${concatLabelPrefix}${index + 1}]`;
    baseLines.push(
      `${currentLabel}${nextLabel}concat=n=2:v=1:a=0,setpts=PTS-STARTPTS${outLabel}`
    );
    currentDurationFrames += outputFramesForSegment(segment);
    currentLabel = outLabel;
  });

  return { label: currentLabel, outputFrames: Math.max(1, currentDurationFrames) };
}

function combineAudioSegments(
  audioLines: string[],
  segments: TimelineSegment[],
  transitions: TimelineTransition[],
  fps: number
): string {
  let currentAudioLabel = "[a0]";

  segments.slice(1).forEach((segment, index) => {
    const nextLabel = `[a${index + 1}]`;
    const transition = transitions[index] ?? { type: "cut", durationFrames: 0 };
    if (transition.type === "crossfade" && transition.durationFrames > 0) {
      const durationSec = transition.durationFrames / fps;
      const outLabel = `[ax${index + 1}]`;
      audioLines.push(
        `${currentAudioLabel}${nextLabel}acrossfade=d=${formatNumber(
          durationSec
        )}:c1=tri:c2=tri,asetpts=PTS-STARTPTS${outLabel}`
      );
      currentAudioLabel = outLabel;
      return;
    }

    const outLabel = `[ac${index + 1}]`;
    audioLines.push(
      `${currentAudioLabel}${nextLabel}concat=n=2:v=0:a=1,asetpts=PTS-STARTPTS${outLabel}`
    );
    currentAudioLabel = outLabel;
  });

  return currentAudioLabel;
}

function buildSourceSegmentTimelinePlan(project: Project): {
  project: Project;
  baseLabel: string;
  baseLines: string[];
  outputFrames: number;
  audioLabel?: string;
  audioLines?: string[];
  timelineInputs: string[];
  usesSourceSegments: boolean;
} {
  const fps = project.video.fpsNum / project.video.fpsDen;
  const hasAudio = Boolean(project.video.audio?.hasAudio);
  const sourceSegments = normalizeSourceSegmentsForRender(project);
  if (!sourceSegments.length) {
    throw new Error("No source segments remain after normalization");
  }

  const timelineSegments: TimelineSegment[] = [];
  const timelineInputs: string[] = [];
  const transitions = sourceSegments.slice(0, -1).map((segment, index) => {
    const transition = normalizeTransition(segment.transition);
    const maxDuration = Math.min(
      transition.durationFrames,
      sourceSegments[index].kind === "image"
        ? Math.max(1, sourceSegments[index].durationFrames ?? 1)
        : Math.max(1, Math.round((sourceSegments[index].endFrameExclusive - sourceSegments[index].startFrame) / sourceSegments[index].playbackRate)),
      sourceSegments[index + 1].kind === "image"
        ? Math.max(1, sourceSegments[index + 1].durationFrames ?? 1)
        : Math.max(1, Math.round((sourceSegments[index + 1].endFrameExclusive - sourceSegments[index + 1].startFrame) / sourceSegments[index + 1].playbackRate))
    );
    return transition.type === "crossfade" && maxDuration > 0
      ? { type: "crossfade" as const, durationFrames: maxDuration }
      : { type: "cut" as const, durationFrames: 0 };
  });

  let outputCursor = 0;
  sourceSegments.forEach((segment, index) => {
    if (segment.kind === "image") {
      const imageInputIndex = timelineInputs.length;
      timelineInputs.push(segment.assetPath ?? "");
      const timelineSegment: TimelineSegment = {
        kind: "image",
        startFrame: 0,
        endFrame: Math.max(1, segment.durationFrames ?? 1),
        durationFrames: Math.max(1, segment.durationFrames ?? 1),
        outputStartFrame: outputCursor,
        playbackRate: 1,
        audio: "mute",
        assetPath: segment.assetPath,
        imageInputIndex,
      };
      timelineSegments.push(timelineSegment);
      outputCursor += outputFramesForSegment(timelineSegment);
      const transition = transitions[index];
      if (transition?.type === "crossfade") {
        outputCursor -= transition.durationFrames;
      }
      return;
    }

    const timelineSegment: TimelineSegment = {
      kind: "source",
      startFrame: segment.startFrame,
      endFrame: segment.endFrameExclusive,
      durationFrames: segment.endFrameExclusive - segment.startFrame,
      outputStartFrame: outputCursor,
      playbackRate: segment.playbackRate,
      audio: segment.audio,
    };
    timelineSegments.push(timelineSegment);
    outputCursor += outputFramesForSegment(timelineSegment);
    const transition = transitions[index];
    if (transition?.type === "crossfade") {
      outputCursor -= transition.durationFrames;
    }
  });

  const baseLines: string[] = [];
  timelineSegments.forEach((segment, index) => {
    if (segment.kind === "image") {
      const inputIndex = 1 + (segment.imageInputIndex ?? 0);
      const durationSec = outputFramesForSegment(segment) / fps;
      baseLines.push(
        `[${inputIndex}:v]scale=${project.video.width || DEFAULT_VIDEO_WIDTH}:${project.video.height || DEFAULT_VIDEO_HEIGHT}:force_original_aspect_ratio=decrease,pad=${project.video.width || DEFAULT_VIDEO_WIDTH}:${project.video.height || DEFAULT_VIDEO_HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1,tpad=stop_mode=clone:stop_duration=${formatNumber(
          durationSec
        )},trim=duration=${formatNumber(durationSec)},fps=${formatNumber(
          fps
        )},setpts=PTS-STARTPTS[ss${index}]`
      );
      return;
    }

    const setpts =
      Math.abs(segment.playbackRate - 1) < 0.0001
        ? "PTS-STARTPTS"
        : `(PTS-STARTPTS)/${formatNumber(segment.playbackRate)}`;
    baseLines.push(
      `[0:v]trim=start_frame=${segment.startFrame}:end_frame=${segment.endFrame},setpts=${setpts},fps=${formatNumber(fps)},setpts=PTS-STARTPTS[ss${index}]`
    );
  });

  const combined = combineVideoSegments(
    baseLines,
    timelineSegments,
    transitions,
    "ss",
    "sc",
    "sx",
    fps
  );

  const audioLines: string[] = [];
  let audioLabel: string | undefined;
  if (hasAudio) {
    const sampleRate = project.video.audio?.sampleRate ?? 48000;
    timelineSegments.forEach((segment, index) => {
      const outputDurationSec = outputFramesForSegment(segment) / fps;
      if (segment.audio === "mute") {
        audioLines.push(
          `anullsrc=channel_layout=stereo:sample_rate=${sampleRate},atrim=duration=${formatNumber(
            outputDurationSec
          )},asetpts=PTS-STARTPTS[a${index}]`
        );
        return;
      }

      const startSec = segment.startFrame / fps;
      const endSec = segment.endFrame / fps;
      audioLines.push(
        `[0:a]atrim=start=${formatNumber(startSec)}:end=${formatNumber(
          endSec
        )},asetpts=PTS-STARTPTS${buildAtempoFilters(segment.playbackRate)},asetpts=PTS-STARTPTS[a${index}]`
      );
    });

    audioLabel = combineAudioSegments(audioLines, timelineSegments, transitions, fps);
  }

  return {
    project: { ...project, overlays: adjustOverlaysForSegments(project, timelineSegments) },
    baseLabel: combined.label,
    baseLines,
    outputFrames: combined.outputFrames,
    audioLabel,
    audioLines: audioLines.length ? audioLines : undefined,
    timelineInputs,
    usesSourceSegments: true,
  };
}

function buildTimelinePlan(project: Project): {
  project: Project;
  baseLabel: string;
  baseLines: string[];
  outputFrames: number;
  audioLabel?: string;
  audioLines?: string[];
  timelineInputs?: string[];
  usesSourceSegments?: boolean;
} {
  if (project.edits?.sourceSegments?.length) {
    return buildSourceSegmentTimelinePlan(project);
  }

  const fps = project.video.fpsNum / project.video.fpsDen;
  const hasAudio = Boolean(project.video.audio?.hasAudio);
  const totalFrames = Math.max(
    1,
    Math.floor((project.video.durationMs / 1000) * fps)
  );
  const trimStart = clampNumber(project.edits?.trimStartFrames ?? 0, 0, totalFrames - 1);
  const trimEnd = clampNumber(
    project.edits?.trimEndFrames ?? 0,
    0,
    totalFrames - 1 - trimStart
  );
  const hasCuts = (project.edits?.cuts?.length ?? 0) > 0;
  const hasTrim = trimStart > 0 || trimEnd > 0;

  if (!hasCuts && !hasTrim) {
    return {
      project,
      baseLabel: "[0:v]",
      baseLines: [],
      outputFrames: totalFrames,
      audioLabel: hasAudio ? "[0:a]" : undefined,
      audioLines: hasAudio ? [] : undefined,
      timelineInputs: [],
    };
  }

  const keepStart = trimStart;
  const keepEnd = totalFrames - trimEnd;
  if (keepEnd <= keepStart) {
    throw new Error("Trim removes entire video");
  }

  const cuts = (project.edits?.cuts ?? [])
    .map((cut) => {
      const start = clampNumber(cut.startFrame, keepStart, keepEnd - 1);
      const endExclusive = clampNumber(cut.endFrame + 1, keepStart, keepEnd);
      return {
        ...cut,
        startFrame: start,
        endFrame: Math.max(start, endExclusive),
        transition: normalizeTransition(cut.transition),
      };
    })
    .filter((cut) => cut.endFrame > cut.startFrame)
    .sort((a, b) => a.startFrame - b.startFrame);

  const segments: TimelineSegment[] = [];
  const transitions: TimelineTransition[] = [];
  let cursor = keepStart;
  let pendingTransition: TimelineTransition | null = null;

  for (const cut of cuts) {
    if (cut.endFrame <= cursor) continue;
    const cutStart = Math.max(cut.startFrame, keepStart);
    const cutEnd = Math.min(cut.endFrame, keepEnd);
    if (cutStart > cursor) {
      segments.push({
        kind: "source",
        startFrame: cursor,
        endFrame: cutStart,
        durationFrames: cutStart - cursor,
        outputStartFrame: 0,
        playbackRate: 1,
        audio: "preserve",
      });
      if (pendingTransition) {
        transitions.push(pendingTransition);
        pendingTransition = null;
      }
    }
    cursor = Math.max(cursor, cutEnd);
    if (cursor < keepEnd) {
      pendingTransition = normalizeTransition(cut.transition);
    }
  }

  if (cursor < keepEnd) {
    segments.push({
      kind: "source",
      startFrame: cursor,
      endFrame: keepEnd,
      durationFrames: keepEnd - cursor,
      outputStartFrame: 0,
      playbackRate: 1,
      audio: "preserve",
    });
    if (pendingTransition) {
      transitions.push(pendingTransition);
    }
  }

  if (!segments.length) {
    throw new Error("No video segments remain after trims/cuts");
  }

  while (transitions.length < segments.length - 1) {
    transitions.push({ type: "cut", durationFrames: 0 });
  }

  const normalizedTransitions = transitions.map((transition, index) => {
    if (transition.type !== "crossfade") return transition;
    const maxDuration = Math.min(
      transition.durationFrames,
      segments[index].durationFrames,
      segments[index + 1]?.durationFrames ?? transition.durationFrames
    );
    if (maxDuration <= 0) return { type: "cut", durationFrames: 0 };
    return { type: "crossfade", durationFrames: maxDuration };
  });

  let outputCursor = 0;
  segments.forEach((segment, index) => {
    segment.outputStartFrame = outputCursor;
    outputCursor += segment.durationFrames;
    const transition = normalizedTransitions[index];
    if (transition?.type === "crossfade") {
      outputCursor -= transition.durationFrames;
    }
  });

  const mapFrame = (frame: number) => {
    for (const segment of segments) {
      if (frame >= segment.startFrame && frame < segment.endFrame) {
        return {
          outputFrame: segment.outputStartFrame + (frame - segment.startFrame),
          segment,
        };
      }
    }
    return null;
  };

  const adjustedOverlays: Overlay[] = [];
  for (const overlay of project.overlays) {
    const start = mapFrame(overlay.startFrame);
    if (!start) continue;
    const segment = start.segment;
    const segmentEndOutput = segment.outputStartFrame + segment.durationFrames;
    const mappedEnd = mapFrame(overlay.endFrame);
    const nextEnd = mappedEnd
      ? Math.min(mappedEnd.outputFrame, segmentEndOutput)
      : segmentEndOutput;

    if (nextEnd <= start.outputFrame) continue;
    const nextOverlay: Overlay = {
      ...overlay,
      startFrame: Math.floor(start.outputFrame),
      endFrame: Math.floor(nextEnd),
    };

    if (overlay.motion) {
      const motion = { ...overlay.motion };
      if (typeof motion.visibleStartFrame === "number") {
        const visStart = mapFrame(motion.visibleStartFrame);
        motion.visibleStartFrame = visStart
          ? Math.floor(visStart.outputFrame)
          : nextOverlay.startFrame;
      }
      if (typeof motion.visibleEndFrame === "number") {
        const visEnd = mapFrame(motion.visibleEndFrame);
        motion.visibleEndFrame = visEnd
          ? Math.min(Math.floor(visEnd.outputFrame), nextOverlay.endFrame)
          : nextOverlay.endFrame;
      }
      if (!isArrowOverlay(overlay) && typeof motion.displayFrames === "number") {
        const slideIn = motion.slideInFrames ?? 0;
        const slideOut = motion.slideOutFrames ?? 0;
        const available = Math.max(
          0,
          segment.endFrame - overlay.startFrame - slideIn - slideOut
        );
        motion.displayFrames = Math.min(motion.displayFrames, available);
      }
      nextOverlay.motion = motion;
    }
    adjustedOverlays.push(nextOverlay);
  }

  const baseLines: string[] = [];
  segments.forEach((segment, index) => {
    const startSec = segment.startFrame / fps;
    const endSec = segment.endFrame / fps;
    baseLines.push(
      `[0:v]trim=start=${formatNumber(startSec)}:end=${formatNumber(
        endSec
      )},setpts=PTS-STARTPTS,fps=${formatNumber(fps)}[s${index}]`
    );
  });

  let currentLabel = "[s0]";
  let currentDurationFrames = segments[0].durationFrames;

  segments.slice(1).forEach((segment, index) => {
    const nextLabel = `[s${index + 1}]`;
    const transition = normalizedTransitions[index] ?? { type: "cut", durationFrames: 0 };
    if (transition.type === "crossfade" && transition.durationFrames > 0) {
      const durationFrames = transition.durationFrames;
      const offsetFrames = Math.max(0, currentDurationFrames - durationFrames);
      const outLabel = `[x${index + 1}]`;
      baseLines.push(
        `${currentLabel}${nextLabel}xfade=transition=fade:duration=${formatNumber(
          durationFrames / fps
        )}:offset=${formatNumber(offsetFrames / fps)},setpts=PTS-STARTPTS${outLabel}`
      );
      currentDurationFrames =
        currentDurationFrames + segment.durationFrames - durationFrames;
      currentLabel = outLabel;
      return;
    }
    const outLabel = `[c${index + 1}]`;
    baseLines.push(
      `${currentLabel}${nextLabel}concat=n=2:v=1:a=0,setpts=PTS-STARTPTS${outLabel}`
    );
    currentDurationFrames += segment.durationFrames;
    currentLabel = outLabel;
  });

  const audioLines: string[] = [];
  let audioLabel: string | undefined;
  if (hasAudio) {
    segments.forEach((segment, index) => {
      const startSec = segment.startFrame / fps;
      const endSec = segment.endFrame / fps;
      audioLines.push(
        `[0:a]atrim=start=${formatNumber(startSec)}:end=${formatNumber(
          endSec
        )},asetpts=PTS-STARTPTS[a${index}]`
      );
    });

    let currentAudioLabel = "[a0]";
    segments.slice(1).forEach((_, index) => {
      const nextLabel = `[a${index + 1}]`;
      const transition = normalizedTransitions[index] ?? { type: "cut", durationFrames: 0 };
      if (transition.type === "crossfade" && transition.durationFrames > 0) {
        const durationSec = transition.durationFrames / fps;
        const outLabel = `[ax${index + 1}]`;
        audioLines.push(
          `${currentAudioLabel}${nextLabel}acrossfade=d=${formatNumber(
            durationSec
          )}:c1=tri:c2=tri,asetpts=PTS-STARTPTS${outLabel}`
        );
        currentAudioLabel = outLabel;
        return;
      }
      const outLabel = `[ac${index + 1}]`;
      audioLines.push(
        `${currentAudioLabel}${nextLabel}concat=n=2:v=0:a=1,asetpts=PTS-STARTPTS${outLabel}`
      );
      currentAudioLabel = outLabel;
    });
    audioLabel = currentAudioLabel;
  }

  return {
    project: { ...project, overlays: adjustedOverlays },
    baseLabel: currentLabel,
    baseLines,
    outputFrames: Math.max(1, currentDurationFrames),
    audioLabel,
    audioLines: audioLines.length ? audioLines : undefined,
    timelineInputs: [],
  };
}

function toPosix(inputPath: string): string {
  return inputPath.replace(/\\/g, "/");
}

function relPath(from: string, to: string): string {
  return toPosix(path.relative(from, to));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashStable(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function resolveProjectAssetPath(projectRoot: string, inputPath: string): string {
  if (path.isAbsolute(inputPath)) return inputPath;
  return path.join(projectRoot, inputPath);
}

function concatListPath(inputPath: string): string {
  return `'${inputPath.replace(/'/g, "'\\''")}'`;
}

async function renderFlattenedSourceTimeline(
  project: Project,
  exportDir: string,
  outputPath: string,
  includeAudio: boolean,
  onProgress?: (update: RenderProgress) => void
): Promise<void> {
  const segments = normalizeSourceSegmentsForRender(project);
  if (!segments.length) {
    throw new Error("No source segments remain after normalization");
  }

  const projectRoot = path.join(WORKSPACE_ROOT, project.id);
  const sourcePath = path.join(projectRoot, "media", project.source.filename);
  const segmentDir = path.join(exportDir, "timeline_segments");
  await ensureDir(segmentDir);

  const fps = project.video.fpsNum / project.video.fpsDen;
  const width = project.video.width || DEFAULT_VIDEO_WIDTH;
  const height = project.video.height || DEFAULT_VIDEO_HEIGHT;
  const sampleRate = project.video.audio?.sampleRate ?? 48000;
  const hasAudio = includeAudio && Boolean(project.video.audio?.hasAudio);
  const segmentFiles: string[] = [];

  for (const [index, segment] of segments.entries()) {
    const segmentPath = path.join(segmentDir, `${String(index).padStart(3, "0")}.mp4`);
    const outputDurationSec = outputFramesForSegment({
      kind: segment.kind,
      durationFrames:
        segment.kind === "image"
          ? Math.max(1, segment.durationFrames ?? 1)
          : segment.endFrameExclusive - segment.startFrame,
      playbackRate: segment.playbackRate,
    }) / fps;

    const videoFilter =
      segment.kind === "image"
        ? `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${formatNumber(
            fps
          )},format=yuv420p,trim=duration=${formatNumber(
            outputDurationSec
          )},setpts=PTS-STARTPTS[v]`
        : `[0:v]setpts=(PTS-STARTPTS)/${formatNumber(
            segment.playbackRate
          )},fps=${formatNumber(
            fps
          )},scale=${width}:${height},setsar=1,format=yuv420p,trim=duration=${formatNumber(
            outputDurationSec
          )},setpts=PTS-STARTPTS[v]`;

    const audioFilter = hasAudio
      ? segment.kind === "image" || segment.audio === "mute"
        ? `anullsrc=channel_layout=stereo:sample_rate=${sampleRate},atrim=duration=${formatNumber(
            outputDurationSec
          )},asetpts=PTS-STARTPTS[a]`
        : `[0:a]asetpts=PTS-STARTPTS${buildAtempoFilters(
            segment.playbackRate
          )},atrim=duration=${formatNumber(outputDurationSec)},asetpts=PTS-STARTPTS[a]`
      : null;

    const inputArgs =
      segment.kind === "image"
        ? [
            "-loop",
            "1",
            "-t",
            formatNumber(outputDurationSec),
            "-i",
            resolveProjectAssetPath(projectRoot, segment.assetPath ?? ""),
          ]
        : [
            "-ss",
            formatNumber(segment.startFrame / fps),
            "-t",
            formatNumber((segment.endFrameExclusive - segment.startFrame) / fps),
            "-i",
            sourcePath,
          ];

    const args = [
      "-y",
      ...inputArgs,
      "-filter_complex",
      [videoFilter, audioFilter].filter(Boolean).join(";"),
      "-map",
      "[v]",
      ...(hasAudio ? ["-map", "[a]"] : []),
      "-c:v",
      "libx264",
      "-crf",
      "18",
      "-preset",
      "veryfast",
      ...(hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : []),
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      segmentPath,
    ];

    onProgress?.({
      stage: "timeline",
      message: `Rendering timeline segment ${index + 1}/${segments.length}`,
      percent: index / segments.length,
    });
    await runFfmpeg(args, exportDir, onProgress, outputDurationSec, "timeline-segment");
    segmentFiles.push(segmentPath);
  }

  const concatPath = path.join(segmentDir, "concat.txt");
  await fs.writeFile(
    concatPath,
    `${segmentFiles.map((filePath) => `file ${concatListPath(filePath)}`).join("\n")}\n`,
    "utf-8"
  );

  onProgress?.({
    stage: "timeline",
    message: "Concatenating flattened timeline",
    percent: 0.95,
  });
  await runFfmpeg(
    [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatPath,
      "-c:v",
      "libx264",
      "-crf",
      "18",
      "-preset",
      "veryfast",
      ...(hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : []),
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    exportDir,
    onProgress,
    undefined,
    "timeline-concat"
  );
}

function buildReadme(
  exportDir: string,
  manifest: ExportManifest,
  cardInputs: OverlayInput[],
  arrowInputs: OverlayInput[]
): string {
  const preset = EXPORT_PRESETS[manifest.presetId] ??
    EXPORT_PRESETS[DEFAULT_PRESET_ID];
  const timelineLines = manifest.timelineInputs.map(
    (input) => `  -i ${relPath(exportDir, input)} \\\\`
  );
  const overlayLines = cardInputs.map(
    (input) => `  -loop 1 -framerate ${STATIC_OVERLAY_INPUT_FPS} -i ${relPath(exportDir, input.filePath)} \\\\`
  );
  const arrowLines = arrowInputs.map(
    (input) => `  -loop 1 -framerate ${STATIC_OVERLAY_INPUT_FPS} -i ${relPath(exportDir, input.filePath)} \\\\`
  );

  const inputVideo = relPath(exportDir, manifest.source);
  const cardsScript = manifest.filterCards;
  const cardsArrowsScript = manifest.filterCardsArrows;

  const cardsCommand = [
    `ffmpeg -y -i ${inputVideo} \\\\`,
    ...timelineLines,
    ...overlayLines,
    `  -filter_complex_script ${cardsScript} \\\\`,
    `  -map "${manifest.outputLabelCards}" \\\\`,
    ...(manifest.includeAudio && manifest.outputLabelCardsAudio
      ? [
          `  -map "${manifest.outputLabelCardsAudio}" \\\\`,
          "  -c:a aac -b:a 192k \\\\",
        ]
      : []),
    `  -c:v ${preset.codec} ${preset.args.join(" ")} -pix_fmt yuv420p \\\\`,
    "  main_noslug.mp4",
  ].join("\n");

  let arrowsCommand = "";
  if (arrowInputs.length) {
    arrowsCommand = [
      `ffmpeg -y -i ${inputVideo} \\\\`,
      ...timelineLines,
      ...overlayLines,
      ...arrowLines,
      `  -filter_complex_script ${cardsArrowsScript} \\\\`,
      `  -map "${manifest.outputLabelCardsArrows}" \\\\`,
      ...(manifest.includeAudio && manifest.outputLabelCardsArrowsAudio
        ? [
            `  -map "${manifest.outputLabelCardsArrowsAudio}" \\\\`,
            "  -c:a aac -b:a 192k \\\\",
          ]
        : []),
      `  -c:v ${preset.codec} ${preset.args.join(" ")} -pix_fmt yuv420p \\\\`,
      "  main_noslug_arrows.mp4",
    ].join("\n");
  }

  const slugNote =
    manifest.includeSlugStart || manifest.includeSlugEnd
      ? `\nInclude slug start: ${manifest.includeSlugStart} · Include slug end: ${manifest.includeSlugEnd} (concat step). Use slug paths from project.json.`
      : "";

  const lines: string[] = [
    "# Export Instructions",
    "",
    "Run these commands from this export folder.",
    "",
    "## Cards only",
    "",
    "```bash",
    cardsCommand,
    "```",
    "",
  ];

  if (arrowInputs.length) {
    lines.push("## Cards + arrows", "", "```bash", arrowsCommand, "```", "");
  }

  if (slugNote) {
    lines.push(slugNote, "");
  }

  return lines.join("\n");
}

function parseTimestamp(value: string): number | null {
  const match = value.match(/(\d+):(\d+):(\d+\.?\d*)/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return null;
  }
  return hours * 3600 + minutes * 60 + seconds;
}

async function runFfmpeg(
  args: string[],
  cwd: string,
  onProgress?: (update: RenderProgress) => void,
  durationSec?: number,
  stage?: string
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let buffer = "";
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      buffer += text;
      const lines = buffer.split(/\r?\n|\r/g);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const timeMatch = trimmed.match(/time=([0-9:.]+)/);
        if (timeMatch && durationSec) {
          const seconds = parseTimestamp(timeMatch[1]);
          if (seconds !== null) {
            const percent = Math.min(1, Math.max(0, seconds / durationSec));
            onProgress?.({ stage: stage ?? "ffmpeg", percent, message: trimmed });
          }
        } else {
          onProgress?.({ stage: stage ?? "ffmpeg", message: trimmed });
        }
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `ffmpeg exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

async function resolveSlugPath(projectRoot: string, inputPath?: string): Promise<string | null> {
  if (!inputPath) return null;
  if (path.isAbsolute(inputPath)) return inputPath;
  const projectCandidate = path.join(projectRoot, inputPath);
  if (await fileExists(projectCandidate)) return projectCandidate;
  const workspaceCandidate = path.join(WORKSPACE_ROOT, inputPath);
  if (await fileExists(workspaceCandidate)) return workspaceCandidate;
  const repoCandidate = path.join(REPO_ROOT, inputPath);
  if (await fileExists(repoCandidate)) return repoCandidate;
  return null;
}

function resolveProjectAudioPath(projectRoot: string, inputPath: string): string {
  if (path.isAbsolute(inputPath)) return inputPath;
  return path.join(projectRoot, inputPath);
}

function planExternalAudioFade(
  audioTrack: NonNullable<Project["audioTrack"]>,
  startSec: number,
  durationSec: number,
  context: ExternalAudioContext
): ExternalAudioFadePlan | undefined {
  const fadeOut = audioTrack.fadeOut;
  if (!fadeOut?.enabled) return undefined;

  const target = fadeOut.target ?? "tailSlug";
  const requestedEndSec = target === "tailSlug" ? context.tailSlugStartSec : durationSec;
  if (typeof requestedEndSec !== "number" || !Number.isFinite(requestedEndSec)) {
    return undefined;
  }

  const endSec = clampNumber(requestedEndSec, startSec, durationSec);
  if (endSec <= startSec) return undefined;

  const requestedDurationSec = Math.max(0, fadeOut.durationSec ?? 2);
  const fadeStartSec = Math.max(startSec, endSec - requestedDurationSec);
  const fadeDurationSec = endSec - fadeStartSec;
  if (fadeDurationSec <= 0) return undefined;

  return {
    target,
    startSec: fadeStartSec,
    endSec,
    durationSec: fadeDurationSec,
  };
}

async function applyExternalAudioTrack(
  project: Project,
  exportDir: string,
  inputPath: string,
  outputPath: string,
  onProgress?: (update: RenderProgress) => void,
  context: ExternalAudioContext = {}
): Promise<ExternalAudioApplyResult> {
  const audioTrack = project.audioTrack;
  if (!audioTrack) {
    await fs.copyFile(inputPath, outputPath);
    const outputInfo = await probeVideo(inputPath);
    return { durationSec: outputInfo.durationMs / 1000 };
  }

  const projectRoot = path.join(WORKSPACE_ROOT, project.id);
  const audioPath = resolveProjectAudioPath(projectRoot, audioTrack.assetPath);
  if (!(await fileExists(audioPath))) {
    throw new Error(`External audio asset is missing: ${audioTrack.assetPath}`);
  }

  const outputInfo = await probeVideo(inputPath);
  const durationSec = outputInfo.durationMs > 0
    ? outputInfo.durationMs / 1000
    : project.video.durationMs / 1000;
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error("Cannot apply external audio because output duration is unknown");
  }

  const startSec = clampNumber(audioTrack.startSec ?? 0, 0, durationSec);
  const remainingSec = Math.max(0, durationSec - startSec);
  const startMs = Math.round(startSec * 1000);
  const fadePlan = planExternalAudioFade(audioTrack, startSec, durationSec, context);
  const audioFormat = "aformat=sample_rates=48000:channel_layouts=stereo";
  const lines: string[] = [];
  let externalLabel: string | null = null;

  if (remainingSec > 0) {
    const externalDurationSec = fadePlan
      ? Math.max(0, fadePlan.endSec - startSec)
      : remainingSec;
    const externalFilters = [
      `[1:a]${audioFormat}`,
      `atrim=duration=${formatNumber(externalDurationSec)}`,
      "asetpts=PTS-STARTPTS",
    ];
    if (fadePlan) {
      externalFilters.push(
        `afade=t=out:st=${formatNumber(fadePlan.startSec - startSec)}:d=${formatNumber(
          fadePlan.durationSec
        )}`
      );
    }
    externalFilters.push(
      `adelay=${startMs}:all=1`,
      "apad",
      `atrim=duration=${formatNumber(durationSec)}`,
      "asetpts=PTS-STARTPTS[exta]"
    );
    lines.push(externalFilters.join(","));
    externalLabel = "[exta]";
  }

  const silenceLine = `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${formatNumber(
    durationSec
  )},asetpts=PTS-STARTPTS[basea]`;
  const mode = audioTrack.mode ?? "overlay";
  let audioOutputLabel = "[basea]";

  if (mode === "overlay" && outputInfo.audio?.hasAudio) {
    lines.push(
      `[0:a]${audioFormat},atrim=duration=${formatNumber(
        durationSec
      )},asetpts=PTS-STARTPTS[basea]`
    );
  } else {
    lines.push(silenceLine);
  }

  if (externalLabel) {
    lines.push(
      `[basea]${externalLabel}amix=inputs=2:duration=first:dropout_transition=0[aout]`
    );
    audioOutputLabel = "[aout]";
  }

  onProgress?.({
    stage: "audio",
    message: `Applying external audio (${mode})`,
    percent: 0,
  });
  await runFfmpeg(
    [
      "-y",
      "-i",
      inputPath,
      "-i",
      audioPath,
      "-filter_complex",
      lines.join(";"),
      "-map",
      "0:v:0",
      "-map",
      audioOutputLabel,
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    exportDir,
    onProgress,
    durationSec,
    "ffmpeg-audio"
  );
  return { durationSec, fadeOut: fadePlan };
}

function buildOverlayStructuralHash(overlay: Overlay): string {
  return hashStable({
    version: 1,
    kind: isArrowOverlay(overlay) ? "arrow" : "card",
    startFrame: overlay.startFrame,
    endFrame: overlay.endFrame,
    rect: overlay.rect,
    opacity: overlay.opacity,
    zIndex: overlay.zIndex,
    motion: overlay.motion,
  });
}

function buildOverlaySnapshots(projectForRender: Project, speed: 1 | 2): OverlayRenderSnapshot[] {
  const fps = projectForRender.video.fpsNum / projectForRender.video.fpsDen;
  return sortOverlays(projectForRender.overlays).map((overlay) => {
    const timing = computeOverlayTiming(overlay, fps, speed);
    return {
      id: overlay.id,
      kind: isArrowOverlay(overlay) ? "arrow" : "card",
      visualHash: getOverlayAssetHash(overlay),
      structuralHash: buildOverlayStructuralHash(overlay),
      startSec: timing.visStartSec,
      endSec: timing.visEndSec,
    };
  });
}

function buildExportFingerprints(input: {
  project: Project;
  renderTuning: RenderTuning;
  presetId: string;
  speed: 1 | 2;
  includeAudio: boolean;
  includeSlugStart: boolean;
  includeSlugEnd: boolean;
}): ExportFingerprints {
  const { project, renderTuning, presetId, speed, includeAudio, includeSlugStart, includeSlugEnd } =
    input;
  return {
    source: hashStable({
      version: 1,
      source: project.source,
      video: project.video,
    }),
    timeline: hashStable({
      version: 1,
      edits: project.edits ?? null,
    }),
    render: hashStable({
      version: 1,
      presetId,
      speed,
      includeAudio,
      includeSlugStart,
      includeSlugEnd,
      renderMode: renderTuning.mode,
      outputFps: renderTuning.outputFps,
      outputWidth: renderTuning.outputWidth,
      outputHeight: renderTuning.outputHeight,
    }),
    slug: hashStable({
      version: 1,
      includeSlugStart,
      includeSlugEnd,
      slug: project.slug ?? null,
    }),
    audio: hashStable({
      version: 1,
      includeAudio,
      audioTrack: project.audioTrack ?? null,
    }),
  };
}

function hasUnsupportedNonFlattenedTimeline(project: Project): boolean {
  if (project.edits?.sourceSegments?.length) return false;
  const trimStartFrames = project.edits?.trimStartFrames ?? 0;
  const trimEndFrames = project.edits?.trimEndFrames ?? 0;
  const cuts = project.edits?.cuts ?? [];
  return trimStartFrames > 0 || trimEndFrames > 0 || cuts.length > 0;
}

function mergePatchWindows(windows: PatchWindow[]): PatchWindow[] {
  const sorted = windows
    .filter((window) => window.endSec > window.startSec)
    .sort((a, b) => a.startSec - b.startSec);
  const merged: PatchWindow[] = [];
  for (const window of sorted) {
    const previous = merged.at(-1);
    if (!previous || window.startSec > previous.endSec) {
      merged.push({ ...window });
      continue;
    }
    previous.endSec = Math.max(previous.endSec, window.endSec);
  }
  return merged;
}

function buildAffectedWindows(
  snapshots: OverlayRenderSnapshot[],
  changedOverlayIds: string[],
  mainDurationSec: number,
  fps: number
): PatchWindow[] {
  const changedIds = new Set(changedOverlayIds);
  const padSec = Math.max(0.2, 2 / Math.max(1, fps));
  const windows = snapshots
    .filter((snapshot) => changedIds.has(snapshot.id))
    .map((snapshot) => ({
      startSec: Math.max(0, snapshot.startSec - padSec),
      endSec: Math.min(mainDurationSec, snapshot.endSec + padSec),
    }));
  return mergePatchWindows(windows);
}

async function readExportManifest(exportDir: string): Promise<ExportManifest | null> {
  const manifestPath = path.join(exportDir, "manifest.json");
  if (!(await fileExists(manifestPath))) return null;
  try {
    return JSON.parse(await fs.readFile(manifestPath, "utf-8")) as ExportManifest;
  } catch {
    return null;
  }
}

async function findLatestFinalExport(projectId: string): Promise<LatestExport | null> {
  const exportsRoot = path.join(WORKSPACE_ROOT, projectId, "exports");
  if (!(await fileExists(exportsRoot))) return null;
  const entries = await fs.readdir(exportsRoot, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const exportId of dirs) {
    const exportDir = path.join(exportsRoot, exportId);
    const finalPath = path.join(exportDir, "final.mp4");
    if (!(await fileExists(finalPath))) continue;
    const manifest = await readExportManifest(exportDir);
    if (!manifest || manifest.renderMode === "rough") continue;
    return { exportId, exportDir, finalPath, manifest };
  }
  return null;
}

function analyzePatchCompatibility(
  project: Project,
  options: ExportRequest,
  latest: LatestExport,
  timelinePlan: ReturnType<typeof buildTimelinePlan>,
  renderTuning: RenderTuning,
  speed: 1 | 2,
  includeAudio: boolean,
  includeSlugStart: boolean,
  includeSlugEnd: boolean,
  presetId: string
): PatchAnalysis {
  const projectForRender =
    renderTuning.mode === "rough"
      ? scaleProjectForRender(timelinePlan.project, renderTuning)
      : timelinePlan.project;
  const fingerprints = buildExportFingerprints({
    project,
    renderTuning,
    presetId,
    speed,
    includeAudio,
    includeSlugStart,
    includeSlugEnd,
  });
  const overlaySnapshots = buildOverlaySnapshots(projectForRender, speed);
  const base = latest.manifest;
  const baseMainOutput = base.mainOutput
    ? path.isAbsolute(base.mainOutput)
      ? base.mainOutput
      : path.join(latest.exportDir, base.mainOutput)
    : base.arrowInputs?.length
      ? path.join(latest.exportDir, "main_noslug_arrows.mp4")
      : path.join(latest.exportDir, "main_noslug.mp4");

  const reject = (reason: string): PatchAnalysis => ({
    patchable: false,
    reason,
    latestExportId: latest.exportId,
    changedOverlayIds: [],
    affectedWindows: [],
    latest,
    projectForRender,
    renderTuning,
    outputFrames: timelinePlan.outputFrames,
    speed,
    fingerprints,
    overlaySnapshots,
  });

  if (options.renderMode === "rough" || renderTuning.mode === "rough") {
    return reject("Surgical patching is only available for final renders.");
  }
  if (hasUnsupportedNonFlattenedTimeline(project)) {
    return reject("Projects with trim/cut edits need one full render before patching.");
  }
  if (project.edits?.sourceSegments?.length && !base.timelineSource) {
    return reject("Latest final export is missing the flattened source timeline needed for patching.");
  }
  if (!base.fingerprints || !base.overlaySnapshots) {
    return reject("Latest final export was created before surgical patch metadata existed.");
  }
  if (!base.mainOutput && !base.overlayInputs && !base.arrowInputs) {
    return reject("Latest final export does not include a patchable main render.");
  }
  if (!base.source || !baseMainOutput) {
    return reject("Latest final export is missing its patch source.");
  }
  if (
    base.fingerprints.source !== fingerprints.source ||
    base.fingerprints.timeline !== fingerprints.timeline ||
    base.fingerprints.render !== fingerprints.render ||
    base.fingerprints.slug !== fingerprints.slug ||
    base.fingerprints.audio !== fingerprints.audio
  ) {
    return reject("Source, timeline, render, slug, or audio settings changed; run a full render.");
  }

  const oldSnapshots = new Map(base.overlaySnapshots.map((snapshot) => [snapshot.id, snapshot]));
  const currentSnapshots = new Map(overlaySnapshots.map((snapshot) => [snapshot.id, snapshot]));
  if (oldSnapshots.size !== currentSnapshots.size) {
    return reject("Overlay additions or deletions require a full render.");
  }

  const changedOverlayIds: string[] = [];
  for (const snapshot of overlaySnapshots) {
    const previous = oldSnapshots.get(snapshot.id);
    if (!previous) {
      return reject("Overlay additions require a full render.");
    }
    if (
      previous.kind !== snapshot.kind ||
      previous.structuralHash !== snapshot.structuralHash
    ) {
      return reject("Overlay timing, placement, motion, or layer changes require a full render.");
    }
    if (previous.visualHash !== snapshot.visualHash) {
      changedOverlayIds.push(snapshot.id);
    }
  }

  for (const snapshot of oldSnapshots.values()) {
    if (!currentSnapshots.has(snapshot.id)) {
      return reject("Overlay deletions require a full render.");
    }
  }

  if (!changedOverlayIds.length) {
    return reject("No patchable overlay visual changes detected.");
  }

  const fps = projectForRender.video.fpsNum / projectForRender.video.fpsDen;
  const mainDurationSec = timelinePlan.outputFrames / fps / speed;
  const affectedWindows = buildAffectedWindows(
    overlaySnapshots,
    changedOverlayIds,
    mainDurationSec,
    fps
  );
  const estimatedPatchSec = affectedWindows.reduce(
    (sum, window) => sum + window.endSec - window.startSec,
    0
  );

  return {
    patchable: true,
    latestExportId: latest.exportId,
    changedOverlayIds,
    affectedWindows,
    estimatedPatchSec,
    latest,
    projectForRender,
    renderTuning,
    outputFrames: timelinePlan.outputFrames,
    speed,
    fingerprints,
    overlaySnapshots,
  };
}

function resolveLatestMainOutput(latest: LatestExport): string {
  if (latest.manifest.mainOutput) {
    return path.isAbsolute(latest.manifest.mainOutput)
      ? latest.manifest.mainOutput
      : path.join(latest.exportDir, latest.manifest.mainOutput);
  }
  return latest.manifest.arrowInputs?.length
    ? path.join(latest.exportDir, "main_noslug_arrows.mp4")
    : path.join(latest.exportDir, "main_noslug.mp4");
}

async function buildSurgicalPatchAnalysis(
  project: Project,
  options: ExportRequest = {}
): Promise<PatchAnalysis> {
  const latest = await findLatestFinalExport(project.id);
  if (!latest) {
    return {
      patchable: false,
      reason: "No final export is available to patch.",
      changedOverlayIds: [],
      affectedWindows: [],
    };
  }

  const timelinePlan = buildTimelinePlan(project);
  const renderTuning = resolveRenderTuning(project, options);
  try {
    await assertRenderPresetAvailable(renderTuning.presetId);
  } catch (error) {
    if (error instanceof RenderPresetUnavailableError) {
      return {
        patchable: false,
        reason: error.message,
        changedOverlayIds: [],
        affectedWindows: [],
      };
    }
    throw error;
  }
  const requestedSpeed = options.speed ?? project.exportOptions?.speed ?? 1;
  const speed = timelinePlan.usesSourceSegments ? 1 : requestedSpeed;
  const hasAudio = Boolean(project.video.audio?.hasAudio);
  const includeAudio =
    (typeof options.includeAudio === "boolean"
      ? options.includeAudio
      : project.exportOptions?.includeAudio ?? true) && hasAudio;
  const includeSlug =
    typeof options.includeSlug === "boolean"
      ? options.includeSlug
      : project.exportOptions?.includeSlug ?? false;
  const includeSlugStart =
    typeof options.includeSlugStart === "boolean"
      ? options.includeSlugStart
      : includeSlug || project.exportOptions?.includeSlugStart || false;
  const includeSlugEnd =
    typeof options.includeSlugEnd === "boolean"
      ? options.includeSlugEnd
      : includeSlug || project.exportOptions?.includeSlugEnd || false;
  const presetId = renderTuning.presetId;

  const analysis = analyzePatchCompatibility(
    project,
    options,
    latest,
    timelinePlan,
    renderTuning,
    speed,
    includeAudio,
    includeSlugStart,
    includeSlugEnd,
    presetId
  );
  if (!analysis.patchable) return analysis;

  const baseMainOutput = resolveLatestMainOutput(latest);
  if (!(await fileExists(baseMainOutput))) {
    return {
      ...analysis,
      patchable: false,
      reason: "Latest final export is missing its patchable main render.",
      changedOverlayIds: [],
      affectedWindows: [],
      estimatedPatchSec: undefined,
    };
  }
  if (!(await fileExists(latest.manifest.source))) {
    return {
      ...analysis,
      patchable: false,
      reason: "Latest final export is missing its patch source.",
      changedOverlayIds: [],
      affectedWindows: [],
      estimatedPatchSec: undefined,
    };
  }
  return analysis;
}

export async function getSurgicalPatchStatus(
  project: Project,
  options: ExportRequest = {}
): Promise<SurgicalPatchStatus> {
  const analysis = await buildSurgicalPatchAnalysis(project, options);
  return {
    patchable: analysis.patchable,
    reason: analysis.reason,
    latestExportId: analysis.latestExportId,
    changedOverlayIds: analysis.changedOverlayIds,
    affectedWindows: analysis.affectedWindows,
    estimatedPatchSec: analysis.estimatedPatchSec,
  };
}

export async function writeExportBundle(
  project: Project,
  options: ExportRequest = {}
): Promise<{
  exportDir: string;
  exportId: string;
  manifest: ExportManifest;
  outputFrames: number;
  projectForRender: Project;
  renderTuning: RenderTuning;
}> {
  const timelinePlan = buildTimelinePlan(project);
  const renderTuning = resolveRenderTuning(project, options);
  await assertRenderPresetAvailable(renderTuning.presetId);
  const projectForRender =
    renderTuning.mode === "rough"
      ? scaleProjectForRender(timelinePlan.project, renderTuning)
      : timelinePlan.project;
  const exportId = new Date().toISOString().replace(/[:.]/g, "-");
  const projectRoot = path.join(WORKSPACE_ROOT, project.id);
  const exportDir = path.join(projectRoot, "exports", exportId);
  const sourcePath = path.join(projectRoot, "media", project.source.filename);
  const usesFlattenedTimeline = Boolean(timelinePlan.usesSourceSegments);
  const renderSourcePath = usesFlattenedTimeline
    ? path.join(exportDir, "timeline_source.mp4")
    : sourcePath;
  const requestedSpeed = options.speed ?? project.exportOptions?.speed ?? 1;
  const speed = timelinePlan.usesSourceSegments ? 1 : requestedSpeed;
  const hasAudio = Boolean(project.video.audio?.hasAudio);
  const includeAudio =
    (typeof options.includeAudio === "boolean"
      ? options.includeAudio
      : project.exportOptions?.includeAudio ?? true) && hasAudio;
  const includeSlug =
    typeof options.includeSlug === "boolean"
      ? options.includeSlug
      : project.exportOptions?.includeSlug ?? false;
  const includeSlugStart =
    typeof options.includeSlugStart === "boolean"
      ? options.includeSlugStart
      : includeSlug || project.exportOptions?.includeSlugStart || false;
  const includeSlugEnd =
    typeof options.includeSlugEnd === "boolean"
      ? options.includeSlugEnd
      : includeSlug || project.exportOptions?.includeSlugEnd || false;
  const presetId = renderTuning.presetId;

  const sourceFps = project.video.fpsNum / project.video.fpsDen;
  const sourceSegmentOutputDurationSec = timelinePlan.usesSourceSegments
    ? timelinePlan.outputFrames / sourceFps
    : undefined;
  const timelineInputs = (timelinePlan.timelineInputs ?? []).map((inputPath) =>
    resolveProjectAssetPath(projectRoot, inputPath)
  );
  const filterTuning =
    renderTuning.mode === "rough" || sourceSegmentOutputDurationSec
      ? {
          outputFps: renderTuning.outputFps,
          outputWidth: renderTuning.outputWidth,
          outputHeight: renderTuning.outputHeight,
          maxDurationSec: sourceSegmentOutputDurationSec,
        }
      : undefined;

  const cards = sortOverlays(projectForRender.overlays.filter((overlay) => !isArrowOverlay(overlay)));
  const arrows = sortOverlays(projectForRender.overlays.filter(isArrowOverlay));
  const hasArrows = arrows.length > 0;
  const mainOutputName = hasArrows ? "main_noslug_arrows.mp4" : "main_noslug.mp4";
  const mainOutputPath = path.join(exportDir, mainOutputName);
  const fingerprints = buildExportFingerprints({
    project,
    renderTuning,
    presetId,
    speed,
    includeAudio,
    includeSlugStart,
    includeSlugEnd,
  });
  const overlaySnapshots = buildOverlaySnapshots(projectForRender, speed);

  const cardInputs: OverlayInput[] = cards.map((overlay) => ({
    overlay,
    kind: "card",
    filePath: path.join(projectRoot, "render", "overlays", `${overlay.id}.png`),
  }));

  const arrowInputs: OverlayInput[] = arrows.map((overlay) => ({
    overlay,
    kind: "arrow",
    filePath: path.join(projectRoot, "render", "arrows", `${overlay.id}.png`),
  }));

  const filterTimelineInputs = usesFlattenedTimeline ? [] : timelineInputs;
  const filterBaseLabel = usesFlattenedTimeline ? "[0:v]" : timelinePlan.baseLabel;
  const filterBaseLines = usesFlattenedTimeline ? [] : timelinePlan.baseLines;
  const audioPlan =
    includeAudio && usesFlattenedTimeline
      ? { label: "[0:a]", lines: [] }
      : includeAudio && timelinePlan.audioLabel
        ? { label: timelinePlan.audioLabel, lines: timelinePlan.audioLines ?? [] }
      : undefined;

  const cardsScript = buildFilterScript(
    projectForRender,
    cards,
    speed,
    filterBaseLabel,
    filterBaseLines,
    filterTimelineInputs.length,
    filterTuning,
    audioPlan
  );
  const cardsArrowsScript = buildFilterScript(
    projectForRender,
    [...cards, ...arrows],
    speed,
    filterBaseLabel,
    filterBaseLines,
    filterTimelineInputs.length,
    filterTuning,
    audioPlan
  );

  await ensureDir(exportDir);

  const filterCardsPath = path.join(exportDir, "filter_complex_cards.txt");
  const filterCardsArrowsPath = path.join(exportDir, "filter_complex_cards_arrows.txt");

  await fs.writeFile(filterCardsPath, cardsScript.script, "utf-8");
  await fs.writeFile(filterCardsArrowsPath, cardsArrowsScript.script, "utf-8");

  const manifest: ExportManifest = {
    projectId: project.id,
    createdAt: new Date().toISOString(),
    exportId,
    presetId,
    speed,
    includeAudio,
    includeSlugStart,
    includeSlugEnd,
    source: renderSourcePath,
    timelineSource: usesFlattenedTimeline ? sourcePath : undefined,
    timelineAssetInputs: usesFlattenedTimeline ? timelineInputs : undefined,
    timelineInputs: filterTimelineInputs,
    overlayInputs: cardInputs.map((input) => input.filePath),
    arrowInputs: arrowInputs.map((input) => input.filePath),
    filterCards: path.basename(filterCardsPath),
    filterCardsArrows: path.basename(filterCardsArrowsPath),
    outputLabelCards: cardsScript.outputLabel,
    outputLabelCardsArrows: cardsArrowsScript.outputLabel,
    outputLabelCardsAudio: cardsScript.audioLabel,
    outputLabelCardsArrowsAudio: cardsArrowsScript.audioLabel,
    renderMode: renderTuning.mode,
    outputFps: renderTuning.outputFps,
    outputWidth: renderTuning.outputWidth,
    outputHeight: renderTuning.outputHeight,
    sourceSegmentOutputFrames: timelinePlan.usesSourceSegments ? timelinePlan.outputFrames : undefined,
    sourceSegmentOutputDurationSec,
    externalAudioInput: project.audioTrack
      ? resolveProjectAudioPath(projectRoot, project.audioTrack.assetPath)
      : undefined,
    audioTrack: project.audioTrack,
    mainOutput: mainOutputPath,
    fingerprints,
    overlaySnapshots,
  };

  const readme = buildReadme(exportDir, manifest, cardInputs, arrowInputs);

  await fs.writeFile(path.join(exportDir, "README.md"), readme, "utf-8");
  await fs.writeFile(
    path.join(exportDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8"
  );

  return {
    exportDir,
    exportId,
    manifest,
    outputFrames: timelinePlan.outputFrames,
    projectForRender,
    renderTuning,
  };
}

async function assembleFinalOutput(
  project: Project,
  projectForRender: Project,
  renderTuning: RenderTuning,
  exportDir: string,
  mainOutputPath: string,
  finalPath: string,
  manifest: ExportManifest,
  durationSec: number,
  onProgress?: (update: RenderProgress) => void
): Promise<void> {
  const preset = EXPORT_PRESETS[manifest.presetId] ?? EXPORT_PRESETS[DEFAULT_PRESET_ID];
  const projectRoot = path.join(WORKSPACE_ROOT, project.id);
  const fps = project.video.fpsNum / project.video.fpsDen;
  let assembledFinalPath = mainOutputPath;
  let tailSlugStartSec: number | undefined;
  let assembledDurationSec = durationSec;

  if (manifest.includeSlugStart || manifest.includeSlugEnd) {
    const introPath = manifest.includeSlugStart
      ? await resolveSlugPath(projectRoot, project.slug?.introPath)
      : null;
    const outroPath = manifest.includeSlugEnd
      ? await resolveSlugPath(projectRoot, project.slug?.outroPath)
      : null;
    if (manifest.includeSlugStart && !introPath) {
      throw new Error("Slug intro path is required for includeSlugStart");
    }
    if (manifest.includeSlugEnd && !outroPath) {
      throw new Error("Slug outro path is required for includeSlugEnd");
    }

    const slugFps = renderTuning.outputFps ?? fps;
    const targetWidth = projectForRender.video.width;
    const targetHeight = projectForRender.video.height;
    const inputs: string[] = [];
    if (introPath) {
      inputs.push(introPath);
    }
    inputs.push(mainOutputPath);
    if (outroPath) {
      inputs.push(outroPath);
    }

    const slugTransition = normalizeTransition(project.slug?.transition);
    const useCrossfade =
      slugTransition.type === "crossfade" &&
      slugTransition.durationFrames > 0 &&
      inputs.length > 1;
    const includeAudio = manifest.includeAudio;
    const needsTailSlugStart = Boolean(
      outroPath &&
        project.audioTrack?.fadeOut?.enabled &&
        (project.audioTrack.fadeOut.target ?? "tailSlug") === "tailSlug"
    );
    const needsInputInfo = includeAudio || useCrossfade || needsTailSlugStart;
    const inputInfos: Array<{ durationSec: number; hasAudio: boolean }> = [];
    if (needsInputInfo) {
      if (introPath) {
        const introInfo = await probeVideo(introPath);
        inputInfos.push({
          durationSec: introInfo.durationMs / 1000,
          hasAudio: Boolean(introInfo.audio?.hasAudio),
        });
      }
      inputInfos.push({ durationSec, hasAudio: includeAudio });
      if (outroPath) {
        const outroInfo = await probeVideo(outroPath);
        inputInfos.push({
          durationSec: outroInfo.durationMs / 1000,
          hasAudio: Boolean(outroInfo.audio?.hasAudio),
        });
      }
    }
    const durationsSec = needsInputInfo ? inputInfos.map((info) => info.durationSec) : [];

    const baseFilter = inputs
      .map(
        (_, index) =>
          `[${index}:v]fps=${formatNumber(
            slugFps
          )},scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${index}]`
      )
      .join(";");

    const audioLines: string[] = [];
    if (includeAudio) {
      const audioFormat = "aformat=sample_rates=48000:channel_layouts=stereo";
      inputInfos.forEach((info, index) => {
        if (info.hasAudio) {
          audioLines.push(
            `[${index}:a]${audioFormat},asetpts=PTS-STARTPTS[a${index}]`
          );
          return;
        }
        audioLines.push(
          `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${formatNumber(
            info.durationSec
          )},asetpts=PTS-STARTPTS[a${index}]`
        );
      });
    }

    let concatFilter = "";
    let outputLabel = "[v]";
    let audioOutputLabel: string | null = null;
    if (useCrossfade) {
      const transitionSec = slugTransition.durationFrames / fps;
      let currentLabel = "[v0]";
      let currentDuration = durationsSec[0] ?? 0;
      const chain: string[] = [];
      const audioChain: string[] = [];

      let currentAudioLabel = "[a0]";
      let currentAudioDuration = durationsSec[0] ?? 0;

      inputs.slice(1).forEach((_, index) => {
        const nextInputIndex = index + 1;
        const nextLabel = `[v${index + 1}]`;
        const nextDuration = durationsSec[nextInputIndex] ?? 0;
        const safeDuration = Math.min(transitionSec, currentDuration, nextDuration);
        if (safeDuration > 0) {
          const offset = Math.max(0, currentDuration - safeDuration);
          if (outroPath && nextInputIndex === inputs.length - 1) {
            tailSlugStartSec = offset;
          }
          const outLabel = `[x${index + 1}]`;
          chain.push(
            `${currentLabel}${nextLabel}xfade=transition=fade:duration=${formatNumber(
              safeDuration
            )}:offset=${formatNumber(offset)}${outLabel}`
          );
          currentDuration = currentDuration + nextDuration - safeDuration;
          currentLabel = outLabel;
        } else {
          if (outroPath && nextInputIndex === inputs.length - 1) {
            tailSlugStartSec = currentDuration;
          }
          const outLabel = `[c${index + 1}]`;
          chain.push(`${currentLabel}${nextLabel}concat=n=2:v=1:a=0${outLabel}`);
          currentDuration += nextDuration;
          currentLabel = outLabel;
        }

        if (!includeAudio) return;
        const nextAudioLabel = `[a${nextInputIndex}]`;
        const safeAudioDuration = Math.min(
          transitionSec,
          currentAudioDuration,
          durationsSec[nextInputIndex] ?? 0
        );
        if (safeAudioDuration > 0) {
          const outAudioLabel = `[ax${index + 1}]`;
          audioChain.push(
            `${currentAudioLabel}${nextAudioLabel}acrossfade=d=${formatNumber(
              safeAudioDuration
            )}:c1=tri:c2=tri${outAudioLabel}`
          );
          currentAudioDuration =
            currentAudioDuration + (durationsSec[nextInputIndex] ?? 0) - safeAudioDuration;
          currentAudioLabel = outAudioLabel;
          return;
        }
        const outAudioLabel = `[ac${index + 1}]`;
        audioChain.push(
          `${currentAudioLabel}${nextAudioLabel}concat=n=2:v=0:a=1${outAudioLabel}`
        );
        currentAudioDuration += durationsSec[index + 1] ?? 0;
        currentAudioLabel = outAudioLabel;
      });

      const filterParts = [baseFilter, ...audioLines];
      if (chain.length) {
        filterParts.push(chain.join(";"));
      }
      if (includeAudio && audioChain.length) {
        filterParts.push(audioChain.join(";"));
        audioOutputLabel = currentAudioLabel;
      }
      concatFilter = filterParts.filter((part) => part.trim().length > 0).join(";");
      outputLabel = currentLabel;
      assembledDurationSec = currentDuration;
    } else {
      if (durationsSec.length === inputs.length) {
        assembledDurationSec = durationsSec.reduce((sum, value) => sum + value, 0);
        if (outroPath) {
          tailSlugStartSec = durationsSec.slice(0, -1).reduce((sum, value) => sum + value, 0);
        }
      }
      const filterParts = [baseFilter, ...audioLines];
      filterParts.push(
        `${inputs.map((_, index) => `[v${index}]`).join("")}concat=n=${inputs.length}:v=1:a=0[v]`
      );
      if (includeAudio) {
        filterParts.push(
          `${inputs.map((_, index) => `[a${index}]`).join("")}concat=n=${inputs.length}:v=0:a=1[a]`
        );
        audioOutputLabel = "[a]";
      }
      concatFilter = filterParts.filter((part) => part.trim().length > 0).join(";");
      outputLabel = "[v]";
    }

    const finalWithSlug = path.join(exportDir, "final_with_slug.mp4");
    const concatArgs = [
      "-y",
      ...inputs.flatMap((input) => ["-i", input]),
      "-filter_complex",
      concatFilter,
      "-map",
      outputLabel,
      ...(includeAudio && audioOutputLabel ? ["-map", audioOutputLabel] : []),
      "-c:v",
      preset.codec,
      ...(includeAudio && audioOutputLabel ? ["-c:a", "aac", "-b:a", "192k"] : []),
      ...preset.args,
      "-pix_fmt",
      "yuv420p",
      finalWithSlug,
    ];
    await runFfmpeg(concatArgs, exportDir, onProgress, undefined, "ffmpeg-concat");
    assembledFinalPath = finalWithSlug;
    manifest.tailSlugStartSec = tailSlugStartSec;
    manifest.assembledDurationSec = assembledDurationSec;
  }

  if (project.audioTrack) {
    const audioResult = await applyExternalAudioTrack(
      project,
      exportDir,
      assembledFinalPath,
      finalPath,
      onProgress,
      { tailSlugStartSec }
    );
    manifest.assembledDurationSec = audioResult.durationSec;
    manifest.externalAudioFadeOutStartSec = audioResult.fadeOut?.startSec;
    manifest.externalAudioFadeOutEndSec = audioResult.fadeOut?.endSec;
  } else {
    await fs.copyFile(assembledFinalPath, finalPath);
  }
}

function overlayIntersectsWindow(
  overlay: Overlay,
  window: PatchWindow,
  fps: number,
  speed: 1 | 2
): boolean {
  const timing = computeOverlayTiming(overlay, fps, speed);
  return timing.visEndSec > window.startSec && timing.visStartSec < window.endSec;
}

function shiftOverlayForWindow(overlay: Overlay, sourceStartFrame: number): Overlay {
  const shiftFrame = (value: number | undefined) =>
    typeof value === "number" ? value - sourceStartFrame : undefined;
  const motion = overlay.motion
    ? {
        ...overlay.motion,
        visibleStartFrame: shiftFrame(overlay.motion.visibleStartFrame),
        visibleEndFrame: shiftFrame(overlay.motion.visibleEndFrame),
      }
    : undefined;
  return {
    ...overlay,
    startFrame: overlay.startFrame - sourceStartFrame,
    endFrame: overlay.endFrame - sourceStartFrame,
    motion,
  };
}

async function renderPatchWindow(input: {
  project: Project;
  projectForRender: Project;
  exportDir: string;
  baseSourcePath: string;
  window: PatchWindow;
  windowIndex: number;
  speed: 1 | 2;
  renderTuning: RenderTuning;
  onProgress?: (update: RenderProgress) => void;
}): Promise<string> {
  const {
    project,
    projectForRender,
    exportDir,
    baseSourcePath,
    window,
    windowIndex,
    speed,
    renderTuning,
    onProgress,
  } = input;
  const fps = projectForRender.video.fpsNum / projectForRender.video.fpsDen;
  const projectRoot = path.join(WORKSPACE_ROOT, project.id);
  const patchDir = path.join(exportDir, "patch_windows");
  await ensureDir(patchDir);
  const outputPath = path.join(patchDir, `${String(windowIndex).padStart(3, "0")}.mp4`);
  const windowDurationSec = window.endSec - window.startSec;
  const sourceStartSec = window.startSec * speed;
  const sourceDurationSec = windowDurationSec * speed;
  const sourceStartFrame = sourceStartSec * fps;

  const activeOverlays = sortOverlays(
    projectForRender.overlays.filter((overlay) =>
      overlayIntersectsWindow(overlay, window, fps, speed)
    )
  );
  const shiftedOverlays = activeOverlays.map((overlay) =>
    shiftOverlayForWindow(overlay, sourceStartFrame)
  );
  const shiftedProject: Project = {
    ...projectForRender,
    overlays: shiftedOverlays,
  };
  const preLines = [
    `[0:v]trim=start=${formatNumber(sourceStartSec)}:duration=${formatNumber(
      sourceDurationSec
    )},setpts=PTS-STARTPTS[base]`,
  ];
  const filter = buildFilterScript(
    shiftedProject,
    shiftedOverlays,
    speed,
    "[base]",
    preLines,
    0,
    {
      outputFps: renderTuning.outputFps,
      outputWidth: renderTuning.outputWidth,
      outputHeight: renderTuning.outputHeight,
      maxDurationSec: windowDurationSec,
    }
  );
  const scriptPath = path.join(patchDir, `${String(windowIndex).padStart(3, "0")}.txt`);
  await fs.writeFile(scriptPath, filter.script, "utf-8");

  const overlayInputs = activeOverlays.map((overlay) =>
    path.join(
      projectRoot,
      "render",
      isArrowOverlay(overlay) ? "arrows" : "overlays",
      `${overlay.id}.png`
    )
  );
  const missingInputs: string[] = [];
  for (const inputPath of overlayInputs) {
    if (!(await fileExists(inputPath))) missingInputs.push(inputPath);
  }
  if (missingInputs.length) {
    throw new Error(`Missing overlay assets: ${missingInputs.join(", ")}`);
  }

  const preset = EXPORT_PRESETS[renderTuning.presetId] ?? EXPORT_PRESETS[DEFAULT_PRESET_ID];
  const args = ["-y", "-i", baseSourcePath];
  for (const inputPath of overlayInputs) {
    args.push("-loop", "1", "-framerate", STATIC_OVERLAY_INPUT_FPS, "-i", inputPath);
  }
  args.push(
    "-filter_complex_script",
    scriptPath,
    "-map",
    filter.outputLabel,
    "-c:v",
    preset.codec,
    ...preset.args,
    "-pix_fmt",
    "yuv420p",
    outputPath
  );

  onProgress?.({
    stage: "patch-window",
    message: `Rendering patch window ${windowIndex + 1}`,
    percent: 0,
  });
  await runFfmpeg(args, exportDir, onProgress, windowDurationSec, "ffmpeg-patch");
  return outputPath;
}

async function stitchPatchWindows(input: {
  exportDir: string;
  baseMainPath: string;
  patchPaths: string[];
  windows: PatchWindow[];
  mainOutputPath: string;
  durationSec: number;
  presetId: string;
  includeAudio: boolean;
  onProgress?: (update: RenderProgress) => void;
}): Promise<void> {
  const {
    exportDir,
    baseMainPath,
    patchPaths,
    windows,
    mainOutputPath,
    durationSec,
    presetId,
    includeAudio,
    onProgress,
  } = input;
  const preset = EXPORT_PRESETS[presetId] ?? EXPORT_PRESETS[DEFAULT_PRESET_ID];
  const stitchedVideoPath = path.join(exportDir, "main_noslug_patched_video.mp4");
  const parts: Array<{ kind: "base"; startSec: number; endSec: number } | { kind: "patch"; index: number }> = [];
  let cursor = 0;
  for (const [index, window] of windows.entries()) {
    if (window.startSec > cursor + 0.001) {
      parts.push({ kind: "base", startSec: cursor, endSec: window.startSec });
    }
    parts.push({ kind: "patch", index });
    cursor = window.endSec;
  }
  if (cursor < durationSec - 0.001) {
    parts.push({ kind: "base", startSec: cursor, endSec: durationSec });
  }
  if (!parts.length) {
    throw new Error("No patch windows were available to stitch.");
  }

  const filterLines: string[] = [];
  const labels: string[] = [];
  parts.forEach((part, index) => {
    const label = `[sv${index}]`;
    labels.push(label);
    if (part.kind === "base") {
      filterLines.push(
        `[0:v]trim=start=${formatNumber(part.startSec)}:end=${formatNumber(
          part.endSec
        )},setpts=PTS-STARTPTS${label}`
      );
      return;
    }
    filterLines.push(`[${part.index + 1}:v]setpts=PTS-STARTPTS${label}`);
  });

  if (labels.length === 1) {
    filterLines.push(`${labels[0]}copy[v]`);
  } else {
    filterLines.push(`${labels.join("")}concat=n=${labels.length}:v=1:a=0[v]`);
  }

  onProgress?.({ stage: "stitch", message: "Stitching patch windows", percent: 0 });
  await runFfmpeg(
    [
      "-y",
      "-i",
      baseMainPath,
      ...patchPaths.flatMap((patchPath) => ["-i", patchPath]),
      "-filter_complex",
      filterLines.join(";"),
      "-map",
      "[v]",
      "-c:v",
      preset.codec,
      ...preset.args,
      "-pix_fmt",
      "yuv420p",
      stitchedVideoPath,
    ],
    exportDir,
    onProgress,
    durationSec,
    "ffmpeg-stitch"
  );

  const baseInfo = await probeVideo(baseMainPath);
  if (includeAudio && baseInfo.audio?.hasAudio) {
    await runFfmpeg(
      [
        "-y",
        "-i",
        stitchedVideoPath,
        "-i",
        baseMainPath,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "copy",
        "-shortest",
        "-movflags",
        "+faststart",
        mainOutputPath,
      ],
      exportDir,
      onProgress,
      durationSec,
      "ffmpeg-stitch-audio"
    );
    return;
  }

  await fs.copyFile(stitchedVideoPath, mainOutputPath);
}

export async function renderSurgicalPatch(
  project: Project,
  options: ExportRequest = {},
  onProgress?: (update: RenderProgress) => void
): Promise<{
  exportDir: string;
  exportId: string;
  finalPath: string;
  manifest: ExportManifest;
}> {
  const analysis = await buildSurgicalPatchAnalysis(project, options);
  if (!analysis.patchable || !analysis.latest || !analysis.projectForRender || !analysis.renderTuning) {
    throw new Error(analysis.reason ?? "Latest final export is not patchable.");
  }
  await assertRenderPresetAvailable(analysis.renderTuning.presetId);

  onProgress?.({ stage: "assets", message: "Rendering overlay assets", percent: 0 });
  await renderProjectAssets(analysis.projectForRender);

  const { exportDir, exportId, manifest, outputFrames, projectForRender, renderTuning } =
    await writeExportBundle(project, options);
  manifest.source = analysis.latest.manifest.source;
  manifest.timelineSource = analysis.latest.manifest.timelineSource;
  manifest.timelineAssetInputs = analysis.latest.manifest.timelineAssetInputs;
  manifest.patch = {
    baseExportId: analysis.latest.exportId,
    changedOverlayIds: analysis.changedOverlayIds,
    affectedWindows: analysis.affectedWindows,
  };

  const baseMainPath = resolveLatestMainOutput(analysis.latest);
  const mainOutputPath = manifest.mainOutput
    ? path.isAbsolute(manifest.mainOutput)
      ? manifest.mainOutput
      : path.join(exportDir, manifest.mainOutput)
    : path.join(exportDir, "main_noslug_patched.mp4");
  manifest.mainOutput = mainOutputPath;

  const patchPaths: string[] = [];
  for (const [index, window] of analysis.affectedWindows.entries()) {
    patchPaths.push(
      await renderPatchWindow({
        project,
        projectForRender,
        exportDir,
        baseSourcePath: analysis.latest.manifest.source,
        window,
        windowIndex: index,
        speed: analysis.speed ?? manifest.speed,
        renderTuning,
        onProgress,
      })
    );
  }

  const fps = projectForRender.video.fpsNum / projectForRender.video.fpsDen;
  const durationSec = outputFrames / fps / manifest.speed;
  await stitchPatchWindows({
    exportDir,
    baseMainPath,
    patchPaths,
    windows: analysis.affectedWindows,
    mainOutputPath,
    durationSec,
    presetId: manifest.presetId,
    includeAudio: manifest.includeAudio,
    onProgress,
  });

  const finalPath = path.join(exportDir, "final.mp4");
  await assembleFinalOutput(
    project,
    projectForRender,
    renderTuning,
    exportDir,
    mainOutputPath,
    finalPath,
    manifest,
    durationSec,
    onProgress
  );

  await fs.writeFile(
    path.join(exportDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8"
  );

  onProgress?.({ stage: "done", message: "Patch render complete", percent: 1 });
  return { exportDir, exportId, finalPath, manifest };
}

export async function renderFinal(
  project: Project,
  options: ExportRequest = {},
  onProgress?: (update: RenderProgress) => void
): Promise<{
  exportDir: string;
  exportId: string;
  finalPath: string;
  manifest: ExportManifest;
}> {
  const { exportDir, exportId, manifest, outputFrames, projectForRender, renderTuning } =
    await writeExportBundle(project, options);

  if (manifest.timelineSource) {
    onProgress?.({ stage: "timeline", message: "Rendering flattened source timeline" });
    await renderFlattenedSourceTimeline(
      project,
      exportDir,
      manifest.source,
      manifest.includeAudio,
      onProgress
    );
  }

  onProgress?.({ stage: "assets", message: "Rendering overlay assets" });
  await renderProjectAssets(projectForRender);
  const preset = EXPORT_PRESETS[manifest.presetId] ?? EXPORT_PRESETS[DEFAULT_PRESET_ID];

  const missingInputs = [];
  for (const input of [...manifest.timelineInputs, ...manifest.overlayInputs, ...manifest.arrowInputs]) {
    if (!(await fileExists(input))) {
      missingInputs.push(input);
    }
  }
  if (missingInputs.length) {
    throw new Error(`Missing overlay assets: ${missingInputs.join(", ")}`);
  }

  const hasArrows = manifest.arrowInputs.length > 0;
  const filterScript = hasArrows ? manifest.filterCardsArrows : manifest.filterCards;
  const outputLabel = hasArrows ? manifest.outputLabelCardsArrows : manifest.outputLabelCards;
  const audioLabel = hasArrows
    ? manifest.outputLabelCardsArrowsAudio
    : manifest.outputLabelCardsAudio;
  const mainOutputName = hasArrows ? "main_noslug_arrows.mp4" : "main_noslug.mp4";
  const mainOutputPath = path.join(exportDir, mainOutputName);

  const args = ["-y", "-i", manifest.source];
  for (const input of manifest.timelineInputs) {
    args.push("-i", input);
  }
  for (const input of manifest.overlayInputs) {
    args.push("-loop", "1", "-framerate", STATIC_OVERLAY_INPUT_FPS, "-i", input);
  }
  for (const input of manifest.arrowInputs) {
    args.push("-loop", "1", "-framerate", STATIC_OVERLAY_INPUT_FPS, "-i", input);
  }
  args.push(
    "-filter_complex_script",
    filterScript,
    "-map",
    outputLabel,
    ...(manifest.includeAudio && audioLabel ? ["-map", audioLabel] : []),
    "-c:v",
    preset.codec,
    ...(manifest.includeAudio && audioLabel ? ["-c:a", "aac", "-b:a", "192k"] : []),
    ...preset.args,
    "-shortest",
    "-pix_fmt",
    "yuv420p",
    mainOutputPath
  );

  const fps = project.video.fpsNum / project.video.fpsDen;
  const durationSec = outputFrames / fps / manifest.speed;
  await runFfmpeg(args, exportDir, onProgress, durationSec, "ffmpeg-main");

  const finalPath = path.join(exportDir, "final.mp4");
  await assembleFinalOutput(
    project,
    projectForRender,
    renderTuning,
    exportDir,
    mainOutputPath,
    finalPath,
    manifest,
    durationSec,
    onProgress
  );

  await fs.writeFile(
    path.join(exportDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8"
  );

  onProgress?.({ stage: "done", message: "Render complete", percent: 1 });
  return { exportDir, exportId, finalPath, manifest };
}
