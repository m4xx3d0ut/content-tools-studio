import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import type { Overlay, Project } from "@content-tools/shared";
import { DEFAULT_PRESET_ID, EXPORT_PRESETS } from "@content-tools/shared";
import { FFMPEG_PATH, WORKSPACE_ROOT } from "../config.js";
import { ensureDir, fileExists } from "../utils/fs.js";
import { renderProjectAssets } from "./renderer.js";

type ExportRequest = {
  presetId?: string;
  includeSlug?: boolean;
  speed?: 1 | 2;
};

export type RenderProgress = {
  stage: string;
  message?: string;
  percent?: number;
};

type ExportManifest = {
  projectId: string;
  createdAt: string;
  exportId: string;
  presetId: string;
  speed: 1 | 2;
  includeSlug: boolean;
  source: string;
  overlayInputs: string[];
  arrowInputs: string[];
  filterCards: string;
  filterCardsArrows: string;
  outputLabelCards: string;
  outputLabelCardsArrows: string;
};

type FilterResult = {
  script: string;
  outputLabel: string;
};

type OverlayTiming = {
  startSec: number;
  visStartSec: number;
  visEndSec: number;
  slideInSec: number;
  slideOutSec: number;
  holdSec: number;
  secondsPerFrame: number;
};

type OverlayKind = "card" | "arrow";

type OverlayInput = {
  overlay: Overlay;
  kind: OverlayKind;
  filePath: string;
};

const DEFAULT_VIDEO_WIDTH = 1920;

function sortOverlays(overlays: Overlay[]): Overlay[] {
  return [...overlays].sort((a, b) => {
    if (a.zIndex !== b.zIndex) return a.zIndex - b.zIndex;
    if (a.startFrame !== b.startFrame) return a.startFrame - b.startFrame;
    return a.id.localeCompare(b.id);
  });
}

function isArrowOverlay(overlay: Overlay): boolean {
  return overlay.templateId.startsWith("arrow");
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value
    .toFixed(6)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
}

function escapeFilterExpr(expr: string): string {
  return expr.replace(/,/g, "\\,");
}

function frameToSeconds(frame: number, fps: number, speed: number): number {
  return (frame / fps) * (1 / speed);
}

function computeOverlayTiming(
  overlay: Overlay,
  fps: number,
  speed: number
): OverlayTiming {
  const motion = overlay.motion ?? {};
  const startFrame = overlay.startFrame;
  const slideInFrames = motion.slideInFrames ?? 0;
  const slideOutFrames = motion.slideOutFrames ?? 0;
  const displayFrames = motion.displayFrames;

  let derivedEndFrame = overlay.endFrame;
  if (!isArrowOverlay(overlay) && typeof displayFrames === "number") {
    derivedEndFrame = startFrame + slideInFrames + displayFrames + slideOutFrames;
  }

  const visStartFrame = motion.visibleStartFrame ?? startFrame;
  const visEndFrame = motion.visibleEndFrame ?? derivedEndFrame;

  const totalFrames = Math.max(0, visEndFrame - startFrame);
  const holdFrames =
    typeof displayFrames === "number"
      ? displayFrames
      : Math.max(0, totalFrames - slideInFrames - slideOutFrames);

  const startSec = frameToSeconds(startFrame, fps, speed);
  const secondsPerFrame = 1 / fps / speed;
  const visStartSec = frameToSeconds(visStartFrame, fps, speed);
  const visEndSec = frameToSeconds(
    Math.max(visStartFrame, visEndFrame),
    fps,
    speed
  );

  return {
    startSec,
    visStartSec,
    visEndSec,
    slideInSec: frameToSeconds(slideInFrames, fps, speed),
    slideOutSec: frameToSeconds(slideOutFrames, fps, speed),
    holdSec: frameToSeconds(holdFrames, fps, speed),
    secondsPerFrame,
  };
}

function resolveSlideDirection(
  overlay: Overlay,
  videoWidth: number
): "fromLeft" | "fromRight" | "none" {
  const motion = overlay.motion;
  if (motion?.slideDirection) return motion.slideDirection;
  const centerX = overlay.rect.x + overlay.rect.w / 2;
  return centerX < videoWidth / 2 ? "fromLeft" : "fromRight";
}

