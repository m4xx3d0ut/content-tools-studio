import path from "node:path";
import { promises as fs } from "node:fs";
import sharp from "sharp";
import type { Overlay, Project } from "@content-tools/shared";
import { REPO_ROOT, WORKSPACE_ROOT } from "../config.js";
import { ensureDir } from "../utils/fs.js";
import { DEFAULT_TEMPLATE_ID, getTemplateById } from "./templates.js";

const ARROW_BASE_PATH = path.join(
  REPO_ROOT,
  "k1s-directional-arrows",
  "arrow-right-128x128.png"
);

type CropBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type CropCache = {
  bounds: CropBounds;
  buffer: Buffer;
  width: number;
  height: number;
};

const cropCache = new Map<string, CropCache>();

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function loadTemplateCrop(templatePath: string): Promise<CropCache> {
  const cached = cropCache.get(templatePath);
  if (cached) return cached;

  const image = sharp(templatePath).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  if (!info.width || !info.height) {
    throw new Error(`Unable to read template dimensions for ${templatePath}`);
  }

  let minX = info.width;
  let minY = info.height;
  let maxX = 0;
  let maxY = 0;
  let found = false;

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const idx = (y * info.width + x) * 4 + 3;
      if (data[idx] > 0) {
        found = true;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (!found) {
    minX = 0;
    minY = 0;
    maxX = info.width - 1;
    maxY = info.height - 1;
  }

  const bounds = {
    left: minX,
    top: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };

  const cropped = await sharp(templatePath)
    .extract(bounds)
    .png()
    .toBuffer({ resolveWithObject: true });

  const cacheValue: CropCache = {
    bounds,
    buffer: cropped.data,
    width: cropped.info.width ?? bounds.width,
    height: cropped.info.height ?? bounds.height,
  };

  cropCache.set(templatePath, cacheValue);
  return cacheValue;
}

function buildTextSvg(
  width: number,
  height: number,
  title: string,
  subtitle: string | null,
  align: "left" | "center" | "right",
  layout: {
    title: { xPct: number; yPct: number; sizePct: number; color: string };
    subtitle?: { xPct: number; yPct: number; sizePct: number; color: string };
  }
): string {
  const anchor = align === "center" ? "middle" : align === "right" ? "end" : "start";
  const fontFamily = "Trebuchet MS, Segoe UI, Arial, sans-serif";

  const titleX = layout.title.xPct * width;
  const titleY = layout.title.yPct * height;
  const titleSize = Math.max(14, layout.title.sizePct * height);

  const subtitleX = layout.subtitle ? layout.subtitle.xPct * width : 0;
  const subtitleY = layout.subtitle ? layout.subtitle.yPct * height : 0;
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
    <text x="${titleX}" y="${titleY}" text-anchor="${anchor}" fill="${layout.title.color}" font-size="${titleSize}" dominant-baseline="hanging" class="title">
      ${titleTspans}
    </text>
    ${layout.subtitle && subtitle ? `
    <text x="${subtitleX}" y="${subtitleY}" text-anchor="${anchor}" fill="${layout.subtitle.color}" font-size="${subtitleSize}" dominant-baseline="hanging" class="subtitle">
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

  const { buffer } = await loadTemplateCrop(template.filePath);
  const title = String(overlay.fields.title ?? "");
  const subtitle = overlay.fields.subtitle ? String(overlay.fields.subtitle) : "";

  const svg = buildTextSvg(width, height, title, subtitle, template.align, {
    title: template.title,
    subtitle: template.subtitle,
  });

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
