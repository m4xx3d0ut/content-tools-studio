import type { CommandResult, EditorCommand, OverlayPatch } from "./automation.js";
import {
  ProjectSchema,
  SourceSegmentSchema,
  type Overlay,
  type Project,
  type SourceSegment,
  type VideoInfo,
} from "./project.js";
import { parseSourceTimelineText } from "./source-timeline.js";

export const DEFAULT_CARD_SIZE = { w: 1100, h: 180 };
export const DEFAULT_ARROW_SIZE = { w: 128, h: 128 };
export const DEFAULT_TEMPLATE_ID = "card-lower-third-left";
export const DEFAULT_TITLE_SCALE = 0.95;
export const DEFAULT_TEXT_SCALE = 1;
export const OFFSET_MODE_KEY = "offsetMode";
export const OFFSET_MODE_DELTA = "delta-v1";

export type TextAlignment = "left" | "center" | "right";

export type TemplateForEditing = {
  id: string;
  bounds: { left: number; top: number; width: number; height: number };
  sourceWidth: number;
  sourceHeight: number;
  align?: TextAlignment;
};

export type ArrowForEditing = {
  id: string;
  sourceWidth: number;
  sourceHeight: number;
};

export type ApplyEditorCommandContext = {
  templates?: TemplateForEditing[];
  arrows?: ArrowForEditing[];
  createId: () => string;
};

