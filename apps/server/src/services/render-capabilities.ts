import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  DEFAULT_PRESET_ID,
  EXPORT_PRESETS,
  type ExportCapability,
} from "@content-tools/shared";
import { FFMPEG_PATH } from "../config.js";

const CACHE_TTL_MS = 60_000;
const NVENC_ENCODER = "h264_nvenc";

type CapabilityStatus = {
  available: boolean;
  reason?: string;
};

type PresetStatus = {
  id: string;
  label: string;
  codec: string;
  hardware: boolean;
  requiresCapability?: ExportCapability;
  available: boolean;
  reason?: string;
};

export type RenderCapabilities = {
  checkedAt: string;
  ffmpegPath: string;
  capabilities: Record<ExportCapability, CapabilityStatus>;
  presets: PresetStatus[];
};

export class RenderPresetUnavailableError extends Error {
  statusCode = 400;

  constructor(
    readonly presetId: string,
    readonly capability: ExportCapability,
    reason: string
  ) {
    super(`Render preset "${presetId}" requires ${capability}: ${reason}`);
    this.name = "RenderPresetUnavailableError";
  }
}

let capabilityCache: { expiresAt: number; value: RenderCapabilities } | null = null;

function truncateReason(value: string, fallback: string): string {
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return fallback;
  return firstLine.length > 240 ? `${firstLine.slice(0, 237)}...` : firstLine;
}

async function runProcess(
  ffmpegPath: string,
  args: string[]
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, output });
    });
  });
}

async function listEncoders(
  ffmpegPath: string
): Promise<{ ok: boolean; output: string; reason?: string }> {
  try {
    const result = await runProcess(ffmpegPath, ["-hide_banner", "-encoders"]);
    if (result.code !== 0) {
      return {
        ok: false,
        output: result.output,
        reason: truncateReason(result.output, "ffmpeg -encoders failed"),
      };
    }
    return { ok: true, output: result.output };
  } catch (error) {
    return {
      ok: false,
      output: "",
      reason: (error as Error).message || "unable to run ffmpeg",
    };
  }
}

async function probeNvenc(ffmpegPath: string, encodersOutput: string): Promise<CapabilityStatus> {
  if (!new RegExp(`\\b${NVENC_ENCODER}\\b`).test(encodersOutput)) {
    return { available: false, reason: `${NVENC_ENCODER} is not listed by ffmpeg` };
  }

  const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), "content-tools-nvenc-"));
  const outputPath = path.join(probeDir, "probe.mp4");
  try {
    const result = await runProcess(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=256x144:r=1:d=1",
      "-frames:v",
      "1",
      "-c:v",
      NVENC_ENCODER,
      "-preset",
      "p5",
      "-cq",
      "28",
      "-pix_fmt",
      "yuv420p",
      "-f",
      "mp4",
      "-y",
      outputPath,
    ]);
    if (result.code !== 0) {
      return {
        available: false,
        reason: `NVENC encode probe failed: ${truncateReason(result.output, "ffmpeg exited non-zero")}`,
      };
    }
    return { available: true };
  } catch (error) {
    return {
      available: false,
      reason: `NVENC encode probe failed: ${(error as Error).message}`,
    };
  } finally {
    await fs.rm(probeDir, { recursive: true, force: true });
  }
}

function buildPresetStatuses(
  capabilities: Record<ExportCapability, CapabilityStatus>
): PresetStatus[] {
  return Object.values(EXPORT_PRESETS).map((preset) => {
    const required = preset.requiresCapability;
    const capability = required ? capabilities[required] : undefined;
    return {
      id: preset.id,
      label: preset.label,
      codec: preset.codec,
      hardware: Boolean(preset.hardware),
      requiresCapability: required,
      available: required ? Boolean(capability?.available) : true,
      reason: required && !capability?.available ? capability?.reason : undefined,
    };
  });
}

async function probeCapabilities(ffmpegPath = FFMPEG_PATH): Promise<RenderCapabilities> {
  const encoders = await listEncoders(ffmpegPath);
  const nvenc = encoders.ok
    ? await probeNvenc(ffmpegPath, encoders.output)
    : { available: false, reason: encoders.reason ?? "unable to list ffmpeg encoders" };
  const capabilities = { nvenc };

  return {
    checkedAt: new Date().toISOString(),
    ffmpegPath,
    capabilities,
    presets: buildPresetStatuses(capabilities),
  };
}

export async function getRenderCapabilities(
  options: { refresh?: boolean } = {}
): Promise<RenderCapabilities> {
  const now = Date.now();
  if (!options.refresh && capabilityCache && capabilityCache.expiresAt > now) {
    return capabilityCache.value;
  }
  const value = await probeCapabilities();
  capabilityCache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

export async function probeRenderCapabilitiesForTests(
  ffmpegPath: string
): Promise<RenderCapabilities> {
  return probeCapabilities(ffmpegPath);
}

export async function assertRenderPresetAvailable(presetId: string): Promise<void> {
  const preset = EXPORT_PRESETS[presetId] ?? EXPORT_PRESETS[DEFAULT_PRESET_ID];
  const required = preset.requiresCapability;
  if (!required) return;

  const status = (await getRenderCapabilities()).capabilities[required];
  if (!status?.available) {
    throw new RenderPresetUnavailableError(
      preset.id,
      required,
      status?.reason ?? "hardware encoder capability is unavailable"
    );
  }
}
