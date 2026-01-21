import path from "node:path";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import type { Project } from "@content-tools/shared";
import { FFMPEG_PATH, WORKSPACE_ROOT } from "../config.js";
import { ensureDir, fileExists } from "../utils/fs.js";

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0";
  return seconds.toFixed(3);
}

async function runFfmpeg(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `ffmpeg exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

export async function ensureThumbnail(
  project: Project,
  frame: number,
  width: number
): Promise<string> {
  const projectRoot = path.join(WORKSPACE_ROOT, project.id);
  const thumbsDir = path.join(projectRoot, "thumbs");
  await ensureDir(thumbsDir);

  const rawFps = project.video.fpsDen === 0 ? 30 : project.video.fpsNum / project.video.fpsDen;
  const fps = Number.isFinite(rawFps) && rawFps > 0 ? rawFps : 30;
  const safeFrame = Number.isFinite(frame) ? Math.max(0, Math.floor(frame)) : 0;
  const safeWidth = Number.isFinite(width) ? Math.max(80, Math.floor(width)) : 240;
  const time = safeFrame / fps;
  const outputPath = path.join(thumbsDir, `frame_${safeFrame}_w${safeWidth}.jpg`);

  if (await fileExists(outputPath)) {
    return outputPath;
  }

  const inputPath = path.join(projectRoot, "media", project.source.filename);
  const args = [
    "-y",
    "-ss",
    formatTime(time),
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-vf",
    `scale=${safeWidth}:-1`,
    "-q:v",
    "2",
    outputPath,
  ];

  await runFfmpeg(args);
  await fs.access(outputPath);
  return outputPath;
}
