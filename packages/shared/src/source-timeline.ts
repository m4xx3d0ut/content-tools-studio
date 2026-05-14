import { z } from "zod";
import { SourceSegmentSchema, type SourceSegment } from "./project.js";

export const SourceSegmentAudioSchema = z.enum(["preserve", "mute"]);

export const SourceTimelineParseRequestSchema = z.object({
  text: z.string().min(1),
  defaultAudio: SourceSegmentAudioSchema.optional(),
  fastAudio: SourceSegmentAudioSchema.optional(),
});

export const SourceTimelineParseResponseSchema = z.object({
  segments: z.array(SourceSegmentSchema),
  warnings: z.array(z.string()),
  outputDurationSeconds: z.number().nonnegative(),
  outputFrames: z.number().int().nonnegative(),
});

export type SourceSegmentAudio = z.infer<typeof SourceSegmentAudioSchema>;
export type SourceTimelineParseRequest = z.infer<typeof SourceTimelineParseRequestSchema>;
export type SourceTimelineParseResponse = z.infer<typeof SourceTimelineParseResponseSchema>;

export type SourceTimelineParseOptions = {
  fps: number;
  totalFrames: number;
  createId: () => string;
  defaultAudio?: SourceSegmentAudio;
  fastAudio?: SourceSegmentAudio;
};

const TIME_TOKEN_SOURCE =
  String.raw`(?:(?:\d+(?:\.\d+)?\s*(?:h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)\s*)+|\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?|\d+(?:\.\d+)?)`;
const TIME_TOKEN_RE = new RegExp(TIME_TOKEN_SOURCE, "i");
const TIME_TOKEN_GLOBAL_RE = new RegExp(TIME_TOKEN_SOURCE, "gi");

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function parseFlexibleTimestamp(value: string): number | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;

  if (normalized.includes(":")) {
    const parts = normalized.split(":").map((part) => Number(part));
    if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part))) {
      return null;
    }
    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  const compact = normalized.replace(/\s+/g, "");
  const unitMatches = [...compact.matchAll(/(\d+(?:\.\d+)?)(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)/g)];
  if (unitMatches.length) {
    let total = 0;
    for (const match of unitMatches) {
      const amount = Number(match[1]);
      const unit = match[2];
      if (!Number.isFinite(amount)) return null;
      if (unit.startsWith("h")) total += amount * 3600;
      else if (unit.startsWith("m")) total += amount * 60;
      else total += amount;
    }
    return total;
  }

  const bare = Number(normalized);
  return Number.isFinite(bare) ? bare : null;
}

function secondsToFrame(seconds: number, fps: number): number {
  return Math.round(seconds * fps);
}

function formatLineLabel(label: string | undefined, fallback: string): string {
  return label?.trim() || fallback;
}

function firstTimeToken(value: string): string | null {
  return value.match(TIME_TOKEN_RE)?.[0] ?? null;
}

function lastTimeToken(value: string): string | null {
  const matches = [...value.matchAll(TIME_TOKEN_GLOBAL_RE)].map((match) => match[0]);
  return matches.at(-1) ?? null;
}

function parseTargetSeconds(value: string): number | null {
  const token = lastTimeToken(value);
  if (!token) return null;
  return parseFlexibleTimestamp(token);
}

function parsePlaybackRate(directive: string, sourceSeconds: number): number {
  const fitIndex = directive.search(/\bfit\b/i);
  if (fitIndex >= 0) {
    const targetSeconds = parseTargetSeconds(directive.slice(fitIndex));
    if (targetSeconds && isFinitePositive(targetSeconds)) {
      return sourceSeconds / targetSeconds;
    }
  }

  const speedMatch = directive.match(/(\d+(?:\.\d+)?)\s*x\b/i);
  if (speedMatch) {
    const rate = Number(speedMatch[1]);
    if (isFinitePositive(rate)) return rate;
  }

  return 1;
}

function parseCompoundRealtimePrefix(
  directive: string,
  sourceSeconds: number
): { realtimeSeconds: number; remainingTargetSeconds: number } | null {
  const realtimeMatch = directive.match(
    new RegExp(String.raw`(?:first\s*)?(${TIME_TOKEN_SOURCE})\s*(?:at\s*)?1\s*x`, "i")
  );
  if (!realtimeMatch) return null;

  const realtimeSeconds = parseFlexibleTimestamp(realtimeMatch[1]);
  if (!realtimeSeconds || realtimeSeconds <= 0 || realtimeSeconds >= sourceSeconds) {
    return null;
  }

  const remainingMatch = directive.match(/\b(?:remaining|rest)\b[\s\S]*?\bfit\b([\s\S]*)/i);
  if (!remainingMatch) return null;

  const remainingTargetSeconds = parseTargetSeconds(remainingMatch[1]);
  if (!remainingTargetSeconds || remainingTargetSeconds <= 0) {
    return null;
  }

  return { realtimeSeconds, remainingTargetSeconds };
}

function segmentAudio(rate: number, directive: string, options: SourceTimelineParseOptions) {
  if (/\bmute(?:d)?\b|\bsilent\b/i.test(directive)) return "mute" as const;
  if (/\baudio\b[\s:=]+(?:off|mute|muted|false|no)\b/i.test(directive)) return "mute" as const;
  if (rate > 1.01 && options.fastAudio) return options.fastAudio;
  return options.defaultAudio ?? "preserve";
}

