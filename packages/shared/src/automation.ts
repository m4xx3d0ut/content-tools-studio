import { z } from "zod";
import {
  ExportOptionsSchema,
  MotionSchema,
  ProjectSchema,
  RectSchema,
  SlugSchema,
  SourceSegmentSchema,
} from "./project.js";
import { SourceSegmentAudioSchema } from "./source-timeline.js";

const FieldValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const OverlayPatchSchema = z.object({
  templateId: z.string().min(1).optional(),
  templateVersion: z.string().min(1).optional(),
  startFrame: z.number().int().nonnegative().optional(),
  endFrame: z.number().int().nonnegative().optional(),
  rect: RectSchema.optional(),
  rotationDeg: z.number().finite().optional(),
  opacity: z.number().min(0).max(1).optional(),
  zIndex: z.number().int().optional(),
  fields: z.record(FieldValueSchema).optional(),
  motion: MotionSchema,
});

const TransitionInputSchema = z
  .object({
    type: z.enum(["cut", "crossfade"]).optional(),
    durationFrames: z.number().int().nonnegative().optional(),
  })
  .optional();

const AddCardCommandSchema = z.object({
  type: z.literal("addCard"),
  id: z.string().min(1).optional(),
  templateId: z.string().min(1).optional(),
  startFrame: z.number().int().nonnegative().optional(),
  durationFrames: z.number().int().positive().optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  w: z.number().finite().positive().optional(),
  h: z.number().finite().positive().optional(),
  fields: z.record(FieldValueSchema).optional(),
  motion: MotionSchema,
});

const AddArrowCommandSchema = z.object({
  type: z.literal("addArrow"),
  id: z.string().min(1).optional(),
  startFrame: z.number().int().nonnegative().optional(),
  durationFrames: z.number().int().positive().optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  w: z.number().finite().positive().optional(),
  h: z.number().finite().positive().optional(),
  rotationDeg: z.number().finite().optional(),
  motion: MotionSchema,
});

const UpdateOverlayCommandSchema = z.object({
  type: z.literal("updateOverlay"),
  id: z.string().min(1),
  patch: OverlayPatchSchema,
});

const RemoveOverlayCommandSchema = z.object({
  type: z.literal("removeOverlay"),
  id: z.string().min(1),
});

const ReorderOverlaysCommandSchema = z.object({
  type: z.literal("reorderOverlays"),
  overlayIds: z.array(z.string().min(1)),
});

const SetTrimCommandSchema = z.object({
  type: z.literal("setTrim"),
  startFrame: z.number().int().nonnegative().optional(),
  endFrameExclusive: z.number().int().positive().optional(),
});

const AddCutCommandSchema = z.object({
  type: z.literal("addCut"),
  id: z.string().min(1).optional(),
  startFrame: z.number().int().nonnegative(),
  endFrame: z.number().int().nonnegative(),
  transition: TransitionInputSchema,
});

const UpdateCutCommandSchema = z.object({
  type: z.literal("updateCut"),
  id: z.string().min(1),
  patch: z.object({
    startFrame: z.number().int().nonnegative().optional(),
    endFrame: z.number().int().nonnegative().optional(),
    transition: TransitionInputSchema,
  }),
});

const RemoveCutCommandSchema = z.object({
  type: z.literal("removeCut"),
  id: z.string().min(1),
});

const SourceSegmentInputSchema = z.object({
  id: z.string().min(1).optional(),
  label: z.string().optional(),
  startFrame: z.number().int().nonnegative(),
  endFrameExclusive: z.number().int().positive(),
  playbackRate: z.number().finite().positive(),
  audio: SourceSegmentAudioSchema.optional(),
  transition: TransitionInputSchema,
});

const SourceSegmentPatchSchema = z.object({
  label: z.string().optional(),
  startFrame: z.number().int().nonnegative().optional(),
  endFrameExclusive: z.number().int().positive().optional(),
  playbackRate: z.number().finite().positive().optional(),
  audio: SourceSegmentAudioSchema.optional(),
  transition: TransitionInputSchema,
});

