import path from "node:path";

export const WORKSPACE_ROOT =
  process.env.WORKSPACE_ROOT || path.resolve(process.cwd(), "../../workspace");

export const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
export const FFPROBE_PATH = process.env.FFPROBE_PATH || "ffprobe";

export const SERVER_HOST = process.env.HOST || "127.0.0.1";
export const SERVER_PORT = Number(process.env.PORT || 3033);