function resolveBounceAxis(overlay: Overlay): "x" | "y" {
  const motion = overlay.motion;
  if (motion?.bounceAxis) return motion.bounceAxis;
  if (overlay.templateId.includes("left") || overlay.templateId.includes("right")) {
    return "x";
  }
  return "y";
}

function buildOverlayExpressions(
  overlay: Overlay,
  timing: OverlayTiming,
  videoWidth: number
): { xExpr: string; yExpr: string; enableExpr: string } {
  const motion = overlay.motion ?? {};
  const enableExpr = `between(t,${formatNumber(timing.visStartSec)},${formatNumber(
    timing.visEndSec
  )})`;

  const xFinal = overlay.rect.x;
  const yFinal = overlay.rect.y;

  if (isArrowOverlay(overlay)) {
    const bouncePx = motion.bouncePx ?? 0;
    const bouncePeriodFrames = motion.bouncePeriodFrames ?? 0;
    const bounceAxis = resolveBounceAxis(overlay);
    const bouncePeriodSec =
      bouncePx > 0 && bouncePeriodFrames > 0
        ? bouncePeriodFrames * timing.secondsPerFrame
        : 0;

    if (bouncePx > 0 && bouncePeriodFrames > 0 && bouncePeriodSec > 0) {
      const period = formatNumber(bouncePeriodSec);
      const t0 = formatNumber(timing.visStartSec);
      const bounceExpr = `${formatNumber(bouncePx)}*sin(2*PI*(t-${t0})/${period})`;
      if (bounceAxis === "x") {
        return {
          xExpr: `${formatNumber(xFinal)}+${bounceExpr}`,
          yExpr: formatNumber(yFinal),
          enableExpr,
        };
      }
      return {
        xExpr: formatNumber(xFinal),
        yExpr: `${formatNumber(yFinal)}+${bounceExpr}`,
        enableExpr,
      };
    }

    return {
      xExpr: formatNumber(xFinal),
      yExpr: formatNumber(yFinal),
      enableExpr,
    };
  }

  const slideDirection = resolveSlideDirection(overlay, videoWidth);
  const slideInSec = timing.slideInSec;
  const slideOutSec = timing.slideOutSec;
  const holdSec = timing.holdSec;

  if (slideDirection === "none" || (slideInSec === 0 && slideOutSec === 0)) {
    return {
      xExpr: formatNumber(xFinal),
      yExpr: formatNumber(yFinal),
      enableExpr,
    };
  }

  const xStart = slideDirection === "fromLeft" ? -overlay.rect.w : videoWidth;
  const xExit = xStart;
  const slideInEnd = timing.startSec + slideInSec;
  const holdEnd = slideInEnd + holdSec;

  const slideInExpr =
    slideInSec === 0
      ? formatNumber(xFinal)
      : `${formatNumber(xStart)}+(${formatNumber(xFinal - xStart)})*((t-${formatNumber(
          timing.startSec
        )})/${formatNumber(slideInSec)})`;

  if (slideOutSec === 0) {
    const xExpr = `if(lt(t,${formatNumber(slideInEnd)}),${slideInExpr},${formatNumber(
      xFinal
    )})`;
    return {
      xExpr,
      yExpr: formatNumber(yFinal),
      enableExpr,
    };
  }

  const slideOutExpr = `${formatNumber(xFinal)}+(${formatNumber(
    xExit - xFinal
  )})*((t-${formatNumber(holdEnd)})/${formatNumber(slideOutSec)})`;

  const xExpr = `if(lt(t,${formatNumber(slideInEnd)}),${slideInExpr},if(lt(t,${formatNumber(
    holdEnd
  )}),${formatNumber(xFinal)},${slideOutExpr}))`;

  return {
    xExpr,
    yExpr: formatNumber(yFinal),
    enableExpr,
  };
}

function buildArrowPulseExpr(
  timing: OverlayTiming,
  motion: Overlay["motion"]
): string | null {
  if (!motion?.pulsePeriodFrames) return null;
  const minAlpha = motion.pulseMinAlpha ?? 0.65;
  const maxAlpha = motion.pulseMaxAlpha ?? 1.0;
  const periodSec = motion.pulsePeriodFrames * timing.secondsPerFrame;
  if (periodSec === 0) return null;
  const t0 = formatNumber(timing.visStartSec);
  const period = formatNumber(periodSec);
  const amplitude = formatNumber(maxAlpha - minAlpha);
  const base = formatNumber(minAlpha);
  return `alpha(X,Y)*(${base}+(${amplitude})*(0.5+0.5*sin(2*PI*(T-${t0})/${period})))`;
}

