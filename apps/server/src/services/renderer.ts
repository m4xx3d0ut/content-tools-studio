import path from "node:path";
import sharp from "sharp";
import type { Overlay, Project } from "@content-tools/shared";
import { REPO_ROOT, WORKSPACE_ROOT } from "../config.js";
import { ensureDir } from "../utils/fs.js";
import { DEFAULT_TEMPLATE_ID, getTemplateById } from "./templates.js";
import { getTemplateCrop } from "./template-assets.js";

const ARROW_BASE_PATH = path.join(
  REPO_ROOT,
  "k1s-directional-arrows",
  "arrow-right-128x128.png"
);

const TEXT_ALIGNMENTS = new Set(["left", "center", "right"]);
const DEFAULT_TITLE_SCALE = 0.95;
const DEFAULT_TEXT_SCALE = 1;
const BASE_TITLE_OFFSET = -13;
const BASE_TEXT_OFFSET = -27;
const OFFSET_MODE_KEY = "offsetMode";
const OFFSET_MODE_DELTA = "delta-v1";

function resolveTextAlign(value: unknown, fallback: "left" | "center" | "right") {
  if (typeof value === "string" && TEXT_ALIGNMENTS.has(value)) {
    return value as "left" | "center" | "right";
  }
  return fallback;
}

function getDefaultTextMargins(align: "left" | "center" | "right") {
  if (align === "left") {
    return { left: 34, right: 150 };
  }
  if (align === "right") {
    return { left: 150, right: 34 };
  }
  return { left: 34, right: 34 };
}

function resolveTextScale(value: unknown, fallback = 1) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(2, Math.max(0.5, numeric));
}

function resolveTextMargin(value: unknown, fallback: number, width: number) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  const clamped = Math.max(0, Math.min(width * 0.5, numeric));
  return clamped;
}