function isArrowOverlay(overlay: Pick<Overlay, "templateId">): boolean {
  return overlay.templateId.startsWith("arrow");
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

export function getOverlayAssetHash(overlay: Overlay): string {
  return stableStringify({
    version: 1,
    kind: isArrowOverlay(overlay) ? "arrow" : "card",
    templateId: overlay.templateId,
    templateVersion: overlay.templateVersion,
    width: Math.max(1, Math.floor(overlay.rect.w)),
    height: Math.max(1, Math.floor(overlay.rect.h)),
    rotationDeg: isArrowOverlay(overlay) ? normalizeRotation(overlay.rotationDeg ?? 0) : 0,
    fields: overlay.fields ?? {},
  });
}

export function getVideoFps(video: VideoInfo): number {
  return video.fpsDen === 0 ? 30 : video.fpsNum / video.fpsDen;
}

export function getProjectTotalFrames(project: Project): number {
  const fps = getVideoFps(project.video);
  if (!project.video.durationMs) return 1;
  return Math.max(1, Math.floor((project.video.durationMs / 1000) * fps));
}

export function formatFrame(frame: number): number {
  return Math.max(0, Math.floor(frame));
}

export function normalizeRotation(value: number): number {
  const next = value % 360;
  return next < 0 ? next + 360 : next;
}

export function resolveTemplateAlign(
  templateId: string,
  template?: TemplateForEditing | null
): TextAlignment {
  if (template?.align) return template.align;
  if (templateId.includes("center")) return "center";
  if (templateId.includes("right")) return "right";
  return "left";
}

export function getDefaultTextMargins(align: TextAlignment): { left: number; right: number } {
  if (align === "left") return { left: 34, right: 150 };
  if (align === "right") return { left: 150, right: 34 };
  return { left: 34, right: 34 };
}

export function getTemplateRect(
  project: Project,
  templateId: string,
  template?: TemplateForEditing | null
): Overlay["rect"] {
  if (!template) {
    return { x: 80, y: 80, w: DEFAULT_CARD_SIZE.w, h: DEFAULT_CARD_SIZE.h };
  }
  const scaleX = project.video.width / template.sourceWidth;
  const scaleY = project.video.height / template.sourceHeight;
  return {
    x: template.bounds.left * scaleX,
    y: template.bounds.top * scaleY,
    w: template.bounds.width * scaleX,
    h: template.bounds.height * scaleY,
  };
}

export function getArrowSize(arrow?: ArrowForEditing | null): { w: number; h: number } {
  if (!arrow) return DEFAULT_ARROW_SIZE;
  return { w: arrow.sourceWidth, h: arrow.sourceHeight };
}

export function syncArrowVisibility(overlay: Overlay, patch: OverlayPatch): Overlay {
  const nextMotion = patch.motion ? { ...overlay.motion, ...patch.motion } : overlay.motion;
  const next = { ...overlay, ...patch, motion: nextMotion };
  if (!isArrowOverlay(overlay)) return next;

  const motion = overlay.motion ?? {};
  let syncedMotion = nextMotion;
  let updated = false;

  if (typeof patch.startFrame === "number") {
    const shouldSync =
      typeof motion.visibleStartFrame !== "number" ||
      motion.visibleStartFrame === overlay.startFrame;
    if (shouldSync) {
      syncedMotion = { ...(syncedMotion ?? {}), visibleStartFrame: patch.startFrame };
      updated = true;
    }
  }

  if (typeof patch.endFrame === "number") {
    const shouldSync =
      typeof motion.visibleEndFrame !== "number" ||
      motion.visibleEndFrame === overlay.endFrame;
    if (shouldSync) {
      syncedMotion = { ...(syncedMotion ?? {}), visibleEndFrame: patch.endFrame };
      updated = true;
    }
  }

  return updated ? { ...next, motion: syncedMotion } : next;
}

export function normalizeOverlayZIndexes(overlays: Overlay[]): Overlay[] {
  return [...overlays]
    .sort((a, b) => {
      if (a.zIndex !== b.zIndex) return a.zIndex - b.zIndex;
      return a.id.localeCompare(b.id);
    })
    .map((overlay, zIndex) => ({ ...overlay, zIndex }));
}

export function buildCardOverlay(
  project: Project,
  input: Extract<EditorCommand, { type: "addCard" }>,
  context: ApplyEditorCommandContext
): Overlay {
  const fps = getVideoFps(project.video);
  const templateId = input.templateId ?? DEFAULT_TEMPLATE_ID;
  const template = context.templates?.find((item) => item.id === templateId) ?? null;
  const templateAlign = resolveTemplateAlign(templateId, template);
  const defaultMargins = getDefaultTextMargins(templateAlign);
  const baseRect = getTemplateRect(project, templateId, template);
  const start = formatFrame(input.startFrame ?? 0);
  const duration = input.durationFrames ?? Math.floor(fps * 5);

  return {
    id: input.id ?? context.createId(),
    templateId,
    templateVersion: "1",
    startFrame: start,
    endFrame: start + duration,
    rect: {
      x: typeof input.x === "number" ? Math.max(0, input.x) : baseRect.x,
      y: typeof input.y === "number" ? Math.max(0, input.y) : baseRect.y,
      w: input.w ?? baseRect.w,
      h: input.h ?? baseRect.h,
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
      ...(input.fields ?? {}),
    },
    motion: {
      slideInFrames: 12,
      displayFrames: Math.floor(fps * 3),
      slideOutFrames: 12,
      slideDirection: templateAlign === "right" ? "fromRight" : "fromLeft",
      ...(input.motion ?? {}),
    },
  };
}

export function buildArrowOverlay(
  project: Project,
  input: Extract<EditorCommand, { type: "addArrow" }>,
  context: ApplyEditorCommandContext
): Overlay {
  const fps = getVideoFps(project.video);
  const arrow = context.arrows?.[0] ?? null;
  const size = getArrowSize(arrow);
  const start = formatFrame(input.startFrame ?? 0);
  const pairedCard = project.overlays.find(
    (overlay) =>
      !isArrowOverlay(overlay) &&
      start >= overlay.startFrame &&
      start < Math.max(overlay.startFrame + 1, overlay.endFrame)
  );
  const pairedDuration = pairedCard
    ? Math.max(1, pairedCard.endFrame - pairedCard.startFrame)
    : undefined;
  const duration = input.durationFrames ?? pairedDuration ?? Math.floor(fps * 2);
  const fallbackX = project.video.width / 2 - size.w / 2;
  const fallbackY = project.video.height / 2 - size.h / 2;

  return {
    id: input.id ?? context.createId(),
    templateId: arrow?.id ?? "arrow-right",
    templateVersion: "1",
    startFrame: start,
    endFrame: start + duration,
    rect: {
      x: typeof input.x === "number" ? Math.max(0, input.x) : fallbackX,
      y: typeof input.y === "number" ? Math.max(0, input.y) : fallbackY,
      w: input.w ?? size.w,
      h: input.h ?? size.h,
    },
    rotationDeg: normalizeRotation(input.rotationDeg ?? 0),
    opacity: 1,
    zIndex: project.overlays.length,
    fields: {},
    motion: {
      visibleStartFrame: start,
      visibleEndFrame: start + duration,
      pulsePeriodFrames: Math.floor(fps * 0.8),
      pulseMinAlpha: 0.65,
      pulseMaxAlpha: 1,
      ...(input.motion ?? {}),
    },
  };
}

function mergeOverlayPatch(overlay: Overlay, patch: OverlayPatch): Overlay {
  return syncArrowVisibility(overlay, {
    ...patch,
    fields: patch.fields ? { ...overlay.fields, ...patch.fields } : overlay.fields,
  });
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeTransition(input?: {
  type?: "cut" | "crossfade";
  durationFrames?: number;
}): { type: "cut" | "crossfade"; durationFrames: number } {
  if (input?.type === "crossfade") {
    return {
      type: "crossfade",
      durationFrames: Math.max(0, Math.floor(input.durationFrames ?? 12)),
    };
  }
  return { type: "cut", durationFrames: 0 };
}

function getCompleteEdits(project: Project): NonNullable<Project["edits"]> {
  return {
    trimStartFrames: project.edits?.trimStartFrames ?? 0,
    trimEndFrames: project.edits?.trimEndFrames ?? 0,
    cuts: project.edits?.cuts ?? [],
    sourceSegments: project.edits?.sourceSegments ?? [],
  };
}

function getCompleteExportOptions(project: Project): NonNullable<Project["exportOptions"]> {
  return {
    speed: project.exportOptions?.speed ?? 1,
    includeAudio: project.exportOptions?.includeAudio ?? true,
    includeSlug: project.exportOptions?.includeSlug ?? false,
    includeSlugStart: project.exportOptions?.includeSlugStart ?? false,
    includeSlugEnd: project.exportOptions?.includeSlugEnd ?? false,
  };
}

function normalizeSourceSegment(
  input: {
    id?: string;
    kind?: SourceSegment["kind"];
    label?: string;
    startFrame: number;
    endFrameExclusive: number;
    playbackRate: number;
    audio?: SourceSegment["audio"];
    assetPath?: string;
    durationFrames?: number;
    transition?: { type?: "cut" | "crossfade"; durationFrames?: number };
  },
  totalFrames: number,
  createId: () => string
): SourceSegment {
  if (input.kind === "image") {
    return SourceSegmentSchema.parse({
      ...input,
      id: input.id ?? createId(),
      kind: "image",
      startFrame: 0,
      endFrameExclusive: 1,
      playbackRate: 1,
      durationFrames: Math.max(1, Math.floor(input.durationFrames ?? 1)),
      audio: "mute",
      transition: normalizeTransition(input.transition),
    });
  }

  const startFrame = clampNumber(input.startFrame, 0, totalFrames - 1);
  const endFrameExclusive = clampNumber(
    input.endFrameExclusive,
    startFrame + 1,
    totalFrames
  );
  return SourceSegmentSchema.parse({
    ...input,
    id: input.id ?? createId(),
    kind: "source",
    startFrame,
    endFrameExclusive,
    playbackRate: Math.max(0.01, input.playbackRate),
    audio: input.audio ?? "preserve",
    transition: normalizeTransition(input.transition),
  });
}

export function applyEditorCommands(
  project: Project,
  commands: EditorCommand[],
  context: ApplyEditorCommandContext
): { project: Project; results: CommandResult[] } {
  let next = ProjectSchema.parse(project);
  const results: CommandResult[] = [];

  commands.forEach((command, index) => {
    if (command.type === "addCard") {
      const overlay = buildCardOverlay(next, command, context);
      next = { ...next, overlays: [...next.overlays, overlay] };
      results.push({ index, type: command.type, overlayId: overlay.id });
      return;
    }

    if (command.type === "addArrow") {
      const overlay = buildArrowOverlay(next, command, context);
      next = { ...next, overlays: [...next.overlays, overlay] };
      results.push({ index, type: command.type, overlayId: overlay.id });
      return;
    }

    if (command.type === "updateOverlay") {
      let found = false;
      const overlays = next.overlays.map((overlay) => {
        if (overlay.id !== command.id) return overlay;
        found = true;
        return mergeOverlayPatch(overlay, command.patch);
      });
      if (!found) throw new Error(`overlay not found: ${command.id}`);
      next = { ...next, overlays: normalizeOverlayZIndexes(overlays) };
      results.push({ index, type: command.type, overlayId: command.id });
      return;
    }

    if (command.type === "removeOverlay") {
      const overlays = next.overlays.filter((overlay) => overlay.id !== command.id);
      if (overlays.length === next.overlays.length) {
        throw new Error(`overlay not found: ${command.id}`);
      }
      next = { ...next, overlays: normalizeOverlayZIndexes(overlays) };
      results.push({ index, type: command.type, overlayId: command.id });
      return;
    }

    if (command.type === "reorderOverlays") {
      const byId = new Map(next.overlays.map((overlay) => [overlay.id, overlay]));
      const ordered = command.overlayIds.map((id) => {
        const overlay = byId.get(id);
        if (!overlay) throw new Error(`overlay not found: ${id}`);
        byId.delete(id);
        return overlay;
      });
      next = {
        ...next,
        overlays: [...ordered, ...normalizeOverlayZIndexes([...byId.values()])].map(
          (overlay, zIndex) => ({ ...overlay, zIndex })
        ),
      };
      results.push({ index, type: command.type });
      return;
    }

    if (command.type === "setTrim") {
      const totalFrames = getProjectTotalFrames(next);
      const edits = getCompleteEdits(next);
      const currentStart = edits.trimStartFrames;
      const currentEnd = totalFrames - edits.trimEndFrames;
      const start = clampNumber(command.startFrame ?? currentStart, 0, totalFrames - 1);
      const end = clampNumber(command.endFrameExclusive ?? currentEnd, start + 1, totalFrames);
      next = {
        ...next,
        edits: {
          ...edits,
          trimStartFrames: start,
          trimEndFrames: Math.max(0, totalFrames - end),
        },
      };
      results.push({ index, type: command.type });
      return;
    }

    if (command.type === "addCut") {
      const totalFrames = getProjectTotalFrames(next);
      const startFrame = clampNumber(command.startFrame, 0, totalFrames - 1);
      const endFrame = clampNumber(command.endFrame, startFrame, totalFrames - 1);
      const cut = {
        id: command.id ?? context.createId(),
        startFrame,
        endFrame,
        transition: normalizeTransition(command.transition),
      };
      const edits = getCompleteEdits(next);
      next = {
        ...next,
        edits: { ...edits, cuts: [...edits.cuts, cut] },
      };
      results.push({ index, type: command.type, cutId: cut.id });
      return;
    }

    if (command.type === "updateCut") {
      let found = false;
      const totalFrames = getProjectTotalFrames(next);
      const edits = getCompleteEdits(next);
      const cuts = edits.cuts.map((cut) => {
        if (cut.id !== command.id) return cut;
        found = true;
        const startFrame = clampNumber(
          command.patch.startFrame ?? cut.startFrame,
          0,
          totalFrames - 1
        );
        const endFrame = clampNumber(
          command.patch.endFrame ?? cut.endFrame,
          startFrame,
          totalFrames - 1
        );
        return {
          ...cut,
          ...command.patch,
          startFrame,
          endFrame,
          transition: command.patch.transition
            ? normalizeTransition(command.patch.transition)
            : cut.transition,
        };
      });
      if (!found) throw new Error(`cut not found: ${command.id}`);
      next = { ...next, edits: { ...edits, cuts } };
      results.push({ index, type: command.type, cutId: command.id });
      return;
    }

    if (command.type === "removeCut") {
      const edits = getCompleteEdits(next);
      const cuts = edits.cuts.filter((cut) => cut.id !== command.id);
      if (cuts.length === edits.cuts.length) {
        throw new Error(`cut not found: ${command.id}`);
      }
      next = { ...next, edits: { ...edits, cuts } };
      results.push({ index, type: command.type, cutId: command.id });
      return;
    }

    if (command.type === "setSourceSegments") {
      const totalFrames = getProjectTotalFrames(next);
      const edits = getCompleteEdits(next);
      const segments = command.segments.map((segment) =>
        normalizeSourceSegment(segment, totalFrames, context.createId)
      );
      next = {
        ...next,
        edits: { ...edits, sourceSegments: segments },
        exportOptions: { ...getCompleteExportOptions(next), speed: 1 },
      };
      results.push({ index, type: command.type });
      return;
    }

    if (command.type === "addSourceSegment") {
      const totalFrames = getProjectTotalFrames(next);
      const edits = getCompleteEdits(next);
      const segment = normalizeSourceSegment(
        command.segment,
        totalFrames,
        context.createId
      );
      next = {
        ...next,
        edits: { ...edits, sourceSegments: [...edits.sourceSegments, segment] },
        exportOptions: { ...getCompleteExportOptions(next), speed: 1 },
      };
      results.push({ index, type: command.type, sourceSegmentId: segment.id });
      return;
    }

    if (command.type === "updateSourceSegment") {
      const totalFrames = getProjectTotalFrames(next);
      const edits = getCompleteEdits(next);
      let found = false;
      const sourceSegments = edits.sourceSegments.map((segment) => {
        if (segment.id !== command.id) return segment;
        found = true;
        return normalizeSourceSegment(
          { ...segment, ...command.patch, id: segment.id },
          totalFrames,
          context.createId
        );
      });
      if (!found) throw new Error(`source segment not found: ${command.id}`);
      next = {
        ...next,
        edits: { ...edits, sourceSegments },
        exportOptions: { ...getCompleteExportOptions(next), speed: 1 },
      };
      results.push({ index, type: command.type, sourceSegmentId: command.id });
      return;
    }

    if (command.type === "removeSourceSegment") {
      const edits = getCompleteEdits(next);
      const sourceSegments = edits.sourceSegments.filter((segment) => segment.id !== command.id);
      if (sourceSegments.length === edits.sourceSegments.length) {
        throw new Error(`source segment not found: ${command.id}`);
      }
      next = {
        ...next,
        edits: { ...edits, sourceSegments },
        exportOptions: { ...getCompleteExportOptions(next), speed: 1 },
      };
      results.push({ index, type: command.type, sourceSegmentId: command.id });
      return;
    }

    if (command.type === "reorderSourceSegments") {
      const edits = getCompleteEdits(next);
      const byId = new Map(edits.sourceSegments.map((segment) => [segment.id, segment]));
      const ordered = command.segmentIds.map((id) => {
        const segment = byId.get(id);
        if (!segment) throw new Error(`source segment not found: ${id}`);
        byId.delete(id);
        return segment;
      });
      next = {
        ...next,
        edits: { ...edits, sourceSegments: [...ordered, ...byId.values()] },
        exportOptions: { ...getCompleteExportOptions(next), speed: 1 },
      };
      results.push({ index, type: command.type });
      return;
    }

    if (command.type === "setSourceSegmentsFromText") {
      const fps = getVideoFps(next.video);
      const totalFrames = getProjectTotalFrames(next);
      const parsed = parseSourceTimelineText(command.text, {
        fps,
        totalFrames,
        createId: context.createId,
        defaultAudio: command.defaultAudio,
        fastAudio: command.fastAudio,
      });
      const edits = getCompleteEdits(next);
      next = {
        ...next,
        edits: { ...edits, sourceSegments: parsed.segments },
        exportOptions: { ...getCompleteExportOptions(next), speed: 1 },
      };
      results.push({ index, type: command.type });
      return;
    }

    if (command.type === "setSlug") {
      next = { ...next, slug: command.slug ?? undefined };
      results.push({ index, type: command.type });
      return;
    }

    if (command.type === "setExportOptions") {
      next = {
        ...next,
        exportOptions: { ...getCompleteExportOptions(next), ...command.options },
      };
      results.push({ index, type: command.type });
      return;
    }

    if (command.type === "setAudioTrack") {
      next = { ...next, audioTrack: command.audioTrack ?? undefined };
      results.push({ index, type: command.type });
      return;
    }
  });

  return { project: ProjectSchema.parse(next), results };
}
