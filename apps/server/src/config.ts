import path from "node:path";

export const WORKSPACE_ROOT =
  process.env.WORKSPACE_ROOT || path.resolve(process.cwd(), "../../workspace");

export const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
export const FFPROBE_PATH = process.env.FFPROBE_PATH || "ffprobe";

export const SERVER_HOST = process.env.HOST || "127.0.0.1";
export const SERVER_PORT = Number(process.env.PORT || 3033);

export const UPLOAD_MAX_BYTES = Number(process.env.UPLOAD_MAX_BYTES || 5 * 1024 * 1024 * 1024);

export const REPO_ROOT = process.env.REPO_ROOT
  ? path.resolve(process.env.REPO_ROOT)
  : path.resolve(process.cwd(), "../..");