function buildOverlayInputLine(
  overlay: Overlay,
  inputIndex: number,
  timing: OverlayTiming
): string {
  const opacity = overlay.opacity;
  const pulseExpr = isArrowOverlay(overlay)
    ? buildArrowPulseExpr(timing, overlay.motion)
    : null;

  const chain: string[] = [`[${inputIndex}:v]format=rgba`];

  if (pulseExpr) {
    const alphaExpr = escapeFilterExpr(pulseExpr);
    chain.push(
      `,geq=r='r(X\\,Y)':g='g(X\\,Y)':b='b(X\\,Y)':a='${alphaExpr}'`
    );
  }

  if (typeof opacity === "number") {
    chain.push(`,colorchannelmixer=aa=${formatNumber(opacity)}`);
  }

  chain.push(`[ov${inputIndex}]`);
  return chain.join("");
}

function buildFilterScript(
  project: Project,
  overlays: Overlay[],
  speed: 1 | 2
): FilterResult {
  const fps = project.video.fpsNum / project.video.fpsDen;
  const videoWidth = project.video.width || DEFAULT_VIDEO_WIDTH;
  const lines: string[] = [];
  const speedExpr = speed === 2 ? "0.5*PTS" : "PTS-STARTPTS";

  lines.push(`[0:v]setpts=${speedExpr}[v0]`);

  let prevLabel = "[v0]";

  overlays.forEach((overlay, index) => {
    const inputIndex = index + 1;
    const ovLabel = `[ov${inputIndex}]`;
    const timing = computeOverlayTiming(overlay, fps, speed);
    lines.push(buildOverlayInputLine(overlay, inputIndex, timing));

    const { xExpr, yExpr, enableExpr } = buildOverlayExpressions(
      overlay,
      timing,
      videoWidth
    );

    const overlayLine = `${prevLabel}${ovLabel}overlay=x='${escapeFilterExpr(
      xExpr
    )}':y='${escapeFilterExpr(yExpr)}':enable='${escapeFilterExpr(
      enableExpr
    )}'[v${inputIndex}]`;

    lines.push(overlayLine);
    prevLabel = `[v${inputIndex}]`;
  });

  return {
    script: lines.join(";\n"),
    outputLabel: prevLabel,
  };
}

function toPosix(inputPath: string): string {
  return inputPath.replace(/\\/g, "/");
}

function relPath(from: string, to: string): string {
  return toPosix(path.relative(from, to));
}

function buildReadme(
  exportDir: string,
  manifest: ExportManifest,
  cardInputs: OverlayInput[],
  arrowInputs: OverlayInput[]
): string {
  const preset = EXPORT_PRESETS[manifest.presetId] ??
    EXPORT_PRESETS[DEFAULT_PRESET_ID];
  const overlayLines = cardInputs.map(
    (input) => `  -loop 1 -i ${relPath(exportDir, input.filePath)} \\\\`
  );
  const arrowLines = arrowInputs.map(
    (input) => `  -loop 1 -i ${relPath(exportDir, input.filePath)} \\\\`
  );

  const inputVideo = relPath(exportDir, manifest.source);
  const cardsScript = manifest.filterCards;
  const cardsArrowsScript = manifest.filterCardsArrows;

  const cardsCommand = [
    `ffmpeg -y -i ${inputVideo} \\\\`,
    ...overlayLines,
    `  -filter_complex_script ${cardsScript} \\\\`,
    `  -map "${manifest.outputLabelCards}" -c:v ${preset.codec} ${preset.args.join(
      " "
    )} -pix_fmt yuv420p \\\\`,
    "  main_noslug.mp4",
  ].join("\n");

  let arrowsCommand = "";
  if (arrowInputs.length) {
    arrowsCommand = [
      `ffmpeg -y -i ${inputVideo} \\\\`,
      ...overlayLines,
      ...arrowLines,
      `  -filter_complex_script ${cardsArrowsScript} \\\\`,
      `  -map "${manifest.outputLabelCardsArrows}" -c:v ${preset.codec} ${preset.args.join(
        " "
      )} -pix_fmt yuv420p \\\\`,
      "  main_noslug_arrows.mp4",
    ].join("\n");
  }

  const slugNote = manifest.includeSlug
    ? "\nInclude slug: true (two-pass concat). Use slug paths from project.json."
    : "";

  const lines: string[] = [
    "# Export Instructions",
    "",
    "Run these commands from this export folder.",
    "",
    "## Cards only",
    "",
    "```bash",
    cardsCommand,
    "```",
    "",
  ];

  if (arrowInputs.length) {
    lines.push("## Cards + arrows", "", "```bash", arrowsCommand, "```", "");
  }

  if (slugNote) {
    lines.push(slugNote, "");
  }

  return lines.join("\n");
}

