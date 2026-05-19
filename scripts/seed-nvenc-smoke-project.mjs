#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const { values } = parseArgs({
  options: {
    "workspace-root": { type: "string" },
    "project-id": { type: "string", default: "nvenc-smoke" },
    duration: { type: "string", default: "6" },
    width: { type: "string", default: "1280" },
    height: { type: "string", default: "720" },
    fps: { type: "string", default: "30" },
    ffmpeg: { type: "string" },
    "no-overwrite": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(`Seed a repeatable NVENC smoke-test project.

Usage:
  npm run seed:nvenc-smoke -- [options]

Options:
  --workspace-root <path>  Workspace root. Defaults to WORKSPACE_ROOT or ./workspace.
  --project-id <id>       Project directory/id. Defaults to nvenc-smoke.
  --duration <seconds>    Generated source duration. Defaults to 6.
  --width <pixels>        Generated source width. Defaults to 1280.
  --height <pixels>       Generated source height. Defaults to 720.
  --fps <frames>          Generated source frame rate. Defaults to 30.
  --ffmpeg <path>         FFmpeg binary. Defaults to FFMPEG_PATH or ffmpeg.
  --no-overwrite          Fail if the target project already exists.
`);
  process.exit(0);
}

const projectId = String(values["project-id"] ?? "nvenc-smoke");
const workspaceRoot = path.resolve(
  String(values["workspace-root"] ?? process.env.WORKSPACE_ROOT ?? path.join(repoRoot, "workspace"))
);
const ffmpegPath = String(values.ffmpeg ?? process.env.FFMPEG_PATH ?? "ffmpeg");
const durationSec = parsePositiveNumber(values.duration, "duration");
const width = parsePositiveInt(values.width, "width");
const height = parsePositiveInt(values.height, "height");
const fps = parsePositiveInt(values.fps, "fps");
const overwrite = values["no-overwrite"] !== true;

if (!/^[a-z0-9][a-z0-9._-]*$/i.test(projectId)) {
  throw new Error("project id must contain only letters, numbers, dots, underscores, and dashes");
}
if (durationSec < 4) {
  throw new Error("duration must be at least 4 seconds for the smoke-test overlays");
}
if (width % 2 !== 0 || height % 2 !== 0) {
  throw new Error("width and height must be even for H.264 output");
}

const projectRoot = path.resolve(workspaceRoot, projectId);
assertInside(workspaceRoot, projectRoot);

const mediaDir = path.join(projectRoot, "media");
const renderDir = path.join(projectRoot, "render");
const exportsDir = path.join(projectRoot, "exports");
const sourceFilename = "source.mp4";
const sourcePath = path.join(mediaDir, sourceFilename);
const projectPath = path.join(projectRoot, "project.json");

