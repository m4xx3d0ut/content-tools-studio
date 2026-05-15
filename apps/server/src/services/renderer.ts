import path from "node:path";
import sharp from "sharp";
import { getOverlayAssetHash, type Overlay, type Project } from "@content-tools/shared";
import { REPO_ROOT, WORKSPACE_ROOT } from "../config.js";
import { ensureDir, fileExists } from "../utils/fs.js";
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
const TITLE_Y_PCT = 0.18;
const SUBTITLE_Y_PCT = 0.55;
const TITLE_SIZE_PCT = 0.3;
const SUBTITLE_SIZE_PCT = 0.18;
const TITLE_COLOR = "#f5f2ea";
const SUBTITLE_COLOR = "#d1c7b8";
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

function resolveTextMargin(value: unknown, fallback: number) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(0, Math.min(400, numeric));
}

function resolveTextOffset(value: unknown, fallback: number) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(-400, Math.min(400, numeric));
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrapTextLines(text: string, fontSize: number, maxWidth: number): string[] {
  const maxChars = Math.max(1, Math.floor(maxWidth / Math.max(1, fontSize * 0.56)));
  const lines: string[] = [];

  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push("");
      continue;
    }

    let current = "";
    for (const word of words) {
      if (word.length > maxChars) {
        if (current) {
          lines.push(current);
          current = "";
        }
        for (let index = 0; index < word.length; index += maxChars) {
          lines.push(word.slice(index, index + maxChars));
        }
        continue;
      }

      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > maxChars && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }

    if (current) lines.push(current);
  }

  return lines;
}

function buildTextSvg(
  width: number,
  height: number,
  title: string,
  subtitle: string | null,
  subtitleAlign: "left" | "center" | "right",
  colors: {
    title: string;
    subtitle: string;
  },
  scales: {
    title: number;
    subtitle: number;
  },
  margins?: { left: number; right: number },
  offsets?: { titleY?: number; subtitleY?: number }
): string {
  const subtitleAnchor =
    subtitleAlign === "center" ? "middle" : subtitleAlign === "right" ? "end" : "start";
  const titleAnchor = "middle";
  const fontFamily = "Arial";
  const lineHeight = 1;

  const marginLeft = margins?.left ?? 0;
  const marginRight = margins?.right ?? 0;
  const textAreaWidth = Math.max(40, width - marginLeft - marginRight);

  const titleX = marginLeft + textAreaWidth / 2;
  const titleSize = Math.max(14, height * TITLE_SIZE_PCT * scales.title);
  const titleTop = Math.max(8, height * TITLE_Y_PCT) + (offsets?.titleY ?? 0);
  const titleY = titleTop + titleSize / 2;

  const subtitleX =
    subtitleAlign === "left"
      ? marginLeft
      : subtitleAlign === "right"
        ? width - marginRight
        : marginLeft + textAreaWidth / 2;
  const subtitleSize = Math.max(12, height * SUBTITLE_SIZE_PCT * scales.subtitle);
  const subtitleTop = Math.max(8, height * SUBTITLE_Y_PCT) + (offsets?.subtitleY ?? 0);
  const subtitleY = subtitleTop + subtitleSize / 2;

  const titleLines = wrapTextLines(title, titleSize, textAreaWidth).map(escapeXml);
  const subtitleLines = subtitle
    ? wrapTextLines(subtitle, subtitleSize, textAreaWidth).map(escapeXml)
    : [];

  const titleTspans = titleLines
    .map(
      (line, index) =>
        `<tspan x="${titleX}" dy="${index === 0 ? 0 : titleSize * lineHeight}">${line}</tspan>`
    )
    .join("");

  const subtitleTspans = subtitleLines
    .map(
      (line, index) =>
        `<tspan x="${subtitleX}" dy="${index === 0 ? 0 : subtitleSize * lineHeight}">${line}</tspan>`
    )
    .join("");

  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <style>
      .title { font-family: ${fontFamily}; font-weight: normal; font-style: normal; }
      .subtitle { font-family: ${fontFamily}; font-weight: normal; font-style: normal; }
    </style>
    <text x="${titleX}" y="${titleY}" text-anchor="${titleAnchor}" fill="${colors.title}" font-size="${titleSize}" dominant-baseline="alphabetic" class="title">
      ${titleTspans}
    </text>
    ${subtitle ? `
    <text x="${subtitleX}" y="${subtitleY}" text-anchor="${subtitleAnchor}" fill="${colors.subtitle}" font-size="${subtitleSize}" dominant-baseline="alphabetic" class="subtitle">
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
  const cachedHash = project.renderCache?.overlayAssetHash?.[overlay.id];
  if (cachedHash === getOverlayAssetHash(overlay) && await fileExists(targetPath)) {
    return targetPath;
  }

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
  const marginLeft = resolveTextMargin(overlay.fields.textMarginLeft, defaultMargins.left);
  const marginRight = resolveTextMargin(overlay.fields.textMarginRight, defaultMargins.right);
  const usesDelta = overlay.fields[OFFSET_MODE_KEY] === OFFSET_MODE_DELTA;
  const rawTextOffset = resolveTextOffset(
    overlay.fields.textOffsetY,
    usesDelta ? 0 : BASE_TEXT_OFFSET
  );
  const rawTitleOffset = resolveTextOffset(
    overlay.fields.titleOffsetY,
    usesDelta ? 0 : BASE_TITLE_OFFSET
  );
  const textOffsetY = usesDelta ? BASE_TEXT_OFFSET + rawTextOffset : rawTextOffset;
  const titleOffsetY = usesDelta ? BASE_TITLE_OFFSET + rawTitleOffset : rawTitleOffset;
  const titleColor = template.title?.color ?? TITLE_COLOR;
  const subtitleColor = template.subtitle?.color ?? SUBTITLE_COLOR;

  const svg = buildTextSvg(
    width,
    height,
    title,
    subtitle,
    textAlign,
    {
      title: titleColor,
      subtitle: subtitleColor,
    },
    {
      title: titleScale,
      subtitle: textScale,
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
