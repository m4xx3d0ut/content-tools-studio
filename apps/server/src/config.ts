import path from "node:path";

export const WORKSPACE_ROOT =
  process.env.WORKSPACE_ROOT || path.resolve(process.cwd(), "../../workspace");

export const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
export const FFPROBE_PATH = process.env.FFPROBE_PATH || "ffprobe";

export const SERVER_HOST = process.env.HOST || "127.0.0.1";
export const SERVER_PORT = Number(process.env.PORT || 3033);

export const UPLOAD_MAX_BYTES = Number(process.env.UPLOAD_MAX_BYTES || 5 * 1024 * 1024 * 1024);

function positiveNumberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const REPO_ROOT = process.env.REPO_ROOT
  ? path.resolve(process.env.REPO_ROOT)
  : path.resolve(process.cwd(), "../..");

export const RAWFORM_API_BASE = (process.env.RAWFORM_API_BASE || "").replace(/\/+$/, "");
export const RAWFORM_PUBLIC_BASE_URL = (process.env.RAWFORM_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
export const RAWFORM_EDITOR_INGRESS_URL = (process.env.RAWFORM_EDITOR_INGRESS_URL || "").replace(/\/+$/, "");
export const RAWFORM_FETCH_TIMEOUT_MS = positiveNumberFromEnv("RAWFORM_FETCH_TIMEOUT_MS", 30_000);
export const RAWFORM_MEDIA_TIMEOUT_MS = positiveNumberFromEnv("RAWFORM_MEDIA_TIMEOUT_MS", 120_000);
