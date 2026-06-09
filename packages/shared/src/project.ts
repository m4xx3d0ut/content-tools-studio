import { z } from "zod";

export const RectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().positive(),
  h: z.number().finite().positive(),
});

export const VideoSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fpsNum: z.number().int().positive(),
  fpsDen: z.number().int().positive(),
  durationMs: z.number().int().nonnegative(),
  audio: z
    .object({
      hasAudio: z.boolean().default(true),
      sampleRate: z.number().int().positive().optional(),
      channels: z.number().int().positive().optional(),
    })
    .default({ hasAudio: true }),
});

export const SourceSchema = z.object({
  filename: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().optional(),
  sha256: z.string().length(64).optional(),
  rawFormSessionId: z.string().optional(),
});

export const MotionSchema = z
  .object({
    // Card slide-in/out
    slideInFrames: z.number().int().nonnegative().optional(),
    displayFrames: z.number().int().nonnegative().optional(),
    slideOutFrames: z.number().int().nonnegative().optional(),
    slideDirection: z.enum(["fromLeft", "fromRight", "none"]).optional(),

    // Visibility override (esp. arrows)
    visibleStartFrame: z.number().int().nonnegative().optional(),
    visibleEndFrame: z.number().int().nonnegative().optional(),

    // Arrow pulse
    pulsePeriodFrames: z.number().int().positive().optional(),
    pulseMinAlpha: z.number().min(0).max(1).optional(),
    pulseMaxAlpha: z.number().min(0).max(1).optional(),

    // Arrow bounce (optional)
    bouncePx: z.number().finite().nonnegative().optional(),
    bouncePeriodFrames: z.number().int().positive().optional(),
    bounceAxis: z.enum(["x", "y"]).optional(),
  })
  .optional();

export const OverlaySchema = z.object({
  id: z.string().min(1),
  templateId: z.string().min(1),
  templateVersion: z.string().min(1).default("1"),

  startFrame: z.number().int().nonnegative(),
  endFrame: z.number().int().nonnegative(),

  rect: RectSchema,
  rotationDeg: z.number().finite().optional(),
  opacity: z.number().min(0).max(1).optional(),

  zIndex: z.number().int().default(0),

  fields: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  motion: MotionSchema,
});

export const ProxySpecSchema = z.object({
  enabled: z.boolean().default(false),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  crf: z.number().int().min(10).max(40).optional(),
  preset: z.string().optional(),
});

export const RenderCacheSchema = z.object({
  overlayAssetHash: z.record(z.string()).default({}),
  templatesVersion: z.string().optional(),
});

const TransitionSchema = z
  .object({
    type: z.enum(["cut", "crossfade"]).default("cut"),
    durationFrames: z.number().int().nonnegative().default(0),
  })
  .optional();

export const SlugSchema = z
  .object({
    introPath: z.string().optional(),
    outroPath: z.string().optional(),
    fps: z.number().positive().optional(),
    transition: TransitionSchema,
  })
  .optional();

export const ExportOptionsSchema = z
  .object({
    speed: z.union([z.literal(1), z.literal(2)]).default(1),
    includeAudio: z.boolean().default(true),
    includeSlug: z.boolean().default(false),
    includeSlugStart: z.boolean().default(false),
    includeSlugEnd: z.boolean().default(false),
  })
  .optional();

export const AudioFadeOutSchema = z
  .object({
    enabled: z.boolean().default(false),
    target: z.enum(["tailSlug", "end"]).default("tailSlug"),
    durationSec: z.number().finite().positive().default(2),
  })
  .optional();

export const AudioTrackSchema = z.object({
  assetPath: z.string().min(1),
  mode: z.enum(["overlay", "replace"]).default("overlay"),
  startSec: z.number().finite().nonnegative().default(0),
  source: z.enum(["upload", "url"]).default("upload"),
  filename: z.string().min(1).optional(),
  originalUrl: z.string().url().optional(),
  fadeOut: AudioFadeOutSchema,
});

const CutSchema = z.object({
  id: z.string().min(1),
  startFrame: z.number().int().nonnegative(),
  endFrame: z.number().int().nonnegative(),
  transition: TransitionSchema,
});

export const SourceSegmentSchema = z.object({
  kind: z.enum(["source", "image"]).default("source"),
  id: z.string().min(1),
  label: z.string().optional(),
  startFrame: z.number().int().nonnegative(),
  endFrameExclusive: z.number().int().positive(),
  playbackRate: z.number().finite().positive(),
  audio: z.enum(["preserve", "mute"]).default("preserve"),
  assetPath: z.string().min(1).optional(),
  durationFrames: z.number().int().positive().optional(),
  transition: TransitionSchema,
});

const TimelineEditsSchema = z
  .object({
    trimStartFrames: z.number().int().nonnegative().default(0),
    trimEndFrames: z.number().int().nonnegative().default(0),
    cuts: z.array(CutSchema).default([]),
    sourceSegments: z.array(SourceSegmentSchema).default([]),
  })
  .optional();

export const ProjectSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  revision: z.number().int().nonnegative().default(1),
  id: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),

  source: SourceSchema,
  video: VideoSchema,

  proxy: ProxySpecSchema.default({ enabled: false }),
  overlays: z.array(OverlaySchema).default([]),

  slug: SlugSchema,
  exportOptions: ExportOptionsSchema,
  audioTrack: AudioTrackSchema.optional(),
  edits: TimelineEditsSchema,

  lastExportPresetId: z.string().optional(),
  renderCache: RenderCacheSchema.default({ overlayAssetHash: {} }),
});

export type Project = z.infer<typeof ProjectSchema>;
export type Overlay = z.infer<typeof OverlaySchema>;
export type SourceSegment = z.infer<typeof SourceSegmentSchema>;
export type AudioTrack = z.infer<typeof AudioTrackSchema>;
export type VideoInfo = z.infer<typeof VideoSchema>;

export function validateProject(json: unknown): Project {
  return ProjectSchema.parse(json);
}
