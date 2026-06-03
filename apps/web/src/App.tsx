import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { DragEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Group as KonvaGroup } from "konva/lib/Group";
import type { Transformer as KonvaTransformer } from "konva/lib/shapes/Transformer";
import { Arrow, Group, Image as KonvaImage, Layer, Rect, Stage, Text, Transformer } from "react-konva";
import {
  buildArrowOverlay,
  buildCardOverlay,
  getOverlayAssetHash,
  normalizeOverlayZIndexes,
  normalizeRotation as normalizeSharedRotation,
  syncArrowVisibility,
} from "@content-tools/shared";
import {
  ApiError,
  assetUrl,
  createProject,
  deleteProject,
  deleteSlug,
  exportLatestUrl,
  getPatchStatus,
  getProject,
  getRenderCapabilities,
  importAudioAssetFromUrl,
  importProjectBundle,
  importSlugVideo,
  importVideo,
  listProjects,
  listSlugs,
  listTemplates,
  mediaUrl,
  parseSourceTimeline,
  projectBundleUrl,
  projectEventsUrl,
  patchStreamUrl,
  renderStreamUrl,
  slugMediaUrl,
  thumbnailUrl,
  updateProject,
  uploadAsset,
  uploadAudioAsset,
  type ArrowInfo,
  type AudioAsset,
  type AudioTrack,
  type Overlay,
  type Project,
  type ProjectBundleMode,
  type ProjectSummary,
  type RenderCapabilities,
  type RenderCapability,
  type SlugAsset,
  type SourceSegment,
  type SurgicalPatchStatus,
  type TemplateInfo,
} from "./api";

const DEFAULT_CARD_SIZE = { w: 1100, h: 180 };
const DEFAULT_ARROW_SIZE = { w: 128, h: 128 };

const DEFAULT_PRESET_ID = "balanced";
const DEFAULT_CROSSFADE_FRAMES = 12;
const RENDER_PRESET_OPTIONS: Array<{
  id: string;
  label: string;
  requiresCapability?: RenderCapability;
}> = [
  { id: "balanced", label: "Balanced (CPU)" },
  { id: "quality", label: "High quality (CPU)" },
  { id: "nvencP5Cq20", label: "NVENC P5 CQ20", requiresCapability: "nvenc" },
];
const RENDER_MODE_OPTIONS = [
  { id: "final", label: "Final" },
  { id: "rough", label: "Rough preview (fast)" },
];

const FALLBACK_TEMPLATES = [
  { id: "card-lower-third-left", label: "Lower Third Left" },
  { id: "card-lower-third-right", label: "Lower Third Right" },
  { id: "card-lower-third-center", label: "Lower Third Center" },
  { id: "card-top-third-left", label: "Top Third Left" },
  { id: "card-top-third-right", label: "Top Third Right" },
  { id: "card-title-top", label: "Title Top" },
  { id: "card-callout-right", label: "Callout Right" },
  { id: "card-chapter-center", label: "Chapter Center" },
  { id: "card-corner-tag-top-right", label: "Corner Tag Top Right" },
  { id: "card-bug-bottom-right", label: "Bug Bottom Right" },
];

function isArrow(overlay: Overlay) {
  return overlay.templateId.startsWith("arrow");
}

function getOverlayVisibleRange(overlay: Overlay) {
  const motion = overlay.motion ?? {};
  const startFrame = overlay.startFrame;
  const slideInFrames = motion.slideInFrames ?? 0;
  const slideOutFrames = motion.slideOutFrames ?? 0;
  const displayFrames = motion.displayFrames;
  let derivedEndFrame = overlay.endFrame;

  if (!isArrow(overlay) && typeof displayFrames === "number") {
    derivedEndFrame = startFrame + slideInFrames + displayFrames + slideOutFrames;
  }

  const visibleStartFrame = motion.visibleStartFrame ?? startFrame;
  const visibleEndFrame = motion.visibleEndFrame ?? derivedEndFrame;
  return {
    start: formatFrame(visibleStartFrame),
    end: formatFrame(visibleEndFrame),
  };
}

function isOverlayVisibleAtFrame(overlay: Overlay, frame: number) {
  const range = getOverlayVisibleRange(overlay);
  if (range.end < range.start) return false;
  return frame >= range.start && frame <= range.end;
}

function getFps(project: Project | null) {
  if (!project) return 30;
  return project.video.fpsDen === 0 ? 30 : project.video.fpsNum / project.video.fpsDen;
}

function formatFrame(frame: number) {
  return Math.max(0, Math.floor(frame));
}

function formatTimecode(frames: number, fps: number) {
  if (!Number.isFinite(fps) || fps <= 0) return "00:00:00.000";
  const totalMillis = Math.max(0, Math.round((frames / fps) * 1000));
  const hours = Math.floor(totalMillis / 3600000);
  const minutes = Math.floor((totalMillis % 3600000) / 60000);
  const seconds = Math.floor((totalMillis % 60000) / 1000);
  const millis = totalMillis % 1000;
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
}

function formatSeconds(seconds: number) {
  if (!Number.isFinite(seconds)) return "0.000s";
  return `${Math.max(0, seconds).toFixed(3)}s`;
}

function getSourceSegmentOutputFrames(segment: SourceSegment): number {
  if (segment.kind === "image") {
    return Math.max(1, segment.durationFrames ?? 1);
  }
  const sourceFrames = Math.max(1, segment.endFrameExclusive - segment.startFrame);
  return Math.max(1, Math.round(sourceFrames / Math.max(0.01, segment.playbackRate)));
}

function mapSourceFrameToOutputFrame(segments: SourceSegment[], frame: number): number | null {
  let outputStart = 0;
  for (const segment of segments) {
    const outputFrames = getSourceSegmentOutputFrames(segment);
    if (
      segment.kind === "source" &&
      frame >= segment.startFrame &&
      frame < segment.endFrameExclusive
    ) {
      return Math.floor(
        outputStart + (frame - segment.startFrame) / Math.max(0.01, segment.playbackRate)
      );
    }
    outputStart += outputFrames;
  }
  return null;
}

function getMappedOverlayRange(overlay: Overlay, segments: SourceSegment[]) {
  const start = mapSourceFrameToOutputFrame(segments, overlay.startFrame);
  const end = mapSourceFrameToOutputFrame(segments, Math.max(overlay.startFrame, overlay.endFrame - 1));
  if (start === null || end === null) return null;
  return { start, end: Math.max(start, end) };
}

function pathBasename(inputPath: string) {
  return inputPath.split("/").filter(Boolean).at(-1) ?? inputPath;
}

function parseTimecode(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(":").map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part))) return null;
  if (parts.length === 1) {
    return parts[0];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return null;
}

const TIMECODE_COMPLETE_REGEX = /^\d{2,}:\d{2}:\d{2}(?:\.\d{1,3})?$/;
const TEXT_ALIGNMENTS = ["left", "center", "right"] as const;
type TextAlignment = (typeof TEXT_ALIGNMENTS)[number];
type ProjectEdits = NonNullable<Project["edits"]>;
type ProjectCut = NonNullable<ProjectEdits["cuts"]>[number];

const DEFAULT_TITLE_SCALE = 0.95;
const DEFAULT_TEXT_SCALE = 1;
const BASE_TITLE_OFFSET = -13;
const BASE_TEXT_OFFSET = -27;
const OFFSET_MODE_KEY = "offsetMode";
const OFFSET_MODE_DELTA = "delta-v1";
const AUTOSAVE_ENABLED_KEY = "content-tools-studio.autosave.enabled";
const AUTOSAVE_INTERVAL_KEY = "content-tools-studio.autosave.intervalSeconds";
const DEFAULT_AUTOSAVE_INTERVAL_SEC = 10;
const MIN_AUTOSAVE_INTERVAL_SEC = 5;
const MAX_AUTOSAVE_INTERVAL_SEC = 300;

const TEMPLATE_ALIGNMENTS: Record<string, TextAlignment> = {
  "card-lower-third-left": "left",
  "card-top-third-left": "left",
  "card-lower-third-right": "right",
  "card-top-third-right": "right",
  "card-callout-right": "right",
  "card-corner-tag-top-right": "right",
  "card-bug-bottom-right": "right",
  "card-lower-third-center": "center",
  "card-title-top": "center",
  "card-chapter-center": "center",
};

function parseCompleteTimecode(value: string): number | null {
  const trimmed = value.trim();
  if (!TIMECODE_COMPLETE_REGEX.test(trimmed)) return null;
  return parseTimecode(trimmed);
}

function resolveTextAlign(value: unknown, fallback: TextAlignment): TextAlignment {
  if (typeof value === "string" && (TEXT_ALIGNMENTS as readonly string[]).includes(value)) {
    return value as TextAlignment;
  }
  return fallback;
}

function resolveTemplateAlign(templateId: string, template?: TemplateInfo | null): TextAlignment {
  if (template?.align) return template.align;
  const fallback = TEMPLATE_ALIGNMENTS[templateId];
  if (fallback) return fallback;
  if (templateId.includes("center")) return "center";
  if (templateId.includes("right")) return "right";
  return "left";
}

function getDefaultTextMargins(align: TextAlignment) {
  if (align === "left") {
    return { left: 34, right: 150 };
  }
  if (align === "right") {
    return { left: 150, right: 34 };
  }
  return { left: 34, right: 34 };
}

function resolveTextScale(value: unknown, fallback = 1) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(2, Math.max(0.5, numeric));
}

function resolveTextMargin(value: unknown, fallback = 0) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(0, Math.min(400, numeric));
}

function resolveTextOffset(value: unknown, fallback = 0) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(-400, Math.min(400, numeric));
}

function coerceOffsetDelta(value: unknown, base: number) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return resolveTextOffset(numeric - base, 0);
}

function normalizeOverlayOffsets(overlays: Overlay[]): Overlay[] {
  let updated = false;
  const next = overlays.map((overlay) => {
    if (isArrow(overlay)) return overlay;
    const fields = overlay.fields ?? {};
    if (fields[OFFSET_MODE_KEY] === OFFSET_MODE_DELTA) {
      return overlay;
    }
    const titleDelta = coerceOffsetDelta(fields.titleOffsetY, BASE_TITLE_OFFSET);
    const textDelta = coerceOffsetDelta(fields.textOffsetY, BASE_TEXT_OFFSET);
    updated = true;
    return {
      ...overlay,
      fields: {
        ...fields,
        titleOffsetY: titleDelta,
        textOffsetY: textDelta,
        [OFFSET_MODE_KEY]: OFFSET_MODE_DELTA,
      },
    };
  });
  return updated ? next : overlays;
}

function cloneProjectState(value: Project): Project {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as Project;
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === null) return fallback;
    return stored === "true";
  } catch {
    return fallback;
  }
}

function readStoredNumber(key: string, fallback: number): number {
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === null) return fallback;
    const value = Number(stored);
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function clampAutosaveInterval(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_AUTOSAVE_INTERVAL_SEC;
  return Math.min(MAX_AUTOSAVE_INTERVAL_SEC, Math.max(MIN_AUTOSAVE_INTERVAL_SEC, Math.round(value)));
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error("Unable to create overlay PNG."));
    }, "image/png");
  });
}

function wrapCanvasLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push("");
      continue;
    }

    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth || !current) {
        if (ctx.measureText(candidate).width <= maxWidth) {
          current = candidate;
          continue;
        }

        let chunk = "";
        for (const char of word) {
          const nextChunk = `${chunk}${char}`;
          if (ctx.measureText(nextChunk).width > maxWidth && chunk) {
            lines.push(chunk);
            chunk = char;
          } else {
            chunk = nextChunk;
          }
        }
        current = chunk;
        continue;
      }

      lines.push(current);
      current = word;
    }

    if (current) lines.push(current);
  }
  return lines;
}

function drawWrappedCanvasText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  width: number,
  lineHeight: number,
  align: TextAlignment
) {
  ctx.textAlign = align;
  ctx.textBaseline = "top";
  const drawX = align === "center" ? x + width / 2 : align === "right" ? x + width : x;
  const lines = wrapCanvasLines(ctx, text, width);
  lines.forEach((line, index) => {
    ctx.fillText(line, drawX, y + index * lineHeight);
  });
}

async function renderOverlayBlob(
  overlay: Overlay,
  template: TemplateInfo | undefined,
  loadImage: (url: string) => Promise<HTMLImageElement>,
  arrowTemplate?: ArrowInfo | null
): Promise<Blob> {
  const width = Math.max(1, Math.floor(overlay.rect.w));
  const height = Math.max(1, Math.floor(overlay.rect.h));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to create overlay canvas.");
  context.clearRect(0, 0, width, height);

  if (isArrow(overlay)) {
    if (arrowTemplate) {
      const image = await loadImage(assetUrl(arrowTemplate.imagePath));
      context.save();
      context.translate(width / 2, height / 2);
      context.rotate(((overlay.rotationDeg ?? 0) * Math.PI) / 180);
      context.drawImage(image, -width / 2, -height / 2, width, height);
      context.restore();
    }
    return canvasToBlob(canvas);
  }

  if (template) {
    const image = await loadImage(assetUrl(template.imagePath));
    context.drawImage(
      image,
      template.bounds.left,
      template.bounds.top,
      template.bounds.width,
      template.bounds.height,
      0,
      0,
      width,
      height
    );
  } else {
    context.fillStyle = "rgba(15, 19, 24, 0.65)";
    context.fillRect(0, 0, width, height);
  }

  const templateAlign = resolveTemplateAlign(overlay.templateId, template);
  const textAlign = resolveTextAlign(overlay.fields.textAlign, templateAlign);
  const textScale = resolveTextScale(overlay.fields.textScale, DEFAULT_TEXT_SCALE);
  const titleScale = resolveTextScale(overlay.fields.titleScale, DEFAULT_TITLE_SCALE);
  const titleOffset = BASE_TITLE_OFFSET + resolveTextOffset(overlay.fields.titleOffsetY, 0);
  const textOffset = BASE_TEXT_OFFSET + resolveTextOffset(overlay.fields.textOffsetY, 0);
  const baseMargins = getDefaultTextMargins(templateAlign);
  const marginLeft = resolveTextMargin(overlay.fields.textMarginLeft, baseMargins.left);
  const marginRight = resolveTextMargin(overlay.fields.textMarginRight, baseMargins.right);
  const textWidth = Math.max(40, width - marginLeft - marginRight);
  const titleSize = Math.max(14, height * 0.3 * titleScale);
  const subtitleSize = Math.max(12, height * 0.18 * textScale);

  context.fillStyle = template?.title?.color ?? "#f5f2ea";
  context.font = `${titleSize}px Arial`;
  drawWrappedCanvasText(
    context,
    String(overlay.fields.title ?? ""),
    marginLeft,
    Math.max(8, height * 0.18) + titleOffset,
    textWidth,
    titleSize,
    "center"
  );

  context.fillStyle = template?.subtitle?.color ?? "#d1c7b8";
  context.font = `${subtitleSize}px Arial`;
  drawWrappedCanvasText(
    context,
    String(overlay.fields.text ?? overlay.fields.subtitle ?? ""),
    marginLeft,
    Math.max(8, height * 0.55) + textOffset,
    textWidth,
    subtitleSize,
    textAlign
  );

  return canvasToBlob(canvas);
}