if (overwrite) {
  await rm(projectRoot, { recursive: true, force: true });
} else {
  try {
    await stat(projectRoot);
    throw new Error(`project already exists: ${projectRoot}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

await mkdir(mediaDir, { recursive: true });
await mkdir(renderDir, { recursive: true });
await mkdir(exportsDir, { recursive: true });

await run(ffmpegPath, [
  "-y",
  "-f",
  "lavfi",
  "-i",
  `testsrc2=size=${width}x${height}:rate=${fps}:duration=${durationSec}`,
  "-f",
  "lavfi",
  "-i",
  `sine=frequency=880:sample_rate=48000:duration=${durationSec}`,
  "-shortest",
  "-map",
  "0:v:0",
  "-map",
  "1:a:0",
  "-c:v",
  "libx264",
  "-crf",
  "20",
  "-preset",
  "veryfast",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  "-b:a",
  "128k",
  "-movflags",
  "+faststart",
  "-metadata",
  "title=Content Tools Studio NVENC smoke source",
  sourcePath,
]);

const sourceStat = await stat(sourcePath);
const now = new Date().toISOString();
const durationMs = Math.round(durationSec * 1000);
const durationFrames = Math.round(durationSec * fps);

const project = {
  schemaVersion: 1,
  revision: 1,
  id: projectId,
  name: "NVENC smoke test",
  createdAt: now,
  updatedAt: now,
  source: {
    filename: sourceFilename,
    sizeBytes: sourceStat.size,
    sha256: await hashFile(sourcePath),
  },
  video: {
    width,
    height,
    fpsNum: fps,
    fpsDen: 1,
    durationMs,
    audio: {
      hasAudio: true,
      sampleRate: 48000,
      channels: 1,
    },
  },
  proxy: { enabled: false },
  overlays: [
    {
      id: "nvenc-title-card",
      templateId: "card-lower-third-left",
      templateVersion: "1",
      ...frameWindow(0.5, 4.5),
      rect: scaleRect({ x: 80, y: 468, w: 610, h: 152 }),
      opacity: 0.96,
      zIndex: 10,
      fields: {
        title: "NVENC smoke",
        text: "GPU render preset validation",
      },
      motion: {
        slideInFrames: Math.round(fps * 0.35),
        displayFrames: Math.round(fps * 3.0),
        slideOutFrames: Math.round(fps * 0.35),
      },
    },
    {
      id: "nvenc-gpu-callout",
      templateId: "card-callout-right",
      templateVersion: "1",
      ...frameWindow(2.0, 5.4),
      rect: scaleRect({ x: 710, y: 96, w: 480, h: 150 }),
      opacity: 0.94,
      zIndex: 20,
      fields: {
        title: "h264_nvenc",
        text: "Host B GPU encode path",
      },
      motion: {
        slideInFrames: Math.round(fps * 0.3),
        displayFrames: Math.round(fps * 2.3),
        slideOutFrames: Math.round(fps * 0.3),
      },
    },
    {
      id: "nvenc-arrow",
      templateId: "arrow-right",
      templateVersion: "1",
      ...frameWindow(1.4, 5.0),
      rect: scaleRect({ x: 548, y: 316, w: 128, h: 128 }),
      rotationDeg: 0,
      opacity: 0.9,
      zIndex: 30,
      fields: {},
      motion: {
        visibleStartFrame: secondsToFrame(1.4),
        visibleEndFrame: secondsToFrame(5.0),
        pulsePeriodFrames: Math.round(fps * 0.8),
        pulseMinAlpha: 0.55,
        pulseMaxAlpha: 1,
        bouncePx: Math.round(width * 0.0125),
        bouncePeriodFrames: Math.round(fps * 0.7),
        bounceAxis: "x",
      },
    },
  ],
  exportOptions: {
    speed: 1,
    includeAudio: true,
    includeSlug: false,
    includeSlugStart: false,
    includeSlugEnd: false,
  },
  edits: {
    trimStartFrames: 0,
    trimEndFrames: 0,
    cuts: [],
    sourceSegments: [],
  },
  lastExportPresetId: "nvencP5Cq20",
  renderCache: { overlayAssetHash: {} },
};

await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf-8");

console.log(`Seeded ${project.name}`);
console.log(`Project: ${projectPath}`);
console.log(`Source:  ${sourcePath}`);
console.log("Open the app, select \"NVENC smoke test\", confirm \"NVENC P5 CQ20\", then run a final render.");

function parsePositiveInt(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parsePositiveNumber(value, name) {
  const parsed = Number.parseFloat(String(value));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function assertInside(parent, child) {
  const relative = path.relative(path.resolve(parent), child);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`refusing to write outside workspace root: ${child}`);
  }
}

function secondsToFrame(seconds) {
  return Math.min(durationFrames, Math.round(seconds * fps));
}

function frameWindow(startSec, endSec) {
  const startFrame = Math.min(durationFrames - 1, secondsToFrame(startSec));
  const endFrame = Math.max(startFrame + 1, Math.min(durationFrames, secondsToFrame(endSec)));
  return { startFrame, endFrame };
}

function scaleRect(rect) {
  const sx = width / 1280;
  const sy = height / 720;
  return {
    x: Math.round(rect.x * sx),
    y: Math.round(rect.y * sy),
    w: Math.max(1, Math.round(rect.w * sx)),
    h: Math.max(1, Math.round(rect.h * sy)),
  };
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code}`));
    });
  });
}