function parseTimestamp(value: string): number | null {
  const match = value.match(/(\d+):(\d+):(\d+\.?\d*)/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return null;
  }
  return hours * 3600 + minutes * 60 + seconds;
}

async function runFfmpeg(
  args: string[],
  cwd: string,
  onProgress?: (update: RenderProgress) => void,
  durationSec?: number,
  stage?: string
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let buffer = "";
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const timeMatch = trimmed.match(/time=([0-9:.]+)/);
        if (timeMatch && durationSec) {
          const seconds = parseTimestamp(timeMatch[1]);
          if (seconds !== null) {
            const percent = Math.min(1, Math.max(0, seconds / durationSec));
            onProgress?.({ stage: stage ?? "ffmpeg", percent, message: trimmed });
          }
        } else {
          onProgress?.({ stage: stage ?? "ffmpeg", message: trimmed });
        }
      }
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

function resolveProjectPath(projectRoot: string, inputPath?: string): string | null {
  if (!inputPath) return null;
  return path.isAbsolute(inputPath) ? inputPath : path.join(projectRoot, inputPath);
}

export async function writeExportBundle(
  project: Project,
  options: ExportRequest = {}
): Promise<{ exportDir: string; exportId: string; manifest: ExportManifest }> {
  const exportId = new Date().toISOString().replace(/[:.]/g, "-");
  const projectRoot = path.join(WORKSPACE_ROOT, project.id);
  const exportDir = path.join(projectRoot, "exports", exportId);
  const speed = options.speed ?? project.exportOptions?.speed ?? 1;
  const includeSlug = options.includeSlug ?? project.exportOptions?.includeSlug ?? false;
  const presetId = options.presetId ?? project.lastExportPresetId ?? DEFAULT_PRESET_ID;

  const cards = sortOverlays(project.overlays.filter((overlay) => !isArrowOverlay(overlay)));
  const arrows = sortOverlays(project.overlays.filter(isArrowOverlay));

  const cardInputs: OverlayInput[] = cards.map((overlay) => ({
    overlay,
    kind: "card",
    filePath: path.join(projectRoot, "render", "overlays", `${overlay.id}.png`),
  }));

  const arrowInputs: OverlayInput[] = arrows.map((overlay) => ({
    overlay,
    kind: "arrow",
    filePath: path.join(projectRoot, "render", "arrows", `${overlay.id}.png`),
  }));

  const cardsScript = buildFilterScript(project, cards, speed);
  const cardsArrowsScript = buildFilterScript(project, [...cards, ...arrows], speed);

  await ensureDir(exportDir);

  const filterCardsPath = path.join(exportDir, "filter_complex_cards.txt");
  const filterCardsArrowsPath = path.join(exportDir, "filter_complex_cards_arrows.txt");

  await fs.writeFile(filterCardsPath, cardsScript.script, "utf-8");
  await fs.writeFile(filterCardsArrowsPath, cardsArrowsScript.script, "utf-8");

  const sourcePath = path.join(projectRoot, "media", project.source.filename);

  const manifest: ExportManifest = {
    projectId: project.id,
    createdAt: new Date().toISOString(),
    exportId,
    presetId,
    speed,
    includeSlug,
    source: sourcePath,
    overlayInputs: cardInputs.map((input) => input.filePath),
    arrowInputs: arrowInputs.map((input) => input.filePath),
    filterCards: path.basename(filterCardsPath),
    filterCardsArrows: path.basename(filterCardsArrowsPath),
    outputLabelCards: cardsScript.outputLabel,
    outputLabelCardsArrows: cardsArrowsScript.outputLabel,
  };

  const readme = buildReadme(exportDir, manifest, cardInputs, arrowInputs);

  await fs.writeFile(path.join(exportDir, "README.md"), readme, "utf-8");
  await fs.writeFile(
    path.join(exportDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8"
  );

  return { exportDir, exportId, manifest };
}

export async function renderFinal(
  project: Project,
  options: ExportRequest = {},
  onProgress?: (update: RenderProgress) => void
): Promise<{
  exportDir: string;
  exportId: string;
  finalPath: string;
  manifest: ExportManifest;
}> {
  onProgress?.({ stage: "assets", message: "Rendering overlay assets" });
  await renderProjectAssets(project);

  const { exportDir, exportId, manifest } = await writeExportBundle(project, options);
  const preset = EXPORT_PRESETS[manifest.presetId] ?? EXPORT_PRESETS[DEFAULT_PRESET_ID];

  const missingInputs = [];
  for (const input of [...manifest.overlayInputs, ...manifest.arrowInputs]) {
    if (!(await fileExists(input))) {
      missingInputs.push(input);
    }
  }
  if (missingInputs.length) {
    throw new Error(`Missing overlay assets: ${missingInputs.join(", ")}`);
  }

  const hasArrows = manifest.arrowInputs.length > 0;
  const filterScript = hasArrows ? manifest.filterCardsArrows : manifest.filterCards;
  const outputLabel = hasArrows ? manifest.outputLabelCardsArrows : manifest.outputLabelCards;
  const mainOutputName = hasArrows ? "main_noslug_arrows.mp4" : "main_noslug.mp4";
  const mainOutputPath = path.join(exportDir, mainOutputName);

  const args = ["-y", "-i", manifest.source];
  for (const input of manifest.overlayInputs) {
    args.push("-loop", "1", "-i", input);
  }
  for (const input of manifest.arrowInputs) {
    args.push("-loop", "1", "-i", input);
  }
  args.push(
    "-filter_complex_script",
    filterScript,
    "-map",
    outputLabel,
    "-c:v",
    preset.codec,
    ...preset.args,
    "-pix_fmt",
    "yuv420p",
    mainOutputPath
  );

  const durationSec = (project.video.durationMs / 1000) / (options.speed ?? 1);
  await runFfmpeg(args, exportDir, onProgress, durationSec, "ffmpeg-main");

  const projectRoot = path.join(WORKSPACE_ROOT, project.id);
  const finalPath = path.join(exportDir, "final.mp4");

  if (manifest.includeSlug) {
    const introPath = resolveProjectPath(projectRoot, project.slug?.introPath);
    const outroPath = resolveProjectPath(projectRoot, project.slug?.outroPath);
    if (!introPath || !outroPath) {
      throw new Error("Slug intro/outro paths are required for includeSlug");
    }
    const slugFps = project.slug?.fps ?? project.video.fpsNum / project.video.fpsDen;
    const concatFilter = [
      `[0:v]fps=${slugFps},setsar=1[v0]`,
      `[1:v]fps=${slugFps},setsar=1[v1]`,
      `[2:v]fps=${slugFps},setsar=1[v2]`,
      "[v0][v1][v2]concat=n=3:v=1:a=0[v]",
    ].join(";");
    const finalWithSlug = path.join(exportDir, "final_with_slug.mp4");
    const concatArgs = [
      "-y",
      "-i",
      introPath,
      "-i",
      mainOutputPath,
      "-i",
      outroPath,
      "-filter_complex",
      concatFilter,
      "-map",
      "[v]",
      "-c:v",
      preset.codec,
      ...preset.args,
      "-pix_fmt",
      "yuv420p",
      finalWithSlug,
    ];
    await runFfmpeg(concatArgs, exportDir, onProgress, undefined, "ffmpeg-concat");
    await fs.copyFile(finalWithSlug, finalPath);
  } else {
    await fs.copyFile(mainOutputPath, finalPath);
  }

  onProgress?.({ stage: "done", message: "Render complete", percent: 1 });
  return { exportDir, exportId, finalPath, manifest };
}
