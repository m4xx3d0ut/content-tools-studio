import path from "node:path";
import { promises as fs } from "node:fs";
import type { Overlay, Project } from "@content-tools/shared";
import { DEFAULT_PRESET_ID, EXPORT_PRESETS } from "@content-tools/shared";
import { WORKSPACE_ROOT } from "../config.js";
import { ensureDir } from "../utils/fs.js";

type ExportRequest = {
  presetId?: string;
  includeSlug?: boolean;
  speed?: 1 | 2;
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
  fps: number,
  speed: number,
  videoWidth: number
): { xExpr: string; yExpr: string; enableExpr: string } {
  const motion = overlay.motion ?? {};
  const startFrame = overlay.startFrame;
  const slideFrames = motion.slideInFrames ?? 0;
  const displayFrames = motion.displayFrames;

  const slideSec = slideFrames > 0 ? frameToSeconds(slideFrames, fps, speed) : 0;
  const startSec = frameToSeconds(startFrame, fps, speed);

  let visStartFrame = motion.visibleStartFrame ?? startFrame;
  let visEndFrame = motion.visibleEndFrame ?? overlay.endFrame;

  if (!isArrowOverlay(overlay) && typeof displayFrames === "number") {
    visEndFrame = startFrame + slideFrames + displayFrames;
  }

  const visStartSec = frameToSeconds(visStartFrame, fps, speed);
  const visEndSec = frameToSeconds(visEndFrame, fps, speed);

  const enableExpr = `between(t,${formatNumber(visStartSec)},${formatNumber(
    visEndSec
  )})`;

  const xFinal = overlay.rect.x;
  const yFinal = overlay.rect.y;

  if (isArrowOverlay(overlay)) {
    const bouncePx = motion.bouncePx ?? 0;
    const bouncePeriodFrames = motion.bouncePeriodFrames ?? 0;
    const bounceAxis = resolveBounceAxis(overlay);
    const periodSec =
      bouncePx > 0 && bouncePeriodFrames > 0
        ? frameToSeconds(bouncePeriodFrames, fps, speed)
        : 0;

    if (bouncePx > 0 && periodSec > 0) {
      const t0 = formatNumber(visStartSec);
      const period = formatNumber(periodSec);
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
  if (slideDirection === "none" || slideSec === 0) {
    return {
      xExpr: formatNumber(xFinal),
      yExpr: formatNumber(yFinal),
      enableExpr,
    };
  }

  const xStart = slideDirection === "fromLeft" ? -overlay.rect.w : videoWidth;
  const slideEndSec = startSec + slideSec;
  const xExpr = `if(lt(t,${formatNumber(slideEndSec)}),${formatNumber(
    xStart
  )}+(${formatNumber(xFinal - xStart)})*((t-${formatNumber(
    startSec
  )})/${formatNumber(slideSec)}),${formatNumber(xFinal)})`;

  return {
    xExpr,
    yExpr: formatNumber(yFinal),
    enableExpr,
  };
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
    const opacity = overlay.opacity;
    const formatParts = [
      `[${inputIndex}:v]format=rgba`,
      typeof opacity === "number" ? `,colorchannelmixer=aa=${formatNumber(opacity)}` : "",
      `${ovLabel}`,
    ].join("");

    lines.push(formatParts);

    const { xExpr, yExpr, enableExpr } = buildOverlayExpressions(
      overlay,
      fps,
      speed,
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
