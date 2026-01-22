import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import type { Group as KonvaGroup } from "konva/lib/Group";
import type { Transformer as KonvaTransformer } from "konva/lib/shapes/Transformer";
import { Arrow, Group, Image as KonvaImage, Layer, Rect, Stage, Text, Transformer } from "react-konva";
import {
  assetUrl,
  createProject,
  deleteProject,
  exportLatestUrl,
  getProject,
  importVideo,
  listProjects,
  listTemplates,
  mediaUrl,
  renderStreamUrl,
  thumbnailUrl,
  updateProject,
  type ArrowInfo,
  type Overlay,
  type Project,
  type ProjectSummary,
  type TemplateInfo,
} from "./api";

const DEFAULT_CARD_SIZE = { w: 1100, h: 180 };
const DEFAULT_ARROW_SIZE = { w: 128, h: 128 };

const SLUG_OPTIONS = [
  {
    id: "k1s-title-variant3",
    label: "K1s Title Variant 3 (3s)",
    path: "slug/k1s-title-variant3-motion-loop-3s_1080p30.mp4",
    fps: 30,
  },
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

const DEFAULT_TITLE_SCALE = 0.95;
const DEFAULT_TEXT_SCALE = 1;
const BASE_TITLE_OFFSET = -13;
const BASE_TEXT_OFFSET = -27;
const OFFSET_MODE_KEY = "offsetMode";
const OFFSET_MODE_DELTA = "delta-v1";

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
  const [currentFrame, setCurrentFrame] = useState(0);
  const [videoDurationSec, setVideoDurationSec] = useState(0);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [renderOptions, setRenderOptions] = useState({
    speed: 1 as 1 | 2,
    includeSlugStart: false,
    includeSlugEnd: false,
  });
  const [renderProgress, setRenderProgress] = useState<number | null>(null);
  const [renderLogs, setRenderLogs] = useState<string[]>([]);
  const [renderActive, setRenderActive] = useState(false);
  const [renderReady, setRenderReady] = useState(false);
  const [leftTab, setLeftTab] = useState<"media" | "overlays" | "exports">("media");
  const [thumbnailError, setThumbnailError] = useState<string | null>(null);
  const [templateLibrary, setTemplateLibrary] = useState<TemplateInfo[]>([]);
  const [arrowLibrary, setArrowLibrary] = useState<ArrowInfo[]>([]);
  const [templateImages, setTemplateImages] = useState<Record<string, HTMLImageElement>>({});
  const [arrowImage, setArrowImage] = useState<HTMLImageElement | null>(null);
  const [showHotkeys, setShowHotkeys] = useState(false);
  const [trimStartTime, setTrimStartTime] = useState("00:00:00.000");
  const [trimEndTime, setTrimEndTime] = useState("00:00:00.000");
  const seekPauseRef = useRef(false);
  const isPlayingRef = useRef(false);
  const historyRef = useRef<{ past: HistoryEntry[]; future: HistoryEntry[] }>({
    past: [],
    future: [],
  });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRefs = useRef<Record<string, KonvaGroup>>({});
  const transformerRef = useRef<KonvaTransformer | null>(null);
  const videoWrapperRef = useRef<HTMLDivElement | null>(null);
  const [stageMetrics, setStageMetrics] = useState<StageMetrics>({
    width: 0,
    height: 0,
    scaleX: 1,
    scaleY: 1,
  });

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
    SLUG_OPTIONS.find((option) => option.path === selectedSlugPath) ?? null;
  const edits = project?.edits ?? { trimStartFrames: 0, trimEndFrames: 0, cuts: [] };
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
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setProject(null);
      setSelectedOverlayId(null);
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
        historyRef.current = { past: [], future: [] };
      })
      .catch((error: unknown) => setStatus((error as Error).message));
  }, [selectedId]);

  useEffect(() => {
    setRenderReady(false);
  }, [selectedId]);

  useEffect(() => {
    if (!project) return;
    const includeSlugStart =
      project.exportOptions?.includeSlugStart ?? project.exportOptions?.includeSlug ?? false;
    const includeSlugEnd =
      project.exportOptions?.includeSlugEnd ?? project.exportOptions?.includeSlug ?? false;
    setRenderOptions((prev) => ({
      ...prev,
      speed: project.exportOptions?.speed ?? prev.speed,
      includeSlugStart,
      includeSlugEnd,
    }));
  }, [project?.id]);

  useEffect(() => {
    if (!project) return;
    setTrimStartTime(formatTimecode(trimRange.start, fps));
    setTrimEndTime(formatTimecode(trimRange.end, fps));
  }, [project?.id, trimRange.start, trimRange.end, fps]);

  useEffect(() => {
    if (!templateLibrary.length) return;
    templateLibrary.forEach((template) => {
      if (templateImages[template.id]) return;
      const image = new window.Image();
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

  useEffect(() => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = currentFrame / fps;
    if (seekPauseRef.current) {
      videoRef.current.pause();
      isPlayingRef.current = false;
      seekPauseRef.current = false;
    }
  }, [currentFrame, fps]);

  function seekToFrame(frame: number, pause = true) {
    if (pause) {
      seekPauseRef.current = true;
    }
    setCurrentFrame(frame);
  }

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

  function updateProjectState(
    next: Project,
    nextSelectedId?: string | null,
    options: { pushHistory?: boolean } = {}
  ) {
    const shouldPush = options.pushHistory ?? true;
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
    const nextExportOptions = { ...project.exportOptions, ...patch };
    updateProjectState({ ...project, exportOptions: nextExportOptions }, undefined, {
      pushHistory: false,
    });
  }

  function updateEdits(patch: Partial<NonNullable<Project["edits"]>>) {
    if (!project) return;
    const nextEdits = { ...project.edits, ...patch };
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

  function updateCut(id: string, patch: Partial<(NonNullable<Project["edits"]>["cuts"])[number]>) {
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

  function applySlugSelection(slugId: string) {
    if (!project) return;
    const slugOption = SLUG_OPTIONS.find((option) => option.id === slugId) ?? null;
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
            ...project.exportOptions,
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
        slug: { introPath: slugOption.path, outroPath: slugOption.path, fps: slugOption.fps },
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
    setSelectedOverlayId(next.selectedOverlayId);
    setCurrentFrame(next.currentFrame);
  }, [project, selectedOverlayId, currentFrame]);

  function updateOverlay(id: string, patch: Partial<Overlay>) {
    if (!project) return;
    const overlays = project.overlays.map((overlay: Overlay) =>
      overlay.id === id ? { ...overlay, ...patch } : overlay
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
    const next = value % 360;
    return next < 0 ? next + 360 : next;
  }

  function rotateOverlay(id: string, delta: number) {
    if (!project) return;
    const overlay = project.overlays.find((item) => item.id === id);
    if (!overlay) return;
    const nextRotation = normalizeRotation((overlay.rotationDeg ?? 0) + delta);
    updateOverlay(id, { rotationDeg: nextRotation });
  }

  function isOverlayAnchoredAtFrame(overlay: Overlay, frame: number) {
    return formatFrame(overlay.startFrame) === frame;
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
      const remaining = project.overlays
        .filter((overlay) => overlay.id !== id)
        .map((overlay, nextIndex) => ({ ...overlay, zIndex: nextIndex }));
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
  }, [selectedOverlayId, removeOverlay, undo, redo, showHotkeys]);

  function createCardOverlay(templateId: string, x?: number, y?: number) {
    if (!project) return;
    const id = crypto.randomUUID();
    const start = currentFrame;
    const end = start + Math.floor(fps * 5);
    const template = templateMap[templateId];
    const templateAlign = resolveTemplateAlign(templateId, template);
    const defaultMargins = getDefaultTextMargins(templateAlign);
    const baseRect = getTemplateRect(templateId);
    const rectX = typeof x === "number" ? Math.max(0, x) : baseRect.x;
    const rectY = typeof y === "number" ? Math.max(0, y) : baseRect.y;
    const overlay: Overlay = {
      id,
      templateId,
      templateVersion: "1",
      startFrame: start,
      endFrame: end,
      rect: {
        x: rectX,
        y: rectY,
        w: baseRect.w,
        h: baseRect.h,
      },
      rotationDeg: 0,
      opacity: 1,
      zIndex: project.overlays.length,
      fields: {
        title: "",
        text: "",
        titleScale: DEFAULT_TITLE_SCALE,
        textScale: DEFAULT_TEXT_SCALE,
        titleOffsetY: 0,
        textOffsetY: 0,
        [OFFSET_MODE_KEY]: OFFSET_MODE_DELTA,
        textMarginLeft: defaultMargins.left,
        textMarginRight: defaultMargins.right,
      },
      motion: {
        slideInFrames: 12,
        displayFrames: Math.floor(fps * 3),
        slideOutFrames: 12,
        slideDirection: "fromLeft",
      },
    };
    updateProjectState({ ...project, overlays: [...project.overlays, overlay] });
    setSelectedOverlayId(id);
  }

  function createArrowOverlay(x?: number, y?: number) {
    if (!project) return;
    const id = crypto.randomUUID();
    const start = currentFrame;
    const end = start + Math.floor(fps * 2);
    const size = getArrowSize();
    const fallbackX = project ? project.video.width / 2 - size.w / 2 : 320;
    const fallbackY = project ? project.video.height / 2 - size.h / 2 : 240;
    const overlay: Overlay = {
      id,
      templateId: arrowTemplate?.id ?? "arrow-right",
      templateVersion: "1",
      startFrame: start,
      endFrame: end,
      rect: {
        x: typeof x === "number" ? Math.max(0, x) : fallbackX,
        y: typeof y === "number" ? Math.max(0, y) : fallbackY,
        w: size.w,
        h: size.h,
      },
      rotationDeg: 0,
      opacity: 1,
      zIndex: project.overlays.length,
      fields: {},
      motion: {
        visibleStartFrame: start,
        visibleEndFrame: end,
        pulsePeriodFrames: Math.floor(fps * 0.8),
        pulseMinAlpha: 0.65,
        pulseMaxAlpha: 1,
      },
    };
    updateProjectState({ ...project, overlays: [...project.overlays, overlay] });
    setSelectedOverlayId(id);
  }

  function addOverlayCard() {
    createCardOverlay("card-lower-third-left");
  }

  function addOverlayArrow() {
    createArrowOverlay();
  }

  async function handleSaveProject() {
    if (!project || !selectedId) return;
    setStatus("Saving project...");
    try {
      const saved = await updateProject(selectedId, project);
      updateProjectState(saved, undefined, { pushHistory: false });
      await refreshProjects(selectedId);
      setStatus("Project saved.");
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  async function handleRenderFinal() {
    if (!project || !selectedId) return;
    setStatus("Starting render...");
    setRenderProgress(0);
    setRenderLogs([]);
    setRenderActive(true);
    setRenderReady(false);
    try {
      await handleSaveProject();
      const es = new EventSource(renderStreamUrl(selectedId, renderOptions));
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
        setStatus(`Render complete: ${data.message ?? "Done"}`);
        setRenderProgress(1);
        pushRenderLog(`Render complete: ${data.message ?? "Done"}`);
        setRenderActive(false);
        setRenderReady(true);
        es.close();
      });
      es.addEventListener("error", (event) => {
        const data = parsePayload(event);
        const message = `Render error: ${data.message ?? "unknown"}`;
        setStatus(message);
        pushRenderLog(message);
        setRenderActive(false);
        es.close();
      });
    } catch (error) {
      setStatus((error as Error).message);
      setRenderActive(false);
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
          <h1>Content Tools Studio</h1>
          <div className="subtitle">
            Editing workspace · {project ? project.name : "Select a project"} · Frame {currentFrame}
          </div>
        </div>
      </header>

      <div className="editor-grid">
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
                  {project.overlays.map((overlay: Overlay) => (
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
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {leftTab === "exports" && (
            <div className="panel-block">
              <div className="details">Final renders live in workspace exports folder.</div>
              <div className="actions">
                <button onClick={handleRenderFinal} disabled={!project}>
                  Render final
                </button>
              </div>
            </div>
          )}
        </aside>

        <section className="editor-center">
          <div
            className="preview-pane"
            ref={videoWrapperRef}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
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
                    setCurrentFrame(formatFrame(time * fps));
                  }}
                  onPlay={() => {
                    isPlayingRef.current = true;
                  }}
                  onPause={() => {
                    isPlayingRef.current = false;
                  }}
                />
                {stageMetrics.width > 0 && (
                  <Stage
                    width={stageMetrics.width}
                    height={stageMetrics.height}
                    className="overlay-stage"
                  >
                    <Layer>
                      {project.overlays
                        .filter((overlay: Overlay) => isOverlayAnchoredAtFrame(overlay, currentFrame))
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
                      const left = (overlay.startFrame / totalFrames) * 100;
                      const width =
                        ((overlay.endFrame - overlay.startFrame) / totalFrames) * 100;
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
                      const left = (overlay.startFrame / totalFrames) * 100;
                      const width =
                        ((overlay.endFrame - overlay.startFrame) / totalFrames) * 100;
                      return (
                        <div
                          key={overlay.id}
                          className="track-clip arrow"
                          style={{ left: `${left}%`, width: `${Math.max(2, width)}%` }}
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
            <button onClick={handleRenderFinal} disabled={!project}>
              Render final
            </button>
            {renderReady && downloadUrl && (
              <a
                className="button-link"
                href={downloadUrl}
                target="_blank"
                rel="noreferrer"
              >
                Download final
              </a>
            )}
          </div>
          {renderProgress !== null && (
            <div className="progress slim">
              <div className="progress-bar" style={{ width: `${renderProgress * 100}%` }} />
            </div>
          )}
        </div>
        <div className="render-settings-grid">
          <div className="render-setting">
            <label htmlFor="speed">Speed</label>
            <select
              id="speed"
              value={renderOptions.speed}
              disabled={!project}
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
            <label htmlFor="slug-select">Slug video</label>
            <select
              id="slug-select"
              value={selectedSlugOption?.id ?? ""}
              disabled={!project}
              onChange={(event) => applySlugSelection(event.target.value)}
            >
              <option value="">No slug</option>
              {SLUG_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
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