type StageMetrics = {
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
};

type HistoryEntry = {
  project: Project;
  selectedOverlayId: string | null;
  currentFrame: number;
};

export default function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [videoDurationSec, setVideoDurationSec] = useState(0);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [renderOptions, setRenderOptions] = useState({
    renderMode: "final" as "final" | "rough",
    speed: 1 as 1 | 2,
    includeAudio: true,
    includeSlugStart: false,
    includeSlugEnd: false,
    presetId: DEFAULT_PRESET_ID,
  });
  const [renderProgress, setRenderProgress] = useState<number | null>(null);
  const [renderLogs, setRenderLogs] = useState<string[]>([]);
  const [renderActive, setRenderActive] = useState(false);
  const [renderReady, setRenderReady] = useState(false);
  const [renderFinalPath, setRenderFinalPath] = useState("");
  const [renderCapabilities, setRenderCapabilities] = useState<RenderCapabilities | null>(null);
  const [renderCapabilitiesError, setRenderCapabilitiesError] = useState<string | null>(null);
  const [patchStatus, setPatchStatus] = useState<SurgicalPatchStatus | null>(null);
  const [patchStatusLoading, setPatchStatusLoading] = useState(false);
  const [leftTab, setLeftTab] = useState<"media" | "overlays" | "exports">("media");
  const [bundleMode, setBundleMode] = useState<ProjectBundleMode>("project-media");
  const [thumbnailError, setThumbnailError] = useState<string | null>(null);
  const [templateLibrary, setTemplateLibrary] = useState<TemplateInfo[]>([]);
  const [arrowLibrary, setArrowLibrary] = useState<ArrowInfo[]>([]);
  const [slugLibrary, setSlugLibrary] = useState<SlugAsset[]>([]);
  const [audioUrlInput, setAudioUrlInput] = useState("");
  const [templateImages, setTemplateImages] = useState<Record<string, HTMLImageElement>>({});
  const [arrowImage, setArrowImage] = useState<HTMLImageElement | null>(null);
  const [showHotkeys, setShowHotkeys] = useState(false);
  const [trimStartTime, setTrimStartTime] = useState("00:00:00.000");
  const [trimEndTime, setTrimEndTime] = useState("00:00:00.000");
  const [sourceTimelineText, setSourceTimelineText] = useState("");
  const [sourceTimelineWarnings, setSourceTimelineWarnings] = useState<string[]>([]);
  const [sourceTimelineOutput, setSourceTimelineOutput] = useState<{
    outputDurationSeconds: number;
    outputFrames: number;
  } | null>(null);
  const [sourceSegmentsOpen, setSourceSegmentsOpen] = useState(false);
  const [editorCenterHeight, setEditorCenterHeight] = useState<number | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [externalUpdateAvailable, setExternalUpdateAvailable] = useState(false);
  const [autosaveEnabled, setAutosaveEnabled] = useState(() =>
    readStoredBoolean(AUTOSAVE_ENABLED_KEY, true)
  );
  const [autosaveIntervalSec, setAutosaveIntervalSec] = useState(() =>
    clampAutosaveInterval(readStoredNumber(AUTOSAVE_INTERVAL_KEY, DEFAULT_AUTOSAVE_INTERVAL_SEC))
  );
  const [autosavePausedProjectId, setAutosavePausedProjectId] = useState<string | null>(null);
  const [lastAutosaveAt, setLastAutosaveAt] = useState<string | null>(null);
  const isPlayingRef = useRef(false);
  const currentFrameRef = useRef(0);
  const totalFramesRef = useRef(0);
  const isDirtyRef = useRef(false);
  const projectRef = useRef<Project | null>(null);
  const autosaveInFlightRef = useRef(false);
  const renderAssetImageCacheRef = useRef<Map<string, Promise<HTMLImageElement>>>(new Map());
  const historyRef = useRef<{ past: HistoryEntry[]; future: HistoryEntry[] }>({
    past: [],
    future: [],
  });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRefs = useRef<Record<string, KonvaGroup>>({});
  const transformerRef = useRef<KonvaTransformer | null>(null);
  const videoWrapperRef = useRef<HTMLDivElement | null>(null);
  const editorCenterRef = useRef<HTMLElement | null>(null);
  const [stageMetrics, setStageMetrics] = useState<StageMetrics>({
    width: 0,
    height: 0,
    scaleX: 1,
    scaleY: 1,
  });

  const editorGridStyle: CSSProperties | undefined = editorCenterHeight
    ? ({ "--editor-center-height": `${editorCenterHeight}px` } as CSSProperties)
    : undefined;
  const previewPaneStyle: CSSProperties | undefined = project
    ? ({
        "--preview-aspect-ratio": `${project.video.width} / ${project.video.height}`,
        "--preview-aspect-value": project.video.width / project.video.height,
      } as CSSProperties)
    : undefined;

  const fps = useMemo(() => getFps(project), [project]);
  const hasMedia = useMemo(() => {
    if (!project) return false;
    return project.video.durationMs > 0 && Boolean(project.source?.filename);
  }, [project]);
  const totalFrames = useMemo(() => {
    if (project?.video.durationMs && hasMedia) {
      return Math.max(1, Math.floor((project.video.durationMs / 1000) * fps));
    }
    return Math.max(1, Math.floor(videoDurationSec * fps));
  }, [project, fps, videoDurationSec, hasMedia]);

  const selectedOverlay =
    project?.overlays.find((overlay) => overlay.id === selectedOverlayId) ?? null;
  const selectedSlugPath = project?.slug?.introPath ?? project?.slug?.outroPath ?? "";
  const selectedSlugOption =
    slugLibrary.find((option) => option.path === selectedSlugPath) ?? null;
  const slugTransition = project?.slug?.transition ?? {
    type: "cut" as const,
    durationFrames: 0,
  };
  const isRoughPreview = renderOptions.renderMode === "rough";
  const presetStatusMap = useMemo(() => {
    const entries = (renderCapabilities?.presets ?? []).map((preset) => [preset.id, preset] as const);
    return Object.fromEntries(entries);
  }, [renderCapabilities]);
  const selectedPresetId = renderOptions.presetId ?? DEFAULT_PRESET_ID;
  const selectedPresetStatus = presetStatusMap[selectedPresetId];
  const selectedPresetOption = RENDER_PRESET_OPTIONS.find((preset) => preset.id === selectedPresetId);
  const selectedPresetUnavailable =
    !isRoughPreview &&
    Boolean(
      selectedPresetOption?.requiresCapability &&
        (!selectedPresetStatus || !selectedPresetStatus.available)
    );
  const renderPresetOptions = useMemo(
    () =>
      RENDER_PRESET_OPTIONS.map((preset) => {
        const status = presetStatusMap[preset.id];
        const unavailable = Boolean(
          preset.requiresCapability && (!status || !status.available)
        );
        return {
          ...preset,
          unavailable,
          reason: status?.reason,
          label: unavailable ? `${preset.label} (unavailable)` : preset.label,
        };
      }),
    [presetStatusMap]
  );
  const hardwarePresetMessage = renderCapabilitiesError
    ? `Hardware preset check failed: ${renderCapabilitiesError}`
    : renderCapabilities?.capabilities.nvenc?.available
      ? "NVENC available."
      : renderCapabilities?.capabilities.nvenc?.reason
        ? `NVENC unavailable: ${renderCapabilities.capabilities.nvenc.reason}`
        : "Checking hardware presets...";
  const hasAudio = project?.video?.audio?.hasAudio ?? false;
  const edits = project?.edits ?? {
    trimStartFrames: 0,
    trimEndFrames: 0,
    cuts: [],
    sourceSegments: [],
  };
  const sourceSegments = edits.sourceSegments ?? [];
  const hasSourceSegments = sourceSegments.length > 0;
  const sourceSegmentsOutput = useMemo(() => {
    const outputFrames = sourceSegments.reduce((sum, segment) => {
      if (segment.kind === "image") {
        return sum + Math.max(1, segment.durationFrames ?? 1);
      }
      const sourceFrames = Math.max(1, segment.endFrameExclusive - segment.startFrame);
      return sum + Math.max(1, Math.round(sourceFrames / Math.max(0.01, segment.playbackRate)));
    }, 0);
    return { outputFrames, seconds: outputFrames / fps };
  }, [sourceSegments, fps]);
  const trimRange = useMemo(() => {
    const start = edits.trimStartFrames ?? 0;
    const end = totalFrames - (edits.trimEndFrames ?? 0);
    return clampTrimRange(start, end);
  }, [edits.trimStartFrames, edits.trimEndFrames, totalFrames]);
  const fullDurationTime = useMemo(
    () => formatTimecode(totalFrames, fps),
    [totalFrames, fps]
  );
  const parsedTrimStart = useMemo(
    () => parseCompleteTimecode(trimStartTime),
    [trimStartTime]
  );
  const parsedTrimEnd = useMemo(() => parseCompleteTimecode(trimEndTime), [trimEndTime]);
  const trimInvalid =
    parsedTrimStart !== null &&
    parsedTrimEnd !== null &&
    parsedTrimEnd <= parsedTrimStart;
  const templateMap = useMemo(() => {
    const entries = templateLibrary.map((template) => [template.id, template] as const);
    return Object.fromEntries(entries);
  }, [templateLibrary]);
  const templateOptions = templateLibrary.length ? templateLibrary : FALLBACK_TEMPLATES;
  const arrowTemplate = arrowLibrary[0] ?? null;
  const isArrowSelected = selectedOverlay ? isArrow(selectedOverlay) : false;
  const selectedTemplate = selectedOverlay ? templateMap[selectedOverlay.templateId] : null;
  const selectedTemplateAlign = selectedOverlay
    ? resolveTemplateAlign(selectedOverlay.templateId, selectedTemplate)
    : "left";
  const selectedTextAlign = selectedOverlay
    ? resolveTextAlign(selectedOverlay.fields.textAlign, selectedTemplateAlign)
    : "left";
  const selectedTextScale = selectedOverlay
    ? resolveTextScale(selectedOverlay.fields.textScale, DEFAULT_TEXT_SCALE)
    : DEFAULT_TEXT_SCALE;
  const selectedTextScalePercent = Math.round(selectedTextScale * 100);
  const selectedTitleScale = selectedOverlay
    ? resolveTextScale(selectedOverlay.fields.titleScale, DEFAULT_TITLE_SCALE)
    : DEFAULT_TITLE_SCALE;
  const selectedTitleScalePercent = Math.round(selectedTitleScale * 100);
  const selectedTitleOffset = selectedOverlay
    ? resolveTextOffset(selectedOverlay.fields.titleOffsetY, 0)
    : 0;
  const selectedTextMargins = getDefaultTextMargins(selectedTemplateAlign);
  const selectedTextMarginLeft = selectedOverlay
    ? resolveTextMargin(selectedOverlay.fields.textMarginLeft, selectedTextMargins.left)
    : selectedTextMargins.left;
  const selectedTextMarginRight = selectedOverlay
    ? resolveTextMargin(selectedOverlay.fields.textMarginRight, selectedTextMargins.right)
    : selectedTextMargins.right;
  const selectedTextOffset = selectedOverlay
    ? resolveTextOffset(selectedOverlay.fields.textOffsetY, 0)
    : 0;

  const thumbnailFrames = useMemo(() => {
    const count = 8;
    return Array.from({ length: count }, (_: unknown, index: number) =>
      Math.floor((index / Math.max(1, count - 1)) * (totalFrames - 1))
    );
  }, [totalFrames]);

  const downloadUrl = selectedId ? exportLatestUrl(selectedId) : "";
  const canPatchLatestFinal =
    Boolean(project) &&
    !renderActive &&
    !isRoughPreview &&
    !selectedPresetUnavailable &&
    (isDirty || Boolean(patchStatus?.patchable));
  const patchStatusMessage = isRoughPreview
    ? "Patch latest final is unavailable in rough preview mode."
    : isDirty
      ? "Save changes to check whether latest final can be patched."
      : patchStatusLoading
        ? "Checking latest final patch status..."
        : patchStatus?.patchable
          ? `Patch ${patchStatus.changedOverlayIds.length} overlay${patchStatus.changedOverlayIds.length === 1 ? "" : "s"} across ${patchStatus.affectedWindows.length} window${patchStatus.affectedWindows.length === 1 ? "" : "s"}.`
          : patchStatus?.reason ?? "Run a final render before patching.";

  useEffect(() => {
    if (!selectedId || !project || isDirty || isRoughPreview) {
      setPatchStatus(null);
      setPatchStatusLoading(false);
      return;
    }
    let cancelled = false;
    setPatchStatusLoading(true);
    getPatchStatus(selectedId, renderOptions)
      .then((nextStatus) => {
        if (!cancelled) setPatchStatus(nextStatus);
      })
      .catch((error) => {
        if (!cancelled) {
          setPatchStatus({
            patchable: false,
            reason: (error as Error).message,
            changedOverlayIds: [],
            affectedWindows: [],
          });
        }
      })
      .finally(() => {
        if (!cancelled) setPatchStatusLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, project?.revision, renderOptions, isDirty, isRoughPreview]);

  const showToast = useCallback((message: string) => {
    setToast(message);
  }, []);

  function loadRenderImage(url: string): Promise<HTMLImageElement> {
    const cached = renderAssetImageCacheRef.current.get(url);
    if (cached) return cached;
    const promise = new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new window.Image();
      image.crossOrigin = "anonymous";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Unable to load render asset: ${url}`));
      image.src = url;
    });
    renderAssetImageCacheRef.current.set(url, promise);
    return promise;
  }

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    let cancelled = false;
    getRenderCapabilities()
      .then((capabilities) => {
        if (cancelled) return;
        setRenderCapabilities(capabilities);
        setRenderCapabilitiesError(null);
      })
      .catch((error) => {
        if (!cancelled) setRenderCapabilitiesError((error as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!renderCapabilities || isRoughPreview) return;
    const current = renderCapabilities.presets.find((preset) => preset.id === selectedPresetId);
    if (!current || current.available) return;
    setRenderOptions((prev) =>
      (prev.presetId ?? DEFAULT_PRESET_ID) === selectedPresetId
        ? { ...prev, presetId: DEFAULT_PRESET_ID }
        : prev
    );
    setStatus(`${current.label} unavailable; using Balanced (CPU).`);
  }, [renderCapabilities, isRoughPreview, selectedPresetId]);

  useEffect(() => {
    try {
      window.localStorage.setItem(AUTOSAVE_ENABLED_KEY, String(autosaveEnabled));
    } catch {
      return;
    }
  }, [autosaveEnabled]);

  useEffect(() => {
    try {
      window.localStorage.setItem(AUTOSAVE_INTERVAL_KEY, String(autosaveIntervalSec));
    } catch {
      return;
    }
  }, [autosaveIntervalSec]);

  async function refreshProjects(nextSelectedId?: string) {
    const list = await listProjects();
    setProjects(list);
    if (nextSelectedId) {
      setSelectedId(nextSelectedId);
      return;
    }
    if (list.length && !selectedId) {
      setSelectedId(list[0].id);
    }
  }

  async function refreshSlugs() {
    const slugs = await listSlugs();
    setSlugLibrary(slugs);
  }

  useEffect(() => {
    refreshProjects();
  }, []);

  useEffect(() => {
    listTemplates()
      .then((data) => {
        setTemplateLibrary(data.templates);
        setArrowLibrary(data.arrows);
      })
      .catch((error: unknown) => setStatus((error as Error).message));
    refreshSlugs().catch((error: unknown) => setStatus((error as Error).message));
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setProject(null);
      setSelectedOverlayId(null);
      setIsDirty(false);
      setExternalUpdateAvailable(false);
      setAutosavePausedProjectId(null);
      setLastAutosaveAt(null);
      setSourceSegmentsOpen(false);
      historyRef.current = { past: [], future: [] };
      return;
    }
    setThumbnailError(null);
    getProject(selectedId)
      .then((data: Project) => {
        const normalizedOverlays = normalizeOverlayOffsets(data.overlays);
        const normalizedProject =
          normalizedOverlays === data.overlays ? data : { ...data, overlays: normalizedOverlays };
        setProject(normalizedProject);
        setSelectedOverlayId(normalizedProject.overlays[0]?.id ?? null);
        setIsDirty(false);
        setExternalUpdateAvailable(false);
        setAutosavePausedProjectId(null);
        setLastAutosaveAt(null);
        setSourceSegmentsOpen(false);
        historyRef.current = { past: [], future: [] };
      })
      .catch((error: unknown) => setStatus((error as Error).message));
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    const events = new EventSource(projectEventsUrl(selectedId));

    const refreshFromEvent = (event: MessageEvent<string>) => {
      try {
        const data = JSON.parse(event.data) as {
          revision?: number;
          source?: string;
          actor?: string;
          summary?: string;
        };
        const currentRevision = projectRef.current?.revision ?? 0;
        if (data.source === "snapshot" || !data.revision || data.revision <= currentRevision) {
          return;
        }
        const message =
          data.summary ??
          (data.actor === "agent"
            ? "Agent updated the project."
            : "Project refreshed from external update.");
        if (isDirtyRef.current) {
          setExternalUpdateAvailable(true);
          setStatus("External project update available. Save will reload the latest version on conflict.");
          showToast(message);
          return;
        }
        getProject(selectedId)
          .then((latest) => {
            setProject(latest);
            setExternalUpdateAvailable(false);
            setStatus(message);
            showToast(message);
          })
          .catch((error: unknown) => setStatus((error as Error).message));
      } catch {
        return;
      }
    };

    events.addEventListener("project-updated", refreshFromEvent);
    events.addEventListener("project-deleted", () => {
      refreshProjects();
      setProject(null);
      setSelectedOverlayId(null);
      setSourceSegmentsOpen(false);
      setStatus("Selected project was deleted externally.");
      showToast("Selected project was deleted externally.");
    });
    events.onerror = () => {
      events.close();
    };

    return () => events.close();
  }, [selectedId, showToast]);

  useEffect(() => {
    setRenderReady(false);
    setRenderFinalPath("");
  }, [selectedId]);

  useEffect(() => {
    if (!project) return;
    const includeSlugStart =
      project.exportOptions?.includeSlugStart ?? project.exportOptions?.includeSlug ?? false;
    const includeSlugEnd =
      project.exportOptions?.includeSlugEnd ?? project.exportOptions?.includeSlug ?? false;
    const nextIncludeAudio =
      typeof project.exportOptions?.includeAudio === "boolean"
        ? project.exportOptions.includeAudio
        : project.video?.audio?.hasAudio ?? false;
    setRenderOptions((prev) => ({
      ...prev,
      speed: project.exportOptions?.speed ?? prev.speed,
      includeAudio: nextIncludeAudio,
      includeSlugStart,
      includeSlugEnd,
      presetId: project.lastExportPresetId ?? DEFAULT_PRESET_ID,
    }));
  }, [project?.id]);

  useEffect(() => {
    if (!project) return;
    setTrimStartTime(formatTimecode(trimRange.start, fps));
    setTrimEndTime(formatTimecode(trimRange.end, fps));
  }, [project?.id, trimRange.start, trimRange.end, fps]);

  useEffect(() => {
    currentFrameRef.current = currentFrame;
  }, [currentFrame]);

  useEffect(() => {
    totalFramesRef.current = totalFrames;
  }, [totalFrames]);

  useEffect(() => {
    isDirtyRef.current = isDirty;
  }, [isDirty]);

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  useEffect(() => {
    if (!autosaveEnabled) return;
    if (!selectedId || !project || !isDirty) return;
    if (externalUpdateAvailable || renderActive || autosavePausedProjectId === selectedId) return;

    const timer = window.setTimeout(() => {
      if (autosaveInFlightRef.current) return;
      const currentProject = projectRef.current;
      if (!currentProject || !isDirtyRef.current) return;
      autosaveInFlightRef.current = true;
      saveProjectDocument(selectedId, currentProject, "autosave").finally(() => {
        autosaveInFlightRef.current = false;
      });
    }, autosaveIntervalSec * 1000);

    return () => window.clearTimeout(timer);
  }, [
    autosaveEnabled,
    autosaveIntervalSec,
    selectedId,
    project,
    isDirty,
    externalUpdateAvailable,
    renderActive,
    autosavePausedProjectId,
  ]);

  useEffect(() => {
    if (!templateLibrary.length) return;
    templateLibrary.forEach((template) => {
      if (templateImages[template.id]) return;
      const image = new window.Image();
      image.crossOrigin = "anonymous";
      image.src = assetUrl(template.imagePath);
      image.onload = () => {
        setTemplateImages((prev) => {
          if (prev[template.id]) return prev;
          return { ...prev, [template.id]: image };
        });
      };
    });
  }, [templateLibrary, templateImages]);

  useEffect(() => {
    if (!arrowTemplate) return;
    const nextUrl = assetUrl(arrowTemplate.imagePath);
    if (arrowImage?.src === nextUrl) return;
    const image = new window.Image();
    image.crossOrigin = "anonymous";
    image.src = nextUrl;
    image.onload = () => {
      setArrowImage(image);
    };
  }, [arrowTemplate, arrowImage]);

  useLayoutEffect(() => {
    if (!project || !videoRef.current) return;
    const element = videoRef.current;

    const update = () => {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const scaleX = rect.width / project.video.width;
      const scaleY = rect.height / project.video.height;
      setStageMetrics({ width: rect.width, height: rect.height, scaleX, scaleY });
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [project]);

  useLayoutEffect(() => {
    const element = editorCenterRef.current;
    if (!element) return;

    const update = () => {
      const nextHeight = Math.round(element.getBoundingClientRect().height);
      if (!nextHeight) return;
      setEditorCenterHeight((prev) => (prev === nextHeight ? prev : nextHeight));
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!transformerRef.current) return;
    if (!selectedOverlayId || !selectedOverlay) {
      transformerRef.current.nodes([]);
      transformerRef.current.getLayer()?.batchDraw();
      return;
    }
    const node = overlayRefs.current[selectedOverlayId];
    transformerRef.current.nodes(node ? [node] : []);
    transformerRef.current.getLayer()?.batchDraw();
  }, [selectedOverlayId, selectedOverlay, stageMetrics]);

  const seekToFrame = useCallback((frame: number, pause = true) => {
    const nextFrame = Math.max(0, Math.min(totalFramesRef.current - 1, formatFrame(frame)));
    const video = videoRef.current;
    if (pause) {
      video?.pause();
      isPlayingRef.current = false;
    }
    if (video && Number.isFinite(fps) && fps > 0) {
      const nextTime = nextFrame / fps;
      if (Math.abs(video.currentTime - nextTime) > 0.001) {
        video.currentTime = nextTime;
      }
    }
    currentFrameRef.current = nextFrame;
    setCurrentFrame(nextFrame);
  }, [fps]);

  async function handleCreate() {
    if (!nameInput.trim()) return;
    setStatus("Creating project...");
    try {
      const created = await createProject(nameInput.trim());
      setNameInput("");
      await refreshProjects(created.id);
      setStatus(`Created ${created.name}.`);
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  async function handleDeleteProject(id: string, name: string) {
    const confirmed = window.confirm(`Delete project "${name}"? This removes its workspace data.`);
    if (!confirmed) return;
    setStatus("Deleting project...");
    try {
      await deleteProject(id);
      if (selectedId === id) {
        setSelectedId(null);
        setProject(null);
        setSelectedOverlayId(null);
        historyRef.current = { past: [], future: [] };
      }
      await refreshProjects();
      setStatus(`Deleted ${name}.`);
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  async function handleImport(file: File) {
    if (!selectedId) {
      setStatus("Select a project first.");
      return;
    }
    setStatus("Uploading video and probing metadata...");
    try {
      await importVideo(selectedId, file);
      await refreshProjects(selectedId);
      const updated = await getProject(selectedId);
      setProject(updated);
      setSelectedOverlayId(updated.overlays[0]?.id ?? null);
      historyRef.current = { past: [], future: [] };
      setStatus(`Imported ${file.name}.`);
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  async function handleImportBundle(file: File) {
    setStatus("Importing project bundle...");
    try {
      const imported = await importProjectBundle(file);
      await refreshProjects(imported.id);
      setProject(imported);
      setSelectedOverlayId(imported.overlays[0]?.id ?? null);
      setSourceSegmentsOpen(false);
      setIsDirty(false);
      setExternalUpdateAvailable(false);
      historyRef.current = { past: [], future: [] };
      setStatus(`Imported project bundle ${imported.name}.`);
      showToast(`Imported project bundle ${imported.name}.`);
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  async function handleImportSlug(file: File) {
    setStatus("Importing slug video...");
    try {
      const asset = await importSlugVideo(file);
      await refreshSlugs();
      setStatus(`Imported slug ${asset.label}.`);
      showToast(`Imported slug ${asset.label}.`);
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  async function handleDeleteSlug(slug: SlugAsset) {
    const confirmed = window.confirm(`Delete slug "${slug.label}"?`);
    if (!confirmed) return;
    setStatus("Deleting slug...");
    try {
      await deleteSlug(slug.id);
      await refreshSlugs();
      setStatus(`Deleted slug ${slug.label}.`);
      showToast(`Deleted slug ${slug.label}.`);
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  function updateProjectState(
    next: Project,
    nextSelectedId?: string | null,
    options: { pushHistory?: boolean; markDirty?: boolean } = {}
  ) {
    const shouldPush = options.pushHistory ?? true;
    const shouldMarkDirty = options.markDirty ?? true;
    if (shouldPush && project) {
      historyRef.current.past.push({
        project: cloneProjectState(project),
        selectedOverlayId,
        currentFrame,
      });
      if (historyRef.current.past.length > 200) {
        historyRef.current.past.shift();
      }
      historyRef.current.future = [];
    }
    setProject(next);
    if (shouldMarkDirty) {
      setIsDirty(true);
    }
    if (typeof nextSelectedId !== "undefined") {
      setSelectedOverlayId(nextSelectedId);
      return;
    }
    if (!selectedOverlayId && next.overlays.length) {
      setSelectedOverlayId(next.overlays[0].id);
    }
  }

  function updateProjectExportOptions(patch: Partial<Project["exportOptions"]>) {
    if (!project) return;
    const nextExportOptions = {
      speed: project.exportOptions?.speed ?? 1,
      includeAudio: project.exportOptions?.includeAudio ?? true,
      includeSlug: project.exportOptions?.includeSlug ?? false,
      includeSlugStart: project.exportOptions?.includeSlugStart ?? false,
      includeSlugEnd: project.exportOptions?.includeSlugEnd ?? false,
      ...patch,
    };
    updateProjectState({ ...project, exportOptions: nextExportOptions }, undefined, {
      pushHistory: false,
    });
  }

  function updateExternalAudioTrack(patch: Partial<AudioTrack> | null) {
    if (!project) return;
    if (!patch) {
      updateProjectState({ ...project, audioTrack: undefined }, undefined, {
        pushHistory: false,
      });
      return;
    }
    const current = project.audioTrack;
    if (!current?.assetPath && !patch.assetPath) return;
    const hasFadeOutPatch = Object.prototype.hasOwnProperty.call(patch, "fadeOut");
    const rawFadeOut = hasFadeOutPatch ? patch.fadeOut : current?.fadeOut;
    const fadeOut = rawFadeOut?.enabled
      ? {
          enabled: true,
          target: rawFadeOut.target ?? "tailSlug",
          durationSec: Math.max(0.1, Number(rawFadeOut.durationSec) || 2),
        }
      : undefined;
    const nextTrack: AudioTrack = {
      assetPath: patch.assetPath ?? current?.assetPath ?? "",
      mode: patch.mode ?? current?.mode ?? "overlay",
      startSec: Math.max(0, Number(patch.startSec ?? current?.startSec ?? 0) || 0),
      source: patch.source ?? current?.source ?? "upload",
      filename: patch.filename ?? current?.filename,
      originalUrl: patch.originalUrl ?? current?.originalUrl,
      fadeOut,
    };
    updateProjectState({ ...project, audioTrack: nextTrack }, undefined, {
      pushHistory: false,
    });
  }

  function audioTrackFromAsset(asset: AudioAsset, mode: AudioTrack["mode"]): AudioTrack {
    return {
      assetPath: asset.path,
      mode,
      startSec: project?.audioTrack?.startSec ?? 0,
      source: asset.source,
      filename: asset.filename,
      originalUrl: asset.originalUrl,
      fadeOut: project?.audioTrack?.fadeOut,
    };
  }

  async function handleImportAudioFile(file: File) {
    if (!selectedId) {
      setStatus("Select a project first.");
      return;
    }
    setStatus("Importing audio...");
    try {
      const asset = await uploadAudioAsset(selectedId, file);
      updateExternalAudioTrack(audioTrackFromAsset(asset, project?.audioTrack?.mode ?? "overlay"));
      setStatus(`Imported audio ${asset.filename}.`);
      showToast(`Imported audio ${asset.filename}.`);
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  async function handleImportAudioUrl() {
    if (!selectedId) {
      setStatus("Select a project first.");
      return;
    }
    const url = audioUrlInput.trim();
    if (!url) {
      setStatus("Enter an audio URL.");
      return;
    }
    setStatus("Importing audio URL...");
    try {
      const asset = await importAudioAssetFromUrl(selectedId, url);
      updateExternalAudioTrack(audioTrackFromAsset(asset, project?.audioTrack?.mode ?? "overlay"));
      setAudioUrlInput("");
      setStatus(`Imported audio ${asset.filename}.`);
      showToast(`Imported audio ${asset.filename}.`);
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  function updateEdits(patch: Partial<NonNullable<Project["edits"]>>) {
    if (!project) return;
    const nextEdits = {
      trimStartFrames: project.edits?.trimStartFrames ?? 0,
      trimEndFrames: project.edits?.trimEndFrames ?? 0,
      cuts: project.edits?.cuts ?? [],
      sourceSegments: project.edits?.sourceSegments ?? [],
      ...patch,
    };
    updateProjectState({ ...project, edits: nextEdits }, undefined, { pushHistory: false });
  }

  function clampTrimRange(nextStart: number, nextEnd: number) {
    const total = Math.max(1, totalFrames);
    const start = Math.max(0, Math.min(Math.floor(nextStart), total - 1));
    const end = Math.max(start + 1, Math.min(Math.floor(nextEnd), total));
    return { start, end };
  }

  function setTrimStartFrames(nextStart: number) {
    const clamped = clampTrimRange(nextStart, trimRange.end);
    updateEdits({
      trimStartFrames: clamped.start,
      trimEndFrames: Math.max(0, totalFrames - clamped.end),
    });
    setTrimStartTime(formatTimecode(clamped.start, fps));
    setTrimEndTime(formatTimecode(clamped.end, fps));
  }

  function setTrimEndFrames(nextEnd: number) {
    const clamped = clampTrimRange(trimRange.start, nextEnd);
    updateEdits({
      trimStartFrames: clamped.start,
      trimEndFrames: Math.max(0, totalFrames - clamped.end),
    });
    setTrimStartTime(formatTimecode(clamped.start, fps));
    setTrimEndTime(formatTimecode(clamped.end, fps));
  }

  function addCut() {
    if (!project) return;
    const cut = {
      id: crypto.randomUUID(),
      startFrame: currentFrame,
      endFrame: Math.min(currentFrame + Math.floor(fps), totalFrames - 1),
      transition: { type: "cut" as const, durationFrames: 0 },
    };
    updateEdits({ cuts: [...(edits.cuts ?? []), cut] });
  }

  function updateCut(id: string, patch: Partial<ProjectCut>) {
    if (!project) return;
    const nextCuts = (edits.cuts ?? []).map((cut) => {
      if (cut.id !== id) return cut;
      return { ...cut, ...patch };
    });
    updateEdits({ cuts: nextCuts });
  }

  function removeCut(id: string) {
    if (!project) return;
    updateEdits({ cuts: (edits.cuts ?? []).filter((cut) => cut.id !== id) });
  }

  function applySourceSegments(segments: SourceSegment[]) {
    if (!project) return;
    setSourceSegmentsOpen(true);
    const nextEdits = {
      trimStartFrames: project.edits?.trimStartFrames ?? 0,
      trimEndFrames: project.edits?.trimEndFrames ?? 0,
      cuts: project.edits?.cuts ?? [],
      sourceSegments: segments,
    };
    const nextExportOptions = {
      speed: 1 as const,
      includeAudio: project.exportOptions?.includeAudio ?? true,
      includeSlug: project.exportOptions?.includeSlug ?? false,
      includeSlugStart: project.exportOptions?.includeSlugStart ?? false,
      includeSlugEnd: project.exportOptions?.includeSlugEnd ?? false,
    };
    setRenderOptions((prev) => ({ ...prev, speed: 1 }));
    updateProjectState(
      { ...project, edits: nextEdits, exportOptions: nextExportOptions },
      undefined,
      { pushHistory: false }
    );
  }

  function updateSourceSegment(id: string, patch: Partial<SourceSegment>) {
    if (!project) return;
    const nextSegments = sourceSegments.map((segment) => {
      if (segment.id !== id) return segment;
      const next = { ...segment, ...patch };
      if (next.kind === "image") {
        return {
          ...next,
          kind: "image" as const,
          startFrame: 0,
          endFrameExclusive: 1,
          playbackRate: 1,
          durationFrames: Math.max(1, Number(next.durationFrames) || 1),
          audio: "mute" as const,
        };
      }
      const startFrame = Math.max(0, Math.min(formatFrame(next.startFrame), totalFrames - 1));
      const endFrameExclusive = Math.max(
        startFrame + 1,
        Math.min(formatFrame(next.endFrameExclusive), totalFrames)
      );
      return {
        ...next,
        kind: "source" as const,
        startFrame,
        endFrameExclusive,
        playbackRate: Math.max(0.01, Number(next.playbackRate) || 1),
        audio: next.audio ?? "preserve",
      };
    });
    applySourceSegments(nextSegments);
  }

  function removeSourceSegment(id: string) {
    applySourceSegments(sourceSegments.filter((segment) => segment.id !== id));
  }

  function moveSourceSegment(id: string, direction: -1 | 1) {
    const index = sourceSegments.findIndex((segment) => segment.id === id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= sourceSegments.length) return;
    const nextSegments = [...sourceSegments];
    const [segment] = nextSegments.splice(index, 1);
    nextSegments.splice(nextIndex, 0, segment);
    applySourceSegments(nextSegments);
  }

  function addSourceSegment() {
    if (!project) return;
    setSourceSegmentsOpen(true);
    const startFrame = currentFrame;
    const endFrameExclusive = Math.min(totalFrames, startFrame + Math.max(1, Math.round(fps * 5)));
    applySourceSegments([
      ...sourceSegments,
      {
        id: crypto.randomUUID(),
        kind: "source",
        label: "Manual segment",
        startFrame,
        endFrameExclusive,
        playbackRate: 1,
        audio: "preserve",
        transition: { type: "cut", durationFrames: 0 },
      },
    ]);
  }

  async function parseSourceTimelineRecipe(apply: boolean) {
    if (!project) return;
    try {
      const parsed = await parseSourceTimeline(project.id, sourceTimelineText, {
        defaultAudio: "preserve",
      });
      setSourceTimelineWarnings(parsed.warnings);
      setSourceTimelineOutput({
        outputDurationSeconds: parsed.outputDurationSeconds,
        outputFrames: parsed.outputFrames,
      });
      setSourceSegmentsOpen(true);
      if (apply) {
        applySourceSegments(parsed.segments);
        setStatus(`Applied ${parsed.segments.length} source segments.`);
      } else {
        setStatus(`Parsed ${parsed.segments.length} source segments.`);
      }
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  function applySlugSelection(slugId: string) {
    if (!project) return;
    const slugOption = slugLibrary.find((option) => option.id === slugId) ?? null;
    if (!slugOption) {
      setRenderOptions((prev) => ({
        ...prev,
        includeSlugStart: false,
        includeSlugEnd: false,
      }));
      updateProjectState(
        {
          ...project,
          slug: undefined,
          exportOptions: {
            speed: project.exportOptions?.speed ?? 1,
            includeAudio: project.exportOptions?.includeAudio ?? true,
            includeSlug: false,
            includeSlugStart: false,
            includeSlugEnd: false,
          },
        },
        undefined,
        { pushHistory: false }
      );
      return;
    }

    updateProjectState(
      {
        ...project,
        slug: {
          introPath: slugOption.path,
          outroPath: slugOption.path,
          fps:
            slugOption.video.fpsDen === 0
              ? 30
              : slugOption.video.fpsNum / slugOption.video.fpsDen,
          transition: project.slug?.transition ?? {
            type: "cut",
            durationFrames: 0,
          },
        },
      },
      undefined,
      { pushHistory: false }
    );
  }

  function applySlugFlags(includeSlugStart: boolean, includeSlugEnd: boolean) {
    setRenderOptions((prev) => ({
      ...prev,
      includeSlugStart,
      includeSlugEnd,
    }));
    updateProjectExportOptions({
      includeSlugStart,
      includeSlugEnd,
      includeSlug: includeSlugStart && includeSlugEnd,
    });
  }

  function updateSlugTransition(
    patch: Partial<{ type: "cut" | "crossfade"; durationFrames: number }>
  ) {
    if (!project?.slug) return;
    const nextTransition = {
      type: project.slug.transition?.type ?? "cut",
      durationFrames: project.slug.transition?.durationFrames ?? 0,
      ...patch,
    };
    updateProjectState(
      {
        ...project,
        slug: {
          ...project.slug,
          transition: nextTransition,
        },
      },
      undefined,
      { pushHistory: false }
    );
  }

  const undo = useCallback(() => {
    const history = historyRef.current;
    const previous = history.past.pop();
    if (!previous || !project) return;
    history.future.push({
      project: cloneProjectState(project),
      selectedOverlayId,
      currentFrame,
    });
    setProject(previous.project);
    setIsDirty(true);
    setSelectedOverlayId(previous.selectedOverlayId);
    setCurrentFrame(previous.currentFrame);
  }, [project, selectedOverlayId, currentFrame]);

  const redo = useCallback(() => {
    const history = historyRef.current;
    const next = history.future.pop();
    if (!next || !project) return;
    history.past.push({
      project: cloneProjectState(project),
      selectedOverlayId,
      currentFrame,
    });
    setProject(next.project);
    setIsDirty(true);
    setSelectedOverlayId(next.selectedOverlayId);
    setCurrentFrame(next.currentFrame);
  }, [project, selectedOverlayId, currentFrame]);

  function updateOverlay(id: string, patch: Partial<Overlay>) {
    if (!project) return;
    const overlays = project.overlays.map((overlay: Overlay) =>
      overlay.id === id ? syncArrowVisibility(overlay, patch) : overlay
    );
    updateProjectState({ ...project, overlays });
  }

  function updateOverlayMotion(id: string, patch: Partial<Overlay["motion"]>) {
    if (!project) return;
    const overlays = project.overlays.map((overlay: Overlay) => {
      if (overlay.id !== id) return overlay;
      return { ...overlay, motion: { ...overlay.motion, ...patch } };
    });
    updateProjectState({ ...project, overlays });
  }

  function normalizeRotation(value: number) {
    return normalizeSharedRotation(value);
  }

  function rotateOverlay(id: string, delta: number) {
    if (!project) return;
    const overlay = project.overlays.find((item) => item.id === id);
    if (!overlay) return;
    const nextRotation = normalizeRotation((overlay.rotationDeg ?? 0) + delta);
    updateOverlay(id, { rotationDeg: nextRotation });
  }

  function selectOverlayById(id: string, seek = true) {
    setSelectedOverlayId(id);
    if (!seek || !project) return;
    const overlay = project.overlays.find((item) => item.id === id);
    if (overlay) {
      seekToFrame(formatFrame(overlay.startFrame));
    }
  }

  function getTemplateRect(templateId: string) {
    const fallback = { x: 80, y: 80, w: DEFAULT_CARD_SIZE.w, h: DEFAULT_CARD_SIZE.h };
    if (!project) return fallback;
    const template = templateMap[templateId];
    if (!template) return fallback;
    const scaleX = project.video.width / template.sourceWidth;
    const scaleY = project.video.height / template.sourceHeight;
    return {
      x: template.bounds.left * scaleX,
      y: template.bounds.top * scaleY,
      w: template.bounds.width * scaleX,
      h: template.bounds.height * scaleY,
    };
  }

  function getArrowSize() {
    if (arrowTemplate) {
      return { w: arrowTemplate.sourceWidth, h: arrowTemplate.sourceHeight };
    }
    return DEFAULT_ARROW_SIZE;
  }

  const removeOverlay = useCallback(
    (id: string) => {
      if (!project) return;
      const index = project.overlays.findIndex((overlay) => overlay.id === id);
      if (index === -1) return;
      const remaining = normalizeOverlayZIndexes(project.overlays.filter((overlay) => overlay.id !== id));
      const nextSelected =
        remaining.length > 0 ? remaining[Math.min(index, remaining.length - 1)].id : null;
      updateProjectState({ ...project, overlays: remaining }, nextSelected);
    },
    [project]
  );

  useEffect(() => {
    function isEditableTarget(target: EventTarget | null) {
      if (!(target instanceof HTMLElement)) return false;
      if (target.isContentEditable) return true;
      const tag = target.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    }

    function handleKeyDown(event: KeyboardEvent) {
      const isModifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      if (isModifier && (key === "/" || event.code === "Slash")) {
        event.preventDefault();
        setShowHotkeys((prev) => !prev);
        return;
      }

      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        if (isEditableTarget(event.target)) return;
        event.preventDefault();
        const delta = event.key === "ArrowUp" ? -15 : 15;
        const total = Math.max(1, totalFramesRef.current || totalFrames);
        const nextFrame = Math.max(
          0,
          Math.min(total - 1, currentFrameRef.current + delta)
        );
        seekToFrame(nextFrame);
        return;
      }

      if (event.key === "Escape") {
        if (showHotkeys) {
          event.preventDefault();
          setShowHotkeys(false);
        }
        return;
      }

      if (isModifier && key === "z") {
        if (isEditableTarget(event.target)) return;
        event.preventDefault();
        if (event.shiftKey) {
          redo();
        } else {
          undo();
        }
        return;
      }

      if (isModifier && key === "y") {
        if (isEditableTarget(event.target)) return;
        event.preventDefault();
        redo();
        return;
      }

      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (!selectedOverlayId) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      removeOverlay(selectedOverlayId);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedOverlayId, removeOverlay, undo, redo, showHotkeys, seekToFrame, totalFrames]);

  function createCardOverlay(templateId: string, x?: number, y?: number) {
    if (!project) return;
    const overlay = buildCardOverlay(
      project,
      {
        type: "addCard",
        id: crypto.randomUUID(),
        templateId,
        startFrame: currentFrame,
        x,
        y,
      },
      {
        templates: templateLibrary,
        createId: () => crypto.randomUUID(),
      }
    );
    updateProjectState({ ...project, overlays: [...project.overlays, overlay] });
    setSelectedOverlayId(overlay.id);
  }

  function createArrowOverlay(x?: number, y?: number) {
    if (!project) return;
    const overlay = buildArrowOverlay(
      project,
      {
        type: "addArrow",
        id: crypto.randomUUID(),
        startFrame: currentFrame,
        x,
        y,
      },
      {
        arrows: arrowTemplate ? [arrowTemplate] : undefined,
        createId: () => crypto.randomUUID(),
      }
    );
    updateProjectState({ ...project, overlays: [...project.overlays, overlay] });
    setSelectedOverlayId(overlay.id);
  }

  function addOverlayCard() {
    createCardOverlay("card-lower-third-left");
  }

  function addOverlayArrow() {
    createArrowOverlay();
  }

  async function prepareRenderAssets(projectToRender: Project): Promise<Project> {
    if (!projectToRender.overlays.length) {
      const overlayAssetHash = projectToRender.renderCache?.overlayAssetHash ?? {};
      if (!Object.keys(overlayAssetHash).length) return projectToRender;
      return {
        ...projectToRender,
        renderCache: { ...(projectToRender.renderCache ?? {}), overlayAssetHash: {} },
      };
    }

    const currentIds = new Set(projectToRender.overlays.map((overlay) => overlay.id));
    const overlayAssetHash = { ...(projectToRender.renderCache?.overlayAssetHash ?? {}) };
    let changed = false;
    let uploaded = 0;

    for (const key of Object.keys(overlayAssetHash)) {
      if (!currentIds.has(key)) {
        delete overlayAssetHash[key];
        changed = true;
      }
    }

    for (const [index, overlay] of projectToRender.overlays.entries()) {
      const hash = getOverlayAssetHash(overlay);
      if (overlayAssetHash[overlay.id] === hash) continue;
      setStatus(`Preparing overlay asset ${index + 1}/${projectToRender.overlays.length}...`);
      const template = templateMap[overlay.templateId];
      const blob = await renderOverlayBlob(overlay, template, loadRenderImage, arrowTemplate);
      await uploadAsset(
        projectToRender.id,
        isArrow(overlay) ? "arrows" : "overlays",
        overlay.id,
        blob
      );
      overlayAssetHash[overlay.id] = hash;
      uploaded += 1;
      changed = true;
    }

    if (uploaded > 0) {
      setStatus(`Prepared ${uploaded} overlay asset${uploaded === 1 ? "" : "s"}.`);
    }

    return changed
      ? {
          ...projectToRender,
          renderCache: { ...(projectToRender.renderCache ?? {}), overlayAssetHash },
        }
      : projectToRender;
  }

  async function saveProjectDocument(
    projectId: string,
    projectToSave: Project,
    mode: "manual" | "autosave"
  ): Promise<Project | null> {
    try {
      const saved = await updateProject(projectId, projectToSave);
      updateProjectState(saved, undefined, { pushHistory: false, markDirty: false });
      setIsDirty(false);
      setExternalUpdateAvailable(false);
      setAutosavePausedProjectId(null);
      if (mode === "autosave") {
        const at = new Date().toLocaleTimeString();
        setLastAutosaveAt(at);
        setStatus(`Autosaved at ${at}.`);
      } else {
        setStatus("Project saved.");
      }
      await refreshProjects(projectId);
      return saved;
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.payload &&
        typeof error.payload === "object" &&
        "project" in error.payload
      ) {
        const latest = (error.payload as { project: Project }).project;
        if (mode === "autosave") {
          setExternalUpdateAvailable(true);
          setAutosavePausedProjectId(projectId);
          setStatus("Autosave paused: external project update available.");
          showToast("Autosave paused until you review the external update.");
          return null;
        }
        setProject(latest);
        setSelectedOverlayId(latest.overlays[0]?.id ?? null);
        setIsDirty(false);
        setExternalUpdateAvailable(false);
        setAutosavePausedProjectId(null);
        historyRef.current = { past: [], future: [] };
        setStatus("Project changed externally. Reloaded the latest version.");
        return latest;
      }
      const message = (error as Error).message;
      setStatus(mode === "autosave" ? `Autosave failed: ${message}` : message);
      return null;
    }
  }

  async function handleSaveProject() {
    if (!project || !selectedId) return;
    setStatus("Saving project...");
    await saveProjectDocument(selectedId, project, "manual");
  }

  function openRenderEventSource(url: string, label: "Render" | "Patch") {
    const es = new EventSource(url);
    const parsePayload = (event: Event) => {
      if ("data" in event) {
        const raw = (event as MessageEvent).data;
        if (typeof raw === "string" && raw.length) {
          try {
            return JSON.parse(raw) as { stage?: string; message?: string; percent?: number };
          } catch {
            return { message: raw };
          }
        }
      }
      return {};
    };

    const pushRenderLog = (line: string) => {
      if (!line) return;
      setRenderLogs((prev) => {
        const next = [...prev, line];
        return next.length > 200 ? next.slice(next.length - 200) : next;
      });
    };

    const applyUpdate = (data: { stage?: string; message?: string; percent?: number }) => {
      if (typeof data.percent === "number") {
        setRenderProgress(data.percent);
      }
      if (data.message) {
        const stageLabel = data.stage ? `[${data.stage}] ` : "";
        const line = `${stageLabel}${data.message}`;
        setStatus(line);
        pushRenderLog(line);
      }
    };

    es.addEventListener("status", (event) => {
      applyUpdate(parsePayload(event));
    });
    es.addEventListener("progress", (event) => {
      applyUpdate(parsePayload(event));
    });
    es.addEventListener("done", (event) => {
      const data = parsePayload(event);
      setStatus(`${label} complete: ${data.message ?? "Done"}`);
      setRenderProgress(1);
      pushRenderLog(`${label} complete: ${data.message ?? "Done"}`);
      setRenderActive(false);
      setRenderReady(true);
      if (data.message) {
        setRenderFinalPath(data.message);
      }
      if (selectedId && !isRoughPreview) {
        getPatchStatus(selectedId, renderOptions)
          .then(setPatchStatus)
          .catch(() => setPatchStatus(null));
      }
      es.close();
    });
    es.addEventListener("error", (event) => {
      const data = parsePayload(event);
      const message = `${label} error: ${data.message ?? "unknown"}`;
      setStatus(message);
      pushRenderLog(message);
      setRenderActive(false);
      es.close();
    });
  }

  async function handleRenderFinal() {
    if (!project || !selectedId) return;
    setStatus("Starting render...");
    setRenderProgress(0);
    setRenderLogs([]);
    setRenderActive(true);
    setRenderReady(false);
    setRenderFinalPath("");
    try {
      const preparedProject = await prepareRenderAssets(project);
      const saved = await saveProjectDocument(selectedId, preparedProject, "manual");
      if (!saved) {
        throw new Error("Project was not saved; render cancelled.");
      }
      openRenderEventSource(renderStreamUrl(selectedId, renderOptions), "Render");
    } catch (error) {
      setStatus((error as Error).message);
      setRenderActive(false);
    }
  }

  async function handlePatchLatestFinal() {
    if (!project || !selectedId) return;
    setStatus("Preparing patch...");
    setRenderProgress(0);
    setRenderLogs([]);
    setRenderActive(true);
    setRenderReady(false);
    setRenderFinalPath("");
    try {
      const preparedProject = await prepareRenderAssets(project);
      const saved = await saveProjectDocument(selectedId, preparedProject, "manual");
      if (!saved) {
        throw new Error("Project was not saved; patch cancelled.");
      }
      const nextStatus = await getPatchStatus(selectedId, renderOptions);
      setPatchStatus(nextStatus);
      if (!nextStatus.patchable) {
        throw new Error(nextStatus.reason ?? "Latest final export is not patchable.");
      }
      openRenderEventSource(patchStreamUrl(selectedId, renderOptions), "Patch");
    } catch (error) {
      setStatus((error as Error).message);
      setRenderActive(false);
    }
  }

  async function handleCopyFinalPath() {
    if (!renderFinalPath) return;
    try {
      await navigator.clipboard.writeText(renderFinalPath);
      setStatus("Copied final path to clipboard.");
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  function handleDragStart(type: "card" | "arrow", templateId?: string) {
    return (event: DragEvent) => {
      const payload = JSON.stringify({ type, templateId });
      event.dataTransfer.setData("text/plain", payload);
    };
  }

  function handleDragOver(event: DragEvent) {
    event.preventDefault();
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    if (!project || !videoWrapperRef.current) return;
    const payload = event.dataTransfer.getData("text/plain");
    if (!payload) return;
    try {
      const data = JSON.parse(payload) as { type: "card" | "arrow"; templateId?: string };
      const rect = videoWrapperRef.current.getBoundingClientRect();
      const dropX = event.clientX - rect.left;
      const dropY = event.clientY - rect.top;
      if (data.type === "card") {
        const templateId = data.templateId ?? "card-lower-third-left";
        const baseRect = getTemplateRect(templateId);
        const x = dropX / stageMetrics.scaleX - baseRect.w / 2;
        const y = dropY / stageMetrics.scaleY - baseRect.h / 2;
        createCardOverlay(templateId, Math.max(0, x), Math.max(0, y));
      } else {
        const size = getArrowSize();
        const arrowX = dropX / stageMetrics.scaleX - size.w / 2;
        const arrowY = dropY / stageMetrics.scaleY - size.h / 2;
        createArrowOverlay(Math.max(0, arrowX), Math.max(0, arrowY));
      }
    } catch {
      return;
    }
  }

  const handlePreviewKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (isPlayingRef.current) return;
      if (!hasMedia) return;
      event.preventDefault();
      const delta = event.key === "ArrowLeft" ? -1 : 1;
      const total = Math.max(1, totalFrames);
      const nextFrame = Math.max(0, Math.min(total - 1, currentFrame + delta));
      seekToFrame(nextFrame);
    },
    [currentFrame, hasMedia, seekToFrame, totalFrames]
  );

  function renderCardShape(overlay: Overlay) {
    const scaleX = stageMetrics.scaleX;
    const scaleY = stageMetrics.scaleY;
    const width = overlay.rect.w * scaleX;
    const height = overlay.rect.h * scaleY;
    const x = overlay.rect.x * scaleX;
    const y = overlay.rect.y * scaleY;
    const template = templateMap[overlay.templateId];
    const templateImage = template ? templateImages[template.id] : undefined;
    const templateAlign = resolveTemplateAlign(overlay.templateId, template);
    const textAlign = resolveTextAlign(overlay.fields.textAlign, templateAlign);
    const textScale = resolveTextScale(overlay.fields.textScale, DEFAULT_TEXT_SCALE);
    const titleScale = resolveTextScale(overlay.fields.titleScale, DEFAULT_TITLE_SCALE);
    const titleOffset = BASE_TITLE_OFFSET + resolveTextOffset(overlay.fields.titleOffsetY, 0);
    const textOffset = BASE_TEXT_OFFSET + resolveTextOffset(overlay.fields.textOffsetY, 0);
    const baseMargins = getDefaultTextMargins(templateAlign);
    const marginLeft = resolveTextMargin(overlay.fields.textMarginLeft, baseMargins.left) * scaleX;
    const marginRight = resolveTextMargin(overlay.fields.textMarginRight, baseMargins.right) * scaleX;
    const textWidth = Math.max(40, width - marginLeft - marginRight);
    const textX = marginLeft;
    const textValue = String(overlay.fields.text ?? overlay.fields.subtitle ?? "");
    const crop = template
      ? {
          x: template.bounds.left,
          y: template.bounds.top,
          width: template.bounds.width,
          height: template.bounds.height,
        }
      : undefined;
    const isSelected = overlay.id === selectedOverlayId;

    return (
      <Group
        key={overlay.id}
        ref={(node) => {
          if (node) overlayRefs.current[overlay.id] = node;
        }}
        x={x}
        y={y}
        draggable
        onClick={() => selectOverlayById(overlay.id, false)}
        onTap={() => selectOverlayById(overlay.id, false)}
        onDragEnd={(event) => {
          const node = event.target;
          updateOverlay(overlay.id, {
            rect: {
              ...overlay.rect,
              x: node.x() / scaleX,
              y: node.y() / scaleY,
            },
          });
        }}
        onTransformEnd={(event) => {
          const node = event.target;
          const scaleXNode = node.scaleX();
          const scaleYNode = node.scaleY();
          const newWidth = Math.max(20, overlay.rect.w * scaleXNode);
          const newHeight = Math.max(20, overlay.rect.h * scaleYNode);
          node.scaleX(1);
          node.scaleY(1);
          updateOverlay(overlay.id, {
            rect: {
              x: node.x() / scaleX,
              y: node.y() / scaleY,
              w: newWidth,
              h: newHeight,
            },
          });
        }}
      >
        {templateImage ? (
          <KonvaImage image={templateImage} width={width} height={height} crop={crop} />
        ) : (
          <Rect width={width} height={height} fill="rgba(15, 19, 24, 0.65)" cornerRadius={12} />
        )}
        <Rect
          width={width}
          height={height}
          fill="rgba(0,0,0,0)"
          stroke={isSelected ? "#f7b35b" : "rgba(255,255,255,0.2)"}
          cornerRadius={12}
        />
        <Text
          text={String(overlay.fields.title ?? "")}
          fontSize={Math.max(14, height * 0.3 * titleScale)}
          fill="#f5f2ea"
          x={textX}
          y={Math.max(8, height * 0.18) + titleOffset * scaleY}
          width={textWidth}
          align="center"
        />
        <Text
          text={textValue}
          fontSize={Math.max(12, height * 0.18 * textScale)}
          fill="#d1c7b8"
          x={textX}
          y={Math.max(8, height * 0.55) + textOffset * scaleY}
          width={textWidth}
          align={textAlign}
        />
      </Group>
    );
  }

  function renderArrowShape(overlay: Overlay) {
    const scaleX = stageMetrics.scaleX;
    const scaleY = stageMetrics.scaleY;
    const width = overlay.rect.w * scaleX;
    const height = overlay.rect.h * scaleY;
    const centerX = overlay.rect.x * scaleX + width / 2;
    const centerY = overlay.rect.y * scaleY + height / 2;
    const arrowImg = arrowImage;
    const isSelected = overlay.id === selectedOverlayId;

    return (
      <Group
        key={overlay.id}
        ref={(node) => {
          if (node) overlayRefs.current[overlay.id] = node;
        }}
        x={centerX}
        y={centerY}
        offsetX={width / 2}
        offsetY={height / 2}
        rotation={overlay.rotationDeg ?? 0}
        draggable
        onClick={() => selectOverlayById(overlay.id, false)}
        onTap={() => selectOverlayById(overlay.id, false)}
        onDragEnd={(event) => {
          const node = event.target;
          const newX = (node.x() - width / 2) / scaleX;
          const newY = (node.y() - height / 2) / scaleY;
          updateOverlay(overlay.id, {
            rect: { ...overlay.rect, x: newX, y: newY },
          });
        }}
        onTransformEnd={(event) => {
          const node = event.target;
          const nextScaleX = node.scaleX();
          const nextScaleY = node.scaleY();
          const nextWidth = Math.max(16, overlay.rect.w * nextScaleX);
          const nextHeight = Math.max(16, overlay.rect.h * nextScaleY);
          node.scaleX(1);
          node.scaleY(1);
          const centerX = node.x() / scaleX;
          const centerY = node.y() / scaleY;
          updateOverlay(overlay.id, {
            rotationDeg: normalizeRotation(node.rotation()),
            rect: {
              x: centerX - nextWidth / 2,
              y: centerY - nextHeight / 2,
              w: nextWidth,
              h: nextHeight,
            },
          });
        }}
      >
        {arrowImg ? (
          <KonvaImage image={arrowImg} width={width} height={height} />
        ) : (
          <Arrow
            x={width / 2}
            y={height / 2}
            points={[-width / 2, 0, width / 2, 0]}
            pointerLength={Math.min(width * 0.3, 48)}
            pointerWidth={Math.min(height * 0.6, 48)}
            fill="rgba(247, 179, 91, 0.8)"
            stroke="rgba(247, 179, 91, 0.9)"
            strokeWidth={Math.max(2, height * 0.15)}
          />
        )}
        {isSelected && (
          <Rect
            width={width}
            height={height}
            stroke="rgba(247, 179, 91, 0.8)"
            strokeWidth={2}
            dash={[6, 4]}
          />
        )}
      </Group>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>C&amp;M Content Tools</h1>
          <div className="subtitle">
            Editing workspace · {project ? project.name : "Select a project"} · Frame {currentFrame}
          </div>
        </div>
        <div className="topbar-actions">
          {externalUpdateAvailable && <div className="hotkey-tip warning">External update pending</div>}
          {isDirty && !externalUpdateAvailable && <div className="hotkey-tip">Unsaved changes</div>}
          <div className="hotkey-tip">Tip: Ctrl + / for hotkeys</div>
        </div>
      </header>

      <div className="editor-grid" style={editorGridStyle}>
        <aside className="sidebar left">
          <div className="tabs">
            {(["media", "overlays", "exports"] as const).map((tab) => (
              <button
                key={tab}
                className={leftTab === tab ? "tab active" : "tab"}
                onClick={() => setLeftTab(tab)}
              >
                {tab}
              </button>
            ))}
          </div>

          {leftTab === "media" && (
            <div className="panel-block">
              <label htmlFor="project-name">New project</label>
              <input
                id="project-name"
                type="text"
                value={nameInput}
                onChange={(event) => setNameInput(event.target.value)}
                placeholder="K1s demo walkthrough"
              />
              <div className="actions">
                <button onClick={handleCreate}>Create</button>
                <button className="secondary" onClick={() => refreshProjects()}>
                  Refresh
                </button>
              </div>

              <div className="media-section">
                <h3>Projects</h3>
                <ul className="project-list">
                  {projects.map((proj) => (
                    <li className="project-card" key={proj.id}>
                      <div>
                        <strong>{proj.name}</strong>
                        <div className="details">{proj.id}</div>
                      </div>
                      <div className="project-actions">
                        <button onClick={() => setSelectedId(proj.id)}>Select</button>
                        <button
                          className="danger"
                          onClick={() => handleDeleteProject(proj.id, proj.name)}
                        >
                          Delete
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="media-section">
                <label>Import video</label>
                <input
                  type="file"
                  accept="video/*"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void handleImport(file);
                  }}
                />
                {project && (
                  <div className="details">
                    Source: {project.source.filename || "—"}
                    <br />
                    Video: {project.video.width}×{project.video.height} @ {fps.toFixed(2)} fps
                  </div>
                )}
              </div>

              <div className="media-section">
                <h3>Project bundle</h3>
                <label htmlFor="bundle-mode">Export mode</label>
                <select
                  id="bundle-mode"
                  value={bundleMode}
                  onChange={(event) => setBundleMode(event.target.value as ProjectBundleMode)}
                  disabled={!project}
                >
                  <option value="project-media">Project + source media</option>
                  <option value="project">Project document only</option>
                  <option value="full">Full workspace</option>
                </select>
                <div className="actions">
                  {project ? (
                    <a
                      className="button-link"
                      href={projectBundleUrl(project.id, bundleMode)}
                    >
                      Export bundle
                    </a>
                  ) : (
                    <button disabled>Export bundle</button>
                  )}
                </div>
                <label>Import bundle</label>
                <input
                  type="file"
                  accept=".zip,application/zip"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void handleImportBundle(file);
                  }}
                />
              </div>

              <div className="media-section">
                <h3>Slug library</h3>
                <label>Import slug MP4</label>
                <input
                  type="file"
                  accept="video/mp4,.mp4"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void handleImportSlug(file);
                  }}
                />
                <div className="slug-library-list">
                  {slugLibrary.map((slug) => (
                    <div className="slug-library-item" key={slug.id}>
                      <video
                        className="slug-preview"
                        src={slugMediaUrl(slug.id)}
                        controls
                        muted
                        preload="metadata"
                      />
                      <div>
                        <strong>{slug.label}</strong>
                        <div className="details">
                          {formatSeconds(slug.video.durationMs / 1000)} · {slug.video.width}×
                          {slug.video.height} · {slug.usageCount ?? 0} project
                          {(slug.usageCount ?? 0) === 1 ? "" : "s"}
                        </div>
                      </div>
                      <button
                        className="danger"
                        disabled={(slug.usageCount ?? 0) > 0}
                        onClick={() => handleDeleteSlug(slug)}
                      >
                        Delete
                      </button>
                    </div>
                  ))}
                  {!slugLibrary.length && <div className="details">No slug videos imported.</div>}
                </div>
              </div>

              <div className="asset-section">
                <h3>Card templates</h3>
                <div className="asset-grid">
                  {templateOptions.map((template) => (
                    <div
                      key={template.id}
                      className="asset-card"
                      draggable
                      onDragStart={handleDragStart("card", template.id)}
                      onClick={() => createCardOverlay(template.id)}
                    >
                      {template.label}
                    </div>
                  ))}
                </div>
                <h3>Arrows</h3>
                <div
                  className="asset-card"
                  draggable
                  onDragStart={handleDragStart("arrow")}
                  onClick={() => createArrowOverlay()}
                >
                  {arrowTemplate?.label ?? "Directional Arrow"}
                </div>
              </div>
            </div>
          )}

          {leftTab === "overlays" && (
            <div className="panel-block">
              <div className="actions">
                <button onClick={addOverlayCard} disabled={!project}>
                  Add card
                </button>
                <button onClick={addOverlayArrow} disabled={!project}>
                  Add arrow
                </button>
              </div>
              {project && (
                <ul className="overlay-list">
                  {project.overlays.map((overlay: Overlay) => {
                    const mappedRange = hasSourceSegments
                      ? getMappedOverlayRange(overlay, sourceSegments)
                      : null;
                    return (
                      <li
                        key={overlay.id}
                        className={overlay.id === selectedOverlayId ? "overlay-item active" : "overlay-item"}
                      >
                        <div className="overlay-item-row">
                          <button className="secondary" onClick={() => selectOverlayById(overlay.id)}>
                            {overlay.templateId}
                          </button>
                          <button className="danger" onClick={() => removeOverlay(overlay.id)}>
                            Delete
                          </button>
                        </div>
                        <div className="details">
                          {overlay.startFrame} → {overlay.endFrame}
                        </div>
                        {hasSourceSegments && (
                          <div className="details">
                            {mappedRange
                              ? `Output ${formatTimecode(mappedRange.start, fps)} → ${formatTimecode(
                                  mappedRange.end,
                                  fps
                                )}`
                              : "Outside rendered source segments"}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {leftTab === "exports" && (
            <div className="panel-block">
              <div className="details">
                {isRoughPreview
                  ? "Preview renders live in workspace exports folder."
                  : "Final renders live in workspace exports folder."}
              </div>
              <div className="actions">
                <button onClick={handleRenderFinal} disabled={!project || selectedPresetUnavailable}>
                  {isRoughPreview ? "Render preview" : "Render final"}
                </button>
                {!isRoughPreview && (
                  <button
                    className="secondary"
                    onClick={handlePatchLatestFinal}
                    disabled={!canPatchLatestFinal}
                  >
                    Patch latest final
                  </button>
                )}
              </div>
              {!isRoughPreview && <div className="details">{patchStatusMessage}</div>}
            </div>
          )}
        </aside>

        <section className="editor-center" ref={editorCenterRef}>
          <div
            className="preview-pane"
            ref={videoWrapperRef}
            style={previewPaneStyle}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onKeyDown={handlePreviewKeyDown}
            onClick={(event) => event.currentTarget.focus()}
            tabIndex={0}
          >
            {project && hasMedia ? (
              <>
                <video
                  ref={videoRef}
                  src={mediaUrl(project.id)}
                  className="video-preview"
                  controls
                  onLoadedMetadata={(event) => {
                    setVideoDurationSec((event.target as HTMLVideoElement).duration || 0);
                  }}
                  onTimeUpdate={(event) => {
                    if (!isPlayingRef.current) return;
                    const time = (event.target as HTMLVideoElement).currentTime;
                    const nextFrame = formatFrame(time * fps);
                    if (nextFrame === currentFrameRef.current) return;
                    currentFrameRef.current = nextFrame;
                    setCurrentFrame(nextFrame);
                  }}
                  onPlay={() => {
                    isPlayingRef.current = true;
                  }}
                  onPause={() => {
                    isPlayingRef.current = false;
                  }}
                />
                {stageMetrics.width > 0 && (
                  <div className="overlay-stage-hit-area">
                    <Stage
                      width={stageMetrics.width}
                      height={stageMetrics.height}
                      className="overlay-stage"
                    >
                      <Layer>
                        {project.overlays
                          .filter((overlay: Overlay) => isOverlayVisibleAtFrame(overlay, currentFrame))
                          .map((overlay: Overlay) =>
                            isArrow(overlay) ? renderArrowShape(overlay) : renderCardShape(overlay)
                          )}
                        <Transformer
                          ref={transformerRef}
                          rotateEnabled={isArrowSelected}
                          keepRatio={isArrowSelected}
                          enabledAnchors={isArrowSelected ? [] : undefined}
                          boundBoxFunc={(oldBox, newBox) => {
                            if (newBox.width < 40 || newBox.height < 20) return oldBox;
                            return newBox;
                          }}
                        />
                      </Layer>
                    </Stage>
                  </div>
                )}
              </>
            ) : (
              <div className="preview-placeholder">
                {project
                  ? "Import a video to start editing."
                  : "Select a project to start editing."}
              </div>
            )}
          </div>

          <div className="playback-bar">
            <button
              className="secondary"
              disabled={!hasMedia}
              onClick={() => seekToFrame(Math.max(0, currentFrame - 1))}
            >
              ◀︎ Frame
            </button>
            <button
              className="secondary"
              disabled={!hasMedia}
              onClick={() => seekToFrame(Math.min(totalFrames - 1, currentFrame + 1))}
            >
              Frame ▶︎
            </button>
            <div className="details">
              {project ? project.source.filename : "No media"} · {currentFrame} / {totalFrames}
            </div>
          </div>
        </section>

        <aside className="sidebar right">
          <div className="panel-block">
            <h3>Inspector</h3>
            {project && selectedOverlay && (
              <>
                <div className="actions">
                  <button className="danger" onClick={() => removeOverlay(selectedOverlay.id)}>
                    Delete overlay
                  </button>
                </div>
                <label>Start frame</label>
                <div className="actions">
                  <input
                    type="number"
                    value={selectedOverlay.startFrame}
                    onChange={(event) =>
                      updateOverlay(selectedOverlay.id, {
                        startFrame: Number(event.target.value),
                      })
                    }
                  />
                  <button
                    className="secondary"
                    onClick={() =>
                      updateOverlay(selectedOverlay.id, { startFrame: currentFrame })
                    }
                  >
                    Use playhead
                  </button>
                </div>

                <label>End frame</label>
                <div className="actions">
                  <input
                    type="number"
                    value={selectedOverlay.endFrame}
                    onChange={(event) =>
                      updateOverlay(selectedOverlay.id, {
                        endFrame: Number(event.target.value),
                      })
                    }
                  />
                  <button
                    className="secondary"
                    onClick={() =>
                      updateOverlay(selectedOverlay.id, { endFrame: currentFrame })
                    }
                  >
                    Use playhead
                  </button>
                </div>

                {!isArrow(selectedOverlay) && (
                  <>
                    <label>Template</label>
                    <select
                      value={selectedOverlay.templateId}
                      onChange={(event) =>
                        updateOverlay(selectedOverlay.id, { templateId: event.target.value })
                      }
                    >
                      {templateOptions.map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.label}
                        </option>
                      ))}
                    </select>
                    <label>Title</label>
                    <input
                      type="text"
                      value={String(selectedOverlay.fields.title ?? "")}
                      placeholder="Title"
                      onChange={(event) =>
                        updateOverlay(selectedOverlay.id, {
                          fields: { ...selectedOverlay.fields, title: event.target.value },
                        })
                      }
                    />
                    <label>Title size (%)</label>
                    <input
                      type="number"
                      min={50}
                      max={200}
                      step={5}
                      value={selectedTitleScalePercent}
                      onChange={(event) => {
                        const nextValue = Number(event.target.value);
                        if (!Number.isFinite(nextValue)) return;
                        const clamped = Math.min(200, Math.max(50, nextValue));
                        updateOverlay(selectedOverlay.id, {
                          fields: { ...selectedOverlay.fields, titleScale: clamped / 100 },
                        });
                      }}
                    />
                    <div className="text-offset-row">
                      <label>Title vertical offset (px)</label>
                      <div className="text-offset-controls">
                        <button
                          type="button"
                          className="secondary"
                          onClick={() =>
                            updateOverlay(selectedOverlay.id, {
                              fields: {
                                ...selectedOverlay.fields,
                                titleOffsetY: selectedTitleOffset + 1,
                              },
                            })
                          }
                        >
                          -1
                        </button>
                        <input
                          type="number"
                          min={-400}
                          max={400}
                          step={1}
                          value={selectedTitleOffset}
                          onChange={(event) => {
                            const nextValue = Number(event.target.value);
                            if (!Number.isFinite(nextValue)) return;
                            const clamped = Math.min(400, Math.max(-400, nextValue));
                            updateOverlay(selectedOverlay.id, {
                              fields: {
                                ...selectedOverlay.fields,
                                titleOffsetY: clamped,
                              },
                            });
                          }}
                        />
                        <button
                          type="button"
                          className="secondary"
                          onClick={() =>
                            updateOverlay(selectedOverlay.id, {
                              fields: {
                                ...selectedOverlay.fields,
                                titleOffsetY: selectedTitleOffset - 1,
                              },
                            })
                          }
                        >
                          +1
                        </button>
                      </div>
                    </div>
                    <label>Text</label>
                    <textarea
                      rows={4}
                      value={String(selectedOverlay.fields.text ?? selectedOverlay.fields.subtitle ?? "")}
                      placeholder="Text"
                      onChange={(event) =>
                        updateOverlay(selectedOverlay.id, {
                          fields: { ...selectedOverlay.fields, text: event.target.value },
                        })
                      }
                    />
                    <div className="text-controls">
                      <div>
                        <label>Text alignment</label>
                        <div className="segmented">
                          {TEXT_ALIGNMENTS.map((align) => (
                            <button
                              key={align}
                              type="button"
                              className={selectedTextAlign === align ? "secondary active" : "secondary"}
                              onClick={() =>
                                updateOverlay(selectedOverlay.id, {
                                  fields: { ...selectedOverlay.fields, textAlign: align },
                                })
                              }
                            >
                              {align}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <label>Text size (%)</label>
                        <input
                          type="number"
                          min={50}
                          max={200}
                          step={5}
                          value={selectedTextScalePercent}
                          onChange={(event) => {
                            const nextValue = Number(event.target.value);
                            if (!Number.isFinite(nextValue)) return;
                            const clamped = Math.min(200, Math.max(50, nextValue));
                            updateOverlay(selectedOverlay.id, {
                              fields: {
                                ...selectedOverlay.fields,
                                textScale: clamped / 100,
                              },
                            });
                          }}
                        />
                      </div>
                      <div className="text-margin-grid">
                        <div>
                          <label>Text margin left (px)</label>
                          <input
                            type="number"
                            min={0}
                            max={400}
                            step={2}
                            value={selectedTextMarginLeft}
                            onChange={(event) => {
                              const nextValue = Number(event.target.value);
                              if (!Number.isFinite(nextValue)) return;
                              const clamped = Math.min(400, Math.max(0, nextValue));
                              updateOverlay(selectedOverlay.id, {
                                fields: {
                                  ...selectedOverlay.fields,
                                  textMarginLeft: clamped,
                                },
                              });
                            }}
                          />
                        </div>
                        <div>
                          <label>Text margin right (px)</label>
                          <input
                            type="number"
                            min={0}
                            max={400}
                            step={2}
                            value={selectedTextMarginRight}
                            onChange={(event) => {
                              const nextValue = Number(event.target.value);
                              if (!Number.isFinite(nextValue)) return;
                              const clamped = Math.min(400, Math.max(0, nextValue));
                              updateOverlay(selectedOverlay.id, {
                                fields: {
                                  ...selectedOverlay.fields,
                                  textMarginRight: clamped,
                                },
                              });
                            }}
                          />
                        </div>
                      </div>
                      <div className="text-offset-row">
                        <label>Text vertical offset (px)</label>
                        <div className="text-offset-controls">
                          <button
                            type="button"
                            className="secondary"
                            onClick={() =>
                              updateOverlay(selectedOverlay.id, {
                                fields: {
                                  ...selectedOverlay.fields,
                                  textOffsetY: selectedTextOffset + 1,
                                },
                              })
                            }
                          >
                            -1
                          </button>
                          <input
                            type="number"
                            min={-400}
                            max={400}
                            step={1}
                            value={selectedTextOffset}
                            onChange={(event) => {
                              const nextValue = Number(event.target.value);
                              if (!Number.isFinite(nextValue)) return;
                              const clamped = Math.min(400, Math.max(-400, nextValue));
                              updateOverlay(selectedOverlay.id, {
                                fields: {
                                  ...selectedOverlay.fields,
                                  textOffsetY: clamped,
                                },
                              });
                            }}
                          />
                          <button
                            type="button"
                            className="secondary"
                            onClick={() =>
                              updateOverlay(selectedOverlay.id, {
                                fields: {
                                  ...selectedOverlay.fields,
                                  textOffsetY: selectedTextOffset - 1,
                                },
                              })
                            }
                          >
                            +1
                          </button>
                        </div>
                      </div>
                    </div>
                    <label>Slide-in frames</label>
                    <input
                      type="number"
                      value={selectedOverlay.motion?.slideInFrames ?? 0}
                      onChange={(event) =>
                        updateOverlayMotion(selectedOverlay.id, {
                          slideInFrames: Number(event.target.value),
                        })
                      }
                    />
                    <label>Display frames</label>
                    <input
                      type="number"
                      value={selectedOverlay.motion?.displayFrames ?? 0}
                      onChange={(event) =>
                        updateOverlayMotion(selectedOverlay.id, {
                          displayFrames: Number(event.target.value),
                        })
                      }
                    />
                    <label>Slide-out frames</label>
                    <input
                      type="number"
                      value={selectedOverlay.motion?.slideOutFrames ?? 0}
                      onChange={(event) =>
                        updateOverlayMotion(selectedOverlay.id, {
                          slideOutFrames: Number(event.target.value),
                        })
                      }
                    />
                  </>
                )}

                {isArrow(selectedOverlay) && (
                  <>
                    <label>Rotation (deg)</label>
                    <input
                      type="number"
                      value={selectedOverlay.rotationDeg ?? 0}
                      onChange={(event) =>
                        updateOverlay(selectedOverlay.id, {
                          rotationDeg: Number(event.target.value),
                        })
                      }
                    />
                    <div className="rotation-controls">
                      <button
                        className="secondary"
                        type="button"
                        onClick={() => rotateOverlay(selectedOverlay.id, -45)}
                      >
                        -45°
                      </button>
                      <button
                        className="secondary"
                        type="button"
                        onClick={() => rotateOverlay(selectedOverlay.id, 45)}
                      >
                        +45°
                      </button>
                    </div>
                    <label>Pulse period (frames)</label>
                    <input
                      type="number"
                      value={selectedOverlay.motion?.pulsePeriodFrames ?? 0}
                      onChange={(event) =>
                        updateOverlayMotion(selectedOverlay.id, {
                          pulsePeriodFrames: Number(event.target.value),
                        })
                      }
                    />
                    <label>Visible start frame</label>
                    <input
                      type="number"
                      value={selectedOverlay.motion?.visibleStartFrame ?? selectedOverlay.startFrame}
                      onChange={(event) =>
                        updateOverlayMotion(selectedOverlay.id, {
                          visibleStartFrame: Number(event.target.value),
                        })
                      }
                    />
                    <label>Visible end frame</label>
                    <input
                      type="number"
                      value={selectedOverlay.motion?.visibleEndFrame ?? selectedOverlay.endFrame}
                      onChange={(event) =>
                        updateOverlayMotion(selectedOverlay.id, {
                          visibleEndFrame: Number(event.target.value),
                        })
                      }
                    />
                  </>
                )}
              </>
            )}
            {!selectedOverlay && <div className="details">Select an overlay to edit.</div>}
          </div>

        </aside>
      </div>

      <section className="timeline">
        {project && hasMedia ? (
          <>
            <div className="scrubber">
              <input
                id="frame"
                type="range"
                min={0}
                max={Math.max(1, totalFrames - 1)}
                value={currentFrame}
                onChange={(event) => seekToFrame(Number(event.target.value))}
              />
              <div className="details">
                Frame {currentFrame} / {totalFrames}
              </div>
            </div>
            <div className="thumbnail-strip">
              {thumbnailFrames.map((frame: number, index: number) => (
                <img
                  key={`${frame}-${index}`}
                  src={thumbnailUrl(project.id, frame, 180)}
                  alt={`Frame ${frame}`}
                  className={frame === currentFrame ? "thumbnail active" : "thumbnail"}
                  onClick={() => seekToFrame(frame)}
                  onError={() =>
                    setThumbnailError((prev) => prev ?? `Thumbnail failed at frame ${frame}.`)
                  }
                />
              ))}
            </div>
            {thumbnailError && <div className="details warning">{thumbnailError}</div>}
            <div className="track-list">
            <div className="track-row">
              <div className="track-label">Video</div>
              <div className="track-lane">
                <div className="track-clip full">Source</div>
                <div
                  className="track-playhead"
                  style={{ left: `${(currentFrame / totalFrames) * 100}%` }}
                />
                {hasSourceSegments ? (
                  sourceSegments.map((segment, index) => {
                    const length = Math.max(1, segment.endFrameExclusive - segment.startFrame);
                    const left = (segment.startFrame / totalFrames) * 100;
                    const width = (length / totalFrames) * 100;
                    return (
                      <div
                        key={segment.id}
                        className="track-segment"
                        style={{ left: `${left}%`, width: `${Math.max(0.5, width)}%` }}
                        title={`${segment.label || `Segment ${index + 1}`} · ${segment.playbackRate.toFixed(2)}x`}
                      >
                        {index + 1}
                      </div>
                    );
                  })
                ) : (
                  <>
                    {trimRange.start > 0 && (
                      <div
                        className="track-trim"
                        style={{
                          left: "0%",
                          width: `${Math.max(0.5, (trimRange.start / totalFrames) * 100)}%`,
                        }}
                        title={`Trimmed start 0 → ${trimRange.start}`}
                      />
                    )}
                    {trimRange.end < totalFrames && (
                      <div
                        className="track-trim"
                        style={{
                          left: `${(trimRange.end / totalFrames) * 100}%`,
                          width: `${Math.max(
                            0.5,
                            ((totalFrames - trimRange.end) / totalFrames) * 100
                          )}%`,
                        }}
                        title={`Trimmed end ${trimRange.end} → ${totalFrames}`}
                      />
                    )}
                    {(edits.cuts ?? []).map((cut) => {
                      const length = Math.max(1, cut.endFrame - cut.startFrame + 1);
                      const left = (cut.startFrame / totalFrames) * 100;
                      const width = (length / totalFrames) * 100;
                      return (
                        <div
                          key={cut.id}
                          className="track-cut"
                          style={{ left: `${left}%`, width: `${Math.max(0.5, width)}%` }}
                          title={`Cut ${cut.startFrame} → ${cut.endFrame}`}
                        />
                      );
                    })}
                  </>
                )}
              </div>
            </div>
              <div className="track-row">
              <div className="track-label">Cards</div>
              <div className="track-lane">
                <div
                  className="track-playhead"
                  style={{ left: `${(currentFrame / totalFrames) * 100}%` }}
                />
                {project.overlays
                  .filter((overlay) => !isArrow(overlay))
                  .map((overlay) => {
                      const range = getOverlayVisibleRange(overlay);
                      const left = (range.start / totalFrames) * 100;
                      const spanFrames = Math.max(1, range.end - range.start + 1);
                      const width = (spanFrames / totalFrames) * 100;
                      return (
                        <div
                          key={overlay.id}
                          className="track-clip card"
                          style={{ left: `${left}%`, width: `${Math.max(2, width)}%` }}
                          onClick={() => selectOverlayById(overlay.id)}
                        >
                          {overlay.templateId}
                        </div>
                      );
                    })}
                </div>
              </div>
              <div className="track-row">
              <div className="track-label">Arrows</div>
              <div className="track-lane">
                <div
                  className="track-playhead"
                  style={{ left: `${(currentFrame / totalFrames) * 100}%` }}
                />
                {project.overlays
                  .filter((overlay) => isArrow(overlay))
                  .map((overlay) => {
                      const range = getOverlayVisibleRange(overlay);
                      const left = (range.start / totalFrames) * 100;
                      const spanFrames = Math.max(1, range.end - range.start + 1);
                      const width = (spanFrames / totalFrames) * 100;
                      return (
                        <div
                          key={overlay.id}
                          className="track-clip arrow"
                          style={{ left: `${left}%`, width: `${width}%` }}
                          onClick={() => selectOverlayById(overlay.id)}
                        >
                          Arrow
                        </div>
                      );
                    })}
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="details warning">Import a video to enable the scrubber.</div>
        )}
      </section>

      <section className="render-dock">
        <div className="render-dock-actions">
          <div className="render-buttons">
            <button className="secondary" onClick={handleSaveProject} disabled={!project}>
              Save
            </button>
            <button onClick={handleRenderFinal} disabled={!project || selectedPresetUnavailable}>
              {isRoughPreview ? "Render preview" : "Render final"}
            </button>
            {!isRoughPreview && (
              <button
                className="secondary"
                onClick={handlePatchLatestFinal}
                disabled={!canPatchLatestFinal}
              >
                Patch latest final
              </button>
            )}
            {renderReady && downloadUrl && (
              <a
                className="button-link"
                href={downloadUrl}
                target="_blank"
                rel="noreferrer"
              >
                {isRoughPreview ? "Download preview" : "Download final"}
              </a>
            )}
            {renderReady && renderFinalPath && (
              <button className="secondary" onClick={handleCopyFinalPath}>
                {isRoughPreview ? "Copy preview path" : "Copy final path"}
              </button>
            )}
          </div>
          {!isRoughPreview && <div className="details">{patchStatusMessage}</div>}
          <div className="autosave-controls">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={autosaveEnabled}
                onChange={(event) => setAutosaveEnabled(event.target.checked)}
              />
              Autosave
            </label>
            <label className="autosave-interval">
              <span>Every</span>
              <input
                type="number"
                min={MIN_AUTOSAVE_INTERVAL_SEC}
                max={MAX_AUTOSAVE_INTERVAL_SEC}
                value={autosaveIntervalSec}
                disabled={!autosaveEnabled}
                onChange={(event) =>
                  setAutosaveIntervalSec(clampAutosaveInterval(Number(event.target.value)))
                }
              />
              <span>s</span>
            </label>
            <div className="details">
              {autosavePausedProjectId === selectedId
                ? "Paused for external update"
                : autosaveEnabled
                  ? lastAutosaveAt
                    ? `Autosaved ${lastAutosaveAt}`
                    : "Autosave ready"
                  : "Autosave off"}
            </div>
          </div>
          {renderProgress !== null && (
            <div className="progress slim">
              <div className="progress-bar" style={{ width: `${renderProgress * 100}%` }} />
            </div>
          )}
        </div>
        <div className="render-settings-grid">
          <div className="render-setting">
            <label htmlFor="render-mode">Render mode</label>
            <select
              id="render-mode"
              value={renderOptions.renderMode}
              disabled={!project}
              onChange={(event) => {
                const nextMode = event.target.value as "final" | "rough";
                setRenderOptions((prev) => ({ ...prev, renderMode: nextMode }));
              }}
            >
              {RENDER_MODE_OPTIONS.map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.label}
                </option>
              ))}
            </select>
            {isRoughPreview && (
              <div className="details">Rough preview renders at ~960x540 / 15 fps.</div>
            )}
          </div>
          <div className="render-setting">
            <label htmlFor="preset">Quality</label>
            <select
              id="preset"
              value={renderOptions.presetId ?? DEFAULT_PRESET_ID}
              disabled={!project || isRoughPreview}
              onChange={(event) => {
                const nextPresetId = event.target.value;
                setRenderOptions((prev) => ({ ...prev, presetId: nextPresetId }));
                if (project) {
                  updateProjectState(
                    { ...project, lastExportPresetId: nextPresetId },
                    undefined,
                    { pushHistory: false }
                  );
                }
              }}
            >
              {renderPresetOptions.map((preset) => (
                <option key={preset.id} value={preset.id} disabled={preset.unavailable}>
                  {preset.label}
                </option>
              ))}
            </select>
            {!isRoughPreview && <div className="details">{hardwarePresetMessage}</div>}
          </div>
          <div className="render-setting">
            <label htmlFor="speed">Speed</label>
            <select
              id="speed"
              value={renderOptions.speed}
              disabled={!project || hasSourceSegments}
              onChange={(event) => {
                const nextSpeed = Number(event.target.value) as 1 | 2;
                setRenderOptions((prev) => ({ ...prev, speed: nextSpeed }));
                updateProjectExportOptions({ speed: nextSpeed });
              }}
            >
              <option value={1}>1× (normal)</option>
              <option value={2}>2× (fast)</option>
            </select>
          </div>
          <div className="render-setting">
            <label>Audio</label>
            <label className="checkbox">
              <input
                type="checkbox"
                disabled={!project || !hasAudio}
                checked={renderOptions.includeAudio && hasAudio}
                onChange={(event) => {
                  const nextIncludeAudio = event.target.checked;
                  setRenderOptions((prev) => ({ ...prev, includeAudio: nextIncludeAudio }));
                  updateProjectExportOptions({ includeAudio: nextIncludeAudio });
                }}
              />
              Include source audio
            </label>
            {!hasAudio && project && (
              <div className="details">No audio track detected in source.</div>
            )}
          </div>
          <div className="render-setting audio-track-setting">
            <label>External audio</label>
            <input
              type="file"
              accept=".mp3,.wav,.m4a,.aac,.flac,.ogg,.oga,.opus,audio/*"
              disabled={!project}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void handleImportAudioFile(file);
              }}
            />
            <div className="audio-url-row">
              <input
                type="url"
                value={audioUrlInput}
                placeholder="https://..."
                disabled={!project}
                onChange={(event) => setAudioUrlInput(event.target.value)}
              />
              <button
                className="secondary"
                type="button"
                disabled={!project || !audioUrlInput.trim()}
                onClick={() => void handleImportAudioUrl()}
              >
                Import
              </button>
            </div>
            <div className="audio-track-controls">
              <select
                value={project?.audioTrack?.mode ?? "overlay"}
                disabled={!project?.audioTrack}
                onChange={(event) =>
                  updateExternalAudioTrack({ mode: event.target.value as AudioTrack["mode"] })
                }
              >
                <option value="overlay">Overlay</option>
                <option value="replace">Replace</option>
              </select>
              <input
                type="number"
                min={0}
                step={0.1}
                value={project?.audioTrack?.startSec ?? 0}
                disabled={!project?.audioTrack}
                onChange={(event) =>
                  updateExternalAudioTrack({ startSec: Number(event.target.value) })
                }
              />
              <button
                className="secondary"
                type="button"
                disabled={!project?.audioTrack}
                onClick={() => updateExternalAudioTrack(null)}
              >
                Clear
              </button>
            </div>
            <div className="audio-fade-controls">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={Boolean(project?.audioTrack?.fadeOut?.enabled)}
                  disabled={!project?.audioTrack}
                  onChange={(event) =>
                    updateExternalAudioTrack({
                      fadeOut: event.target.checked
                        ? {
                            enabled: true,
                            target: "tailSlug",
                            durationSec: project?.audioTrack?.fadeOut?.durationSec ?? 2,
                          }
                        : undefined,
                    })
                  }
                />
                Fade at outro
              </label>
              <input
                type="number"
                min={0.1}
                step={0.1}
                value={project?.audioTrack?.fadeOut?.durationSec ?? 2}
                disabled={!project?.audioTrack?.fadeOut?.enabled}
                onChange={(event) =>
                  updateExternalAudioTrack({
                    fadeOut: {
                      enabled: true,
                      target: project?.audioTrack?.fadeOut?.target ?? "tailSlug",
                      durationSec: Number(event.target.value),
                    },
                  })
                }
              />
            </div>
            {project?.audioTrack && (
              <div className="details">
                {project.audioTrack.filename ?? pathBasename(project.audioTrack.assetPath)} ·{" "}
                starts at {formatSeconds(project.audioTrack.startSec)}
                {project.audioTrack.fadeOut?.enabled
                  ? ` · fades at outro over ${formatSeconds(
                      project.audioTrack.fadeOut.durationSec
                    )}`
                  : ""}
              </div>
            )}
          </div>
          <div className="render-setting">
            <label htmlFor="slug-select">Slug video</label>
            <select
              id="slug-select"
              value={selectedSlugOption?.id ?? ""}
              disabled={!project || !slugLibrary.length}
              onChange={(event) => applySlugSelection(event.target.value)}
            >
              <option value="">No slug</option>
              {slugLibrary.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            {!slugLibrary.length && <div className="details">Import a slug MP4 to enable slugs.</div>}
          </div>
          <div className="render-setting">
            <label>Include slug</label>
            <div className="slug-flags">
              <label className="checkbox">
                <input
                  type="checkbox"
                  disabled={!selectedSlugOption || !project}
                  checked={renderOptions.includeSlugStart}
                  onChange={(event) =>
                    applySlugFlags(event.target.checked, renderOptions.includeSlugEnd)
                  }
                />
                Start
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  disabled={!selectedSlugOption || !project}
                  checked={renderOptions.includeSlugEnd}
                  onChange={(event) =>
                    applySlugFlags(renderOptions.includeSlugStart, event.target.checked)
                  }
                />
                End
              </label>
            </div>
          </div>
          <div className="render-setting">
            <label>Slug transition</label>
            <select
              value={slugTransition.type}
              disabled={!selectedSlugOption || !project}
              onChange={(event) => {
                const nextType = event.target.value as "cut" | "crossfade";
                updateSlugTransition({
                  type: nextType,
                  durationFrames:
                    nextType === "crossfade"
                      ? slugTransition.durationFrames || DEFAULT_CROSSFADE_FRAMES
                      : 0,
                });
              }}
            >
              <option value="cut">Hard cut</option>
              <option value="crossfade">Crossfade</option>
            </select>
            <input
              type="number"
              min={0}
              value={slugTransition.durationFrames}
              disabled={!selectedSlugOption || !project || slugTransition.type !== "crossfade"}
              onChange={(event) =>
                updateSlugTransition({
                  type: "crossfade",
                  durationFrames: Number(event.target.value),
                })
              }
            />
          </div>
        </div>
        <div className="render-divider" />
        <div className={`segment-section ${sourceSegmentsOpen ? "open" : ""}`}>
          <div className="segment-header">
            <button
              className="segment-toggle"
              type="button"
              aria-expanded={sourceSegmentsOpen}
              aria-controls="source-segments-panel"
              onClick={() => setSourceSegmentsOpen((value) => !value)}
            >
              <span className="segment-chevron" aria-hidden="true" />
              <span>
                <span className="segment-title">Source segments</span>
                <span className="details">
                  {hasSourceSegments
                    ? `${sourceSegments.length} kept, ${formatSeconds(sourceSegmentsOutput.seconds)} output`
                    : "No source segments"}
                </span>
              </span>
            </button>
            <button className="secondary" onClick={addSourceSegment} disabled={!hasMedia}>
              Add segment
            </button>
          </div>
          {sourceSegmentsOpen && (
            <div id="source-segments-panel" className="segment-panel">
              <textarea
                className="timeline-recipe"
                disabled={!hasMedia}
                value={sourceTimelineText}
                onChange={(event) => setSourceTimelineText(event.target.value)}
                placeholder="0s-20s (2x speed) = Opening"
              />
              <div className="segment-actions">
                <button
                  className="secondary"
                  disabled={!hasMedia || !sourceTimelineText.trim()}
                  onClick={() => parseSourceTimelineRecipe(false)}
                >
                  Preview recipe
                </button>
                <button
                  disabled={!hasMedia || !sourceTimelineText.trim()}
                  onClick={() => parseSourceTimelineRecipe(true)}
                >
                  Apply recipe
                </button>
                {hasSourceSegments && (
                  <button className="danger" onClick={() => applySourceSegments([])}>
                    Clear segments
                  </button>
                )}
              </div>
              {sourceTimelineOutput && (
                <div className="details">
                  Preview output {formatSeconds(sourceTimelineOutput.outputDurationSeconds)} ·{" "}
                  {sourceTimelineOutput.outputFrames} frames
                </div>
              )}
              {sourceTimelineWarnings.map((warning) => (
                <div key={warning} className="details warning">
                  {warning}
                </div>
              ))}
              <div className="segment-list">
            {sourceSegments.map((segment, index) => {
              const isImageSegment = segment.kind === "image";
              const sourceFrames = Math.max(1, segment.endFrameExclusive - segment.startFrame);
              const outputFrames = isImageSegment
                ? Math.max(1, segment.durationFrames ?? 1)
                : Math.max(1, Math.round(sourceFrames / Math.max(0.01, segment.playbackRate)));
              const outputSeconds = outputFrames / fps;
              return (
                <div key={segment.id} className="segment-card">
                  <div className="segment-card-header">
                    <input
                      value={segment.label ?? ""}
                      disabled={!hasMedia}
                      placeholder={`Segment ${index + 1}`}
                      onChange={(event) =>
                        updateSourceSegment(segment.id, { label: event.target.value })
                      }
                    />
                    <div className="segment-move">
                      <button
                        className="secondary"
                        disabled={index === 0}
                        onClick={() => moveSourceSegment(segment.id, -1)}
                      >
                        Up
                      </button>
                      <button
                        className="secondary"
                        disabled={index === sourceSegments.length - 1}
                        onClick={() => moveSourceSegment(segment.id, 1)}
                      >
                        Down
                      </button>
                    </div>
                  </div>
                  <div className="segment-grid">
                    <label>
                      Start
                      <input
                        type="number"
                        min={0}
                        max={Math.max(0, totalFrames - 1)}
                        value={segment.startFrame}
                        disabled={!hasMedia || isImageSegment}
                        onChange={(event) =>
                          updateSourceSegment(segment.id, {
                            startFrame: Number(event.target.value),
                          })
                        }
                      />
                    </label>
                    <label>
                      End
                      <input
                        type="number"
                        min={1}
                        max={totalFrames}
                        value={segment.endFrameExclusive}
                        disabled={!hasMedia || isImageSegment}
                        onChange={(event) =>
                          updateSourceSegment(segment.id, {
                            endFrameExclusive: Number(event.target.value),
                          })
                        }
                      />
                    </label>
                    <label>
                      Speed
                      <input
                        type="number"
                        min={0.01}
                        step={0.01}
                        value={Number(segment.playbackRate.toFixed(3))}
                        disabled={!hasMedia || isImageSegment}
                        onChange={(event) =>
                          updateSourceSegment(segment.id, {
                            playbackRate: Number(event.target.value),
                          })
                        }
                      />
                    </label>
                    <label>
                      Audio
                      <select
                        value={segment.audio ?? "preserve"}
                        disabled={!hasMedia || !hasAudio || isImageSegment}
                        onChange={(event) =>
                          updateSourceSegment(segment.id, {
                            audio: event.target.value as "preserve" | "mute",
                          })
                        }
                      >
                        <option value="preserve">Preserve</option>
                        <option value="mute">Mute</option>
                      </select>
                    </label>
                  </div>
                  <div className="segment-meta">
                    {isImageSegment
                      ? `${segment.assetPath ?? "PNG still"} · Still frame`
                      : `${formatTimecode(segment.startFrame, fps)} → ${formatTimecode(
                          segment.endFrameExclusive,
                          fps
                        )}`} ·{" "}
                    {formatSeconds(outputSeconds)}
                  </div>
                  <button className="danger" onClick={() => removeSourceSegment(segment.id)}>
                    Remove segment
                  </button>
                </div>
              );
            })}
              </div>
            </div>
          )}
        </div>
        <div className="render-divider" />
        <div className="trim-section">
          <h3>Trim a clip</h3>
          <div className="trim-grid">
            <div className="trim-block">
              <label>Trim start time</label>
              <div className="trim-row">
                <input
                  type="text"
                  disabled={!hasMedia}
                  value={trimStartTime}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    setTrimStartTime(nextValue);
                    const seconds = parseCompleteTimecode(nextValue);
                    if (seconds !== null) {
                      setTrimStartFrames(Math.round(seconds * fps));
                    }
                  }}
                  onBlur={() => {
                    const seconds = parseCompleteTimecode(trimStartTime);
                    if (seconds !== null) {
                      setTrimStartFrames(Math.round(seconds * fps));
                      return;
                    }
                    setTrimStartTime(formatTimecode(trimRange.start, fps));
                  }}
                />
              </div>
              <div className="details">HH:MM:SS.SSS</div>
            </div>
            <div className="trim-block">
              <label>Trim end time</label>
              <div className="trim-row">
                <input
                  type="text"
                  disabled={!hasMedia}
                  value={trimEndTime}
                  placeholder={fullDurationTime}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    setTrimEndTime(nextValue);
                    const seconds = parseCompleteTimecode(nextValue);
                    if (seconds !== null) {
                      setTrimEndFrames(Math.round(seconds * fps));
                    }
                  }}
                  onBlur={() => {
                    const seconds = parseCompleteTimecode(trimEndTime);
                    if (seconds !== null) {
                      setTrimEndFrames(Math.round(seconds * fps));
                      return;
                    }
                    setTrimEndTime(formatTimecode(trimRange.end, fps));
                  }}
                />
              </div>
              <div className="details">HH:MM:SS.SSS</div>
            </div>
          </div>
          {trimInvalid && (
            <div className="details warning">Trim end must be after trim start.</div>
          )}
          <div className="cut-header">
            <h4>Cut sections</h4>
            <button className="secondary" onClick={addCut} disabled={!hasMedia}>
              Add cut
            </button>
          </div>
          <div className="cut-list">
            {(edits.cuts ?? []).map((cut) => (
              <div key={cut.id} className="cut-card">
                <div className="cut-row">
                  <label>Start</label>
                  <input
                    type="number"
                    min={0}
                    disabled={!hasMedia}
                    value={cut.startFrame}
                    onChange={(event) =>
                      updateCut(cut.id, { startFrame: Number(event.target.value) })
                    }
                  />
                  <button
                    className="secondary"
                    disabled={!hasMedia}
                    onClick={() => updateCut(cut.id, { startFrame: currentFrame })}
                  >
                    Use playhead
                  </button>
                </div>
                <div className="cut-row">
                  <label>End</label>
                  <input
                    type="number"
                    min={0}
                    disabled={!hasMedia}
                    value={cut.endFrame}
                    onChange={(event) =>
                      updateCut(cut.id, { endFrame: Number(event.target.value) })
                    }
                  />
                  <button
                    className="secondary"
                    disabled={!hasMedia}
                    onClick={() => updateCut(cut.id, { endFrame: currentFrame })}
                  >
                    Use playhead
                  </button>
                </div>
                <div className="cut-row">
                  <label>Transition</label>
                  <select
                    value={cut.transition?.type ?? "cut"}
                    disabled={!hasMedia}
                    onChange={(event) =>
                      updateCut(cut.id, {
                        transition: {
                          type: event.target.value as "cut" | "crossfade",
                          durationFrames: cut.transition?.durationFrames ?? 12,
                        },
                      })
                    }
                  >
                    <option value="cut">Hard cut</option>
                    <option value="crossfade">Crossfade</option>
                  </select>
                  <input
                    type="number"
                    min={0}
                    value={cut.transition?.durationFrames ?? 12}
                    disabled={!hasMedia || cut.transition?.type !== "crossfade"}
                    onChange={(event) =>
                      updateCut(cut.id, {
                        transition: {
                          type: "crossfade",
                          durationFrames: Number(event.target.value),
                        },
                      })
                    }
                  />
                </div>
                <div className="cut-actions">
                  <button className="danger" onClick={() => removeCut(cut.id)}>
                    Remove cut
                  </button>
                </div>
              </div>
            ))}
            {!edits.cuts?.length && (
              <div className="details">No cuts yet. Use “Add cut” to remove a section.</div>
            )}
          </div>
        </div>
        <div className="render-log-header">FFmpeg status</div>
        <div className="render-log" aria-live="polite">
          {renderLogs.length ? (
            renderLogs.map((line, index) => <div key={`${index}-${line}`}>{line}</div>)
          ) : (
            <div className="details">{renderActive ? "Waiting for output..." : "No renders yet."}</div>
          )}
        </div>
      </section>

      {toast && <div className="toast" role="status">{toast}</div>}
      {status && <div className="status">{status}</div>}
      {showHotkeys && (
        <div className="hotkey-overlay" onClick={() => setShowHotkeys(false)}>
          <div className="hotkey-card" onClick={(event) => event.stopPropagation()}>
            <h3>Hotkeys</h3>
            <div className="hotkey-row">
              <span className="keys">Ctrl + Z</span>
              <span>Undo</span>
            </div>
            <div className="hotkey-row">
              <span className="keys">Ctrl + Y</span>
              <span>Redo</span>
            </div>
            <div className="hotkey-row">
              <span className="keys">Ctrl + /</span>
              <span>Toggle hotkeys</span>
            </div>
            <div className="hotkey-row">
              <span className="keys">Left/Right</span>
              <span>Step 1 frame (preview focus)</span>
            </div>
            <div className="hotkey-row">
              <span className="keys">Up/Down</span>
              <span>Step 15 frames</span>
            </div>
            <div className="hotkey-row">
              <span className="keys">Esc</span>
              <span>Close</span>
            </div>
            <div className="hotkey-row">
              <span className="keys">Delete</span>
              <span>Remove selected overlay</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
