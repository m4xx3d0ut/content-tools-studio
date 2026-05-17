export type ExportCapability = "nvenc";

export type ExportPreset = {
  id: string;
  label: string;
  codec: string;
  args: string[];
  hardware?: boolean;
  requiresCapability?: ExportCapability;
};

export const EXPORT_PRESETS: Record<string, ExportPreset> = {
  draft: {
    id: "draft",
    label: "Draft (CPU)",
    codec: "libx264",
    args: ["-crf", "23", "-preset", "veryfast"],
  },
  roughPreview: {
    id: "roughPreview",
    label: "Rough preview (CPU)",
    codec: "libx264",
    args: ["-crf", "32", "-preset", "ultrafast", "-tune", "zerolatency"],
  },
  balanced: {
    id: "balanced",
    label: "Balanced (CPU)",
    codec: "libx264",
    args: ["-crf", "20", "-preset", "medium"],
  },
  quality: {
    id: "quality",
    label: "Quality (CPU)",
    codec: "libx264",
    args: ["-crf", "18", "-preset", "slow"],
  },
  nvencP5Cq20: {
    id: "nvencP5Cq20",
    label: "NVENC P5 CQ20",
    codec: "h264_nvenc",
    args: ["-preset", "p5", "-cq", "20"],
    hardware: true,
    requiresCapability: "nvenc",
  },
};

export const DEFAULT_PRESET_ID = "balanced";