const SetSourceSegmentsCommandSchema = z.object({
  type: z.literal("setSourceSegments"),
  segments: z.array(SourceSegmentSchema),
});

const AddSourceSegmentCommandSchema = z.object({
  type: z.literal("addSourceSegment"),
  segment: SourceSegmentInputSchema,
});

const UpdateSourceSegmentCommandSchema = z.object({
  type: z.literal("updateSourceSegment"),
  id: z.string().min(1),
  patch: SourceSegmentPatchSchema,
});

const RemoveSourceSegmentCommandSchema = z.object({
  type: z.literal("removeSourceSegment"),
  id: z.string().min(1),
});

const ReorderSourceSegmentsCommandSchema = z.object({
  type: z.literal("reorderSourceSegments"),
  segmentIds: z.array(z.string().min(1)),
});

const SetSourceSegmentsFromTextCommandSchema = z.object({
  type: z.literal("setSourceSegmentsFromText"),
  text: z.string().min(1),
  defaultAudio: SourceSegmentAudioSchema.optional(),
  fastAudio: SourceSegmentAudioSchema.optional(),
});

const SetSlugCommandSchema = z.object({
  type: z.literal("setSlug"),
  slug: SlugSchema.unwrap().nullable(),
});

const SetExportOptionsCommandSchema = z.object({
  type: z.literal("setExportOptions"),
  options: ExportOptionsSchema.unwrap().partial(),
});

export const EditorCommandSchema = z.discriminatedUnion("type", [
  AddCardCommandSchema,
  AddArrowCommandSchema,
  UpdateOverlayCommandSchema,
  RemoveOverlayCommandSchema,
  ReorderOverlaysCommandSchema,
  SetTrimCommandSchema,
  AddCutCommandSchema,
  UpdateCutCommandSchema,
  RemoveCutCommandSchema,
  SetSourceSegmentsCommandSchema,
  AddSourceSegmentCommandSchema,
  UpdateSourceSegmentCommandSchema,
  RemoveSourceSegmentCommandSchema,
  ReorderSourceSegmentsCommandSchema,
  SetSourceSegmentsFromTextCommandSchema,
  SetSlugCommandSchema,
  SetExportOptionsCommandSchema,
]);

export const CommandBatchRequestSchema = z.object({
  baseRevision: z.number().int().nonnegative().optional(),
  actor: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
  commands: z.array(EditorCommandSchema).min(1),
});

export const CommandResultSchema = z.object({
  index: z.number().int().nonnegative(),
  type: z.string().min(1),
  overlayId: z.string().optional(),
  cutId: z.string().optional(),
  sourceSegmentId: z.string().optional(),
});

export const CommandBatchResponseSchema = z.object({
  project: ProjectSchema,
  results: z.array(CommandResultSchema),
});

export const AutomationCapabilitiesSchema = z.object({
  apiVersion: z.literal("content-tools.automation/v1"),
  schemaVersion: z.literal(1),
  projectRevisioning: z.literal("optimistic"),
  coordinates: z.literal("source-video-pixels"),
  frameSemantics: z.object({
    overlays: z.literal("endFrame-inclusive"),
    cuts: z.literal("endFrame-inclusive"),
    trim: z.literal("endFrameExclusive"),
    sourceSegments: z.literal("endFrameExclusive"),
  }),
  commands: z.array(z.string()),
  slugLibrary: z.object({
    list: z.string(),
    import: z.string(),
    media: z.string(),
    delete: z.string(),
  }),
});

export type OverlayPatch = z.infer<typeof OverlayPatchSchema>;
export type EditorCommand = z.infer<typeof EditorCommandSchema>;
export type CommandBatchRequest = z.infer<typeof CommandBatchRequestSchema>;
export type CommandResult = z.infer<typeof CommandResultSchema>;
export type CommandBatchResponse = z.infer<typeof CommandBatchResponseSchema>;
export type AutomationCapabilities = z.infer<typeof AutomationCapabilitiesSchema>;
