import path from "node:path";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type { SlugAsset, SlugLibraryManifest } from "@content-tools/shared";
import { SlugLibraryManifestSchema, SlugAssetSchema } from "@content-tools/shared";
import { REPO_ROOT, WORKSPACE_ROOT } from "../config.js";
import { ensureDir, fileExists } from "../utils/fs.js";
import { probeVideo } from "./ffprobe.js";

const SLUG_ROOT = path.join(WORKSPACE_ROOT, "slugs");
const SLUG_MEDIA_DIR = path.join(SLUG_ROOT, "media");
const SLUG_MANIFEST_PATH = path.join(SLUG_ROOT, "slugs.json");
const REPO_SLUG_ROOT = path.join(REPO_ROOT, "slug");

function toPosix(inputPath: string): string {
  return inputPath.replace(/\\/g, "/");
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "slug"
  );
}

function sanitizeFilename(value: string): string {
  const parsed = path.parse(path.basename(value));
  const name = slugify(parsed.name);
  return `${name}.mp4`;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function ensureSlugStorage(): Promise<void> {
  await ensureDir(SLUG_MEDIA_DIR);
}

async function readManifestFile(): Promise<SlugLibraryManifest> {
  if (!(await fileExists(SLUG_MANIFEST_PATH))) {
    return { schemaVersion: 1, assets: [] };
  }
  const raw = await fs.readFile(SLUG_MANIFEST_PATH, "utf-8");
  return SlugLibraryManifestSchema.parse(JSON.parse(raw));
}

async function writeManifestFile(manifest: SlugLibraryManifest): Promise<void> {
  await ensureSlugStorage();
  await fs.writeFile(
    SLUG_MANIFEST_PATH,
    JSON.stringify(SlugLibraryManifestSchema.parse(manifest), null, 2),
    "utf-8"
  );
}

function uniqueIdForLabel(label: string, existing: SlugAsset[]): string {
  const base = slugify(label);
  const existingIds = new Set(existing.map((asset) => asset.id));
  if (!existingIds.has(base)) return base;
  let index = 2;
  while (existingIds.has(`${base}-${index}`)) {
    index += 1;
  }
  return `${base}-${index}`;
}

async function createSlugAssetFromFile(
  inputPath: string,
  originalName: string,
  source: "seed" | "upload"
): Promise<SlugAsset> {
  if (path.extname(originalName).toLowerCase() !== ".mp4") {
    throw new Error("slug video must be an mp4 file");
  }

  await ensureSlugStorage();
  const manifest = await readManifestFile();
  const label = path.parse(path.basename(originalName)).name.replace(/[-_]+/g, " ").trim() || "Slug";
  const id = source === "seed" ? uniqueIdForLabel(label, manifest.assets) : randomUUID();
  const filename = `${id}-${sanitizeFilename(originalName)}`;
  const outputPath = path.join(SLUG_MEDIA_DIR, filename);
  const relativePath = toPosix(path.join("slugs", "media", filename));

  await fs.copyFile(inputPath, outputPath);
  const video = await probeVideo(outputPath);
  const stat = await fs.stat(outputPath);
  const sha256 = await hashFile(outputPath);
  const now = new Date().toISOString();

  const asset = SlugAssetSchema.parse({
    id,
    label,
    filename,
    path: relativePath,
    source,
    video,
    sizeBytes: stat.size,
    sha256,
    createdAt: now,
    updatedAt: now,
  });

  await writeManifestFile({ schemaVersion: 1, assets: [...manifest.assets, asset] });
  return asset;
}

export function isManagedSlugPath(inputPath?: string): boolean {
  return Boolean(inputPath?.startsWith("slugs/media/"));
}

export function slugAssetFilePath(assetOrPath: SlugAsset | string): string {
  const relativePath = typeof assetOrPath === "string" ? assetOrPath : assetOrPath.path;
  return path.join(WORKSPACE_ROOT, relativePath);
}

export async function ensureSlugLibrary(): Promise<void> {
  await ensureSlugStorage();
  if (await fileExists(SLUG_MANIFEST_PATH)) return;

  await writeManifestFile({ schemaVersion: 1, assets: [] });
  if (!(await fileExists(REPO_SLUG_ROOT))) return;

  const entries = await fs.readdir(REPO_SLUG_ROOT, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".mp4") continue;
    try {
      await createSlugAssetFromFile(path.join(REPO_SLUG_ROOT, entry.name), entry.name, "seed");
    } catch (error) {
      console.warn(`Skipping slug seed ${entry.name}: ${(error as Error).message}`);
    }
  }
}

export async function listSlugAssets(): Promise<SlugAsset[]> {
  await ensureSlugLibrary();
  const manifest = await readManifestFile();
  return [...manifest.assets].sort((a, b) => a.label.localeCompare(b.label));
}

export async function getSlugAsset(id: string): Promise<SlugAsset | null> {
  const assets = await listSlugAssets();
  return assets.find((asset) => asset.id === id) ?? null;
}

export async function getSlugAssetByPath(inputPath?: string): Promise<SlugAsset | null> {
  if (!inputPath) return null;
  const assets = await listSlugAssets();
  return assets.find((asset) => asset.path === inputPath) ?? null;
}

export async function importSlugAsset(inputPath: string, originalName: string): Promise<SlugAsset> {
  await ensureSlugLibrary();
  return createSlugAssetFromFile(inputPath, originalName, "upload");
}

export async function deleteSlugAsset(id: string): Promise<boolean> {
  await ensureSlugLibrary();
  const manifest = await readManifestFile();
  const asset = manifest.assets.find((item) => item.id === id);
  if (!asset) return false;
  await fs.rm(slugAssetFilePath(asset), { force: true });
  await writeManifestFile({
    schemaVersion: 1,
    assets: manifest.assets.filter((item) => item.id !== id),
  });
  return true;
}

export async function upsertSlugAssets(assets: SlugAsset[]): Promise<void> {
  await ensureSlugLibrary();
  const manifest = await readManifestFile();
  const byId = new Map(manifest.assets.map((asset) => [asset.id, asset]));
  for (const asset of assets) {
    if (!isManagedSlugPath(asset.path)) continue;
    if (!(await fileExists(slugAssetFilePath(asset)))) continue;
    byId.set(asset.id, SlugAssetSchema.parse(asset));
  }
  await writeManifestFile({ schemaVersion: 1, assets: [...byId.values()] });
}