function resolveTextOffset(value: unknown, fallback: number, height: number) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  const limit = height * 0.5;
  return Math.max(-limit, Math.min(limit, numeric));
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildTextSvg(
  width: number,
  height: number,
  title: string,
  subtitle: string | null,
  subtitleAlign: "left" | "center" | "right",
  layout: {
    title: { xPct: number; yPct: number; sizePct: number; color: string };
    subtitle?: { xPct: number; yPct: number; sizePct: number; color: string };
  },
  margins?: { left: number; right: number },
  offsets?: { titleY?: number; subtitleY?: number }
): string {
  const subtitleAnchor =
    subtitleAlign === "center" ? "middle" : subtitleAlign === "right" ? "end" : "start";
  const titleAnchor = "middle";
  const fontFamily = "Trebuchet MS, Segoe UI, Arial, sans-serif";

  const marginLeft = margins?.left ?? 0;
  const marginRight = margins?.right ?? 0;
  const textAreaWidth = Math.max(1, width - marginLeft - marginRight);

  const titleX = marginLeft + textAreaWidth / 2;
  const titleY = layout.title.yPct * height + (offsets?.titleY ?? 0);
  const titleSize = Math.max(14, layout.title.sizePct * height);

  const subtitleX = layout.subtitle
    ? subtitleAlign === "left"
      ? marginLeft
      : subtitleAlign === "right"
        ? width - marginRight
        : marginLeft + textAreaWidth / 2
    : 0;
  const subtitleY = layout.subtitle
    ? layout.subtitle.yPct * height + (offsets?.subtitleY ?? 0)
    : 0;
  const subtitleSize = layout.subtitle ? Math.max(12, layout.subtitle.sizePct * height) : 0;

  const titleLines = escapeXml(title).split("\n");
  const subtitleLines = subtitle ? escapeXml(subtitle).split("\n") : [];

  const titleTspans = titleLines
    .map(
      (line, index) =>
        `<tspan x="${titleX}" dy="${index === 0 ? 0 : titleSize * 1.2}">${line}</tspan>`
    )
    .join("");

  const subtitleTspans = subtitleLines
    .map(
      (line, index) =>
        `<tspan x="${subtitleX}" dy="${index === 0 ? 0 : subtitleSize * 1.2}">${line}</tspan>`
    )
    .join("");

  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <style>
      .title { font-family: ${fontFamily}; font-weight: 700; }
      .subtitle { font-family: ${fontFamily}; font-weight: 500; }
    </style>
    <text x="${titleX}" y="${titleY}" text-anchor="${titleAnchor}" fill="${layout.title.color}" font-size="${titleSize}" dominant-baseline="hanging" class="title">
      ${titleTspans}
    </text>
    ${layout.subtitle && subtitle ? `
    <text x="${subtitleX}" y="${subtitleY}" text-anchor="${subtitleAnchor}" fill="${layout.subtitle.color}" font-size="${subtitleSize}" dominant-baseline="hanging" class="subtitle">
      ${subtitleTspans}
    </text>` : ""}
  </svg>`;
}

function isArrowOverlay(overlay: Overlay): boolean {
  return overlay.templateId.startsWith("arrow");
}

export async function renderOverlayAsset(
  project: Project,
  overlay: Overlay
): Promise<string> {
  const projectRoot = path.join(WORKSPACE_ROOT, project.id);
  const kind = isArrowOverlay(overlay) ? "arrows" : "overlays";
  const targetDir = path.join(projectRoot, "render", kind);
  await ensureDir(targetDir);

  const targetPath = path.join(targetDir, `${overlay.id}.png`);
  const width = Math.max(1, Math.floor(overlay.rect.w));
  const height = Math.max(1, Math.floor(overlay.rect.h));

  if (isArrowOverlay(overlay)) {
    const rotation = overlay.rotationDeg ?? 0;
    await sharp(ARROW_BASE_PATH)
      .ensureAlpha()
      .rotate(rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .resize(width, height)
      .png()
      .toFile(targetPath);
    return targetPath;
  }

  const templateId = overlay.templateId === "card-basic" ? DEFAULT_TEMPLATE_ID : overlay.templateId;
  const template = getTemplateById(templateId) ?? getTemplateById(DEFAULT_TEMPLATE_ID);
  if (!template) {
    throw new Error("No card template available");
  }

  const { buffer } = await getTemplateCrop(template.filePath);
  const title = String(overlay.fields.title ?? "");
  const rawText = overlay.fields.text ?? overlay.fields.subtitle ?? "";
  const subtitle = rawText ? String(rawText) : "";
  const textAlign = resolveTextAlign(overlay.fields.textAlign, template.align);
  const textScale = resolveTextScale(overlay.fields.textScale, DEFAULT_TEXT_SCALE);
  const titleScale = resolveTextScale(overlay.fields.titleScale, DEFAULT_TITLE_SCALE);
  const defaultMargins = getDefaultTextMargins(template.align);
  const marginLeft = resolveTextMargin(overlay.fields.textMarginLeft, defaultMargins.left, width);
  const marginRight = resolveTextMargin(overlay.fields.textMarginRight, defaultMargins.right, width);
  const usesDelta = overlay.fields[OFFSET_MODE_KEY] === OFFSET_MODE_DELTA;
  const rawTextOffset = resolveTextOffset(
    overlay.fields.textOffsetY,
    usesDelta ? 0 : BASE_TEXT_OFFSET,
    height
  );
  const rawTitleOffset = resolveTextOffset(
    overlay.fields.titleOffsetY,
    usesDelta ? 0 : BASE_TITLE_OFFSET,
    height
  );
  const textOffsetY = usesDelta ? BASE_TEXT_OFFSET + rawTextOffset : rawTextOffset;
  const titleOffsetY = usesDelta ? BASE_TITLE_OFFSET + rawTitleOffset : rawTitleOffset;
  const titleLayout = { ...template.title, sizePct: template.title.sizePct * titleScale };
  const subtitleLayout = template.subtitle
    ? { ...template.subtitle, sizePct: template.subtitle.sizePct * textScale }
    : undefined;

  const svg = buildTextSvg(
    width,
    height,
    title,
    subtitle,
    textAlign,
    {
      title: titleLayout,
      subtitle: subtitleLayout,
    },
    { left: marginLeft, right: marginRight },
    { titleY: titleOffsetY, subtitleY: textOffsetY }
  );

  await sharp(buffer)
    .resize(width, height)
    .composite([{ input: Buffer.from(svg) }])
    .png()
    .toFile(targetPath);

  return targetPath;
}

export async function renderProjectAssets(project: Project): Promise<void> {
  for (const overlay of project.overlays) {
    await renderOverlayAsset(project, overlay);
  }
}