function normalizeSegment(input: {
  id: string;
  label: string;
  startSeconds: number;
  endSeconds: number;
  playbackRate: number;
  directive: string;
  fps: number;
  totalFrames: number;
  options: SourceTimelineParseOptions;
}): SourceSegment | null {
  const startFrame = Math.max(0, Math.min(input.totalFrames - 1, secondsToFrame(input.startSeconds, input.fps)));
  const endFrameExclusive = Math.max(
    startFrame + 1,
    Math.min(input.totalFrames, secondsToFrame(input.endSeconds, input.fps))
  );
  if (endFrameExclusive <= startFrame) return null;

  return SourceSegmentSchema.parse({
    id: input.id,
    label: input.label,
    startFrame,
    endFrameExclusive,
    playbackRate: Math.max(0.01, input.playbackRate),
    audio: segmentAudio(input.playbackRate, input.directive, input.options),
    transition: { type: "cut", durationFrames: 0 },
  });
}

function parseTimelineLine(
  rawLine: string,
  lineNumber: number,
  options: SourceTimelineParseOptions
): { segments: SourceSegment[]; warning?: string } {
  const line = rawLine.replace(/^\s*[-*]\s+/, "").trim();
  if (!line || line.startsWith("#")) return { segments: [] };

  const [leftRaw, ...labelParts] = line.split("=");
  const label = labelParts.join("=").trim();
  const directive = leftRaw.match(/\(([^)]*)\)/)?.[1]?.trim() ?? "";
  const rangeText = leftRaw.replace(/\([^)]*\)/g, " ").trim();
  const rangeParts = rangeText.split(/\s*(?:-|\u2013|\u2014|\bto\b)\s*/i).filter(Boolean);
  if (rangeParts.length < 2) return { segments: [] };

  const startSeconds = parseFlexibleTimestamp(rangeParts[0]);
  const endSeconds = parseFlexibleTimestamp(rangeParts[1]);
  if (startSeconds === null || endSeconds === null) {
    return { segments: [], warning: `Line ${lineNumber}: could not parse timestamp range.` };
  }
  if (endSeconds <= startSeconds) {
    return { segments: [], warning: `Line ${lineNumber}: range end must be after start.` };
  }

  const sourceSeconds = endSeconds - startSeconds;
  const baseLabel = formatLineLabel(label, `Segment ${lineNumber}`);
  const compound = parseCompoundRealtimePrefix(directive, sourceSeconds);
  if (compound) {
    const splitSeconds = startSeconds + compound.realtimeSeconds;
    const remainingSeconds = endSeconds - splitSeconds;
    const remainingRate = remainingSeconds / compound.remainingTargetSeconds;
    const first = normalizeSegment({
      id: options.createId(),
      label: `${baseLabel} (real time)`,
      startSeconds,
      endSeconds: splitSeconds,
      playbackRate: 1,
      directive,
      fps: options.fps,
      totalFrames: options.totalFrames,
      options,
    });
    const second = normalizeSegment({
      id: options.createId(),
      label: `${baseLabel} (compressed)`,
      startSeconds: splitSeconds,
      endSeconds,
      playbackRate: remainingRate,
      directive,
      fps: options.fps,
      totalFrames: options.totalFrames,
      options,
    });
    return { segments: [first, second].filter((segment): segment is SourceSegment => Boolean(segment)) };
  }

  const playbackRate = parsePlaybackRate(directive, sourceSeconds);
  const segment = normalizeSegment({
    id: options.createId(),
    label: baseLabel,
    startSeconds,
    endSeconds,
    playbackRate,
    directive,
    fps: options.fps,
    totalFrames: options.totalFrames,
    options,
  });
  return { segments: segment ? [segment] : [] };
}

export function summarizeSourceSegments(
  segments: SourceSegment[],
  fps: number
): Pick<SourceTimelineParseResponse, "outputDurationSeconds" | "outputFrames"> {
  const outputFrames = segments.reduce((sum, segment) => {
    const sourceFrames = Math.max(1, segment.endFrameExclusive - segment.startFrame);
    return sum + Math.max(1, Math.round(sourceFrames / segment.playbackRate));
  }, 0);
  return {
    outputFrames,
    outputDurationSeconds: Number((outputFrames / fps).toFixed(3)),
  };
}

export function parseSourceTimelineText(
  text: string,
  options: SourceTimelineParseOptions
): SourceTimelineParseResponse {
  const fps = Number.isFinite(options.fps) && options.fps > 0 ? options.fps : 30;
  const totalFrames = Math.max(1, Math.floor(options.totalFrames));
  const parseOptions = { ...options, fps, totalFrames };
  const warnings: string[] = [];
  const segments: SourceSegment[] = [];

  text.split(/\r?\n/).forEach((line, index) => {
    const parsed = parseTimelineLine(line, index + 1, parseOptions);
    if (parsed.warning) warnings.push(parsed.warning);
    segments.push(...parsed.segments);
  });

  if (!segments.length) {
    warnings.push("No source segments were parsed from the timeline text.");
  }

  return SourceTimelineParseResponseSchema.parse({
    segments,
    warnings,
    ...summarizeSourceSegments(segments, fps),
  });
}
