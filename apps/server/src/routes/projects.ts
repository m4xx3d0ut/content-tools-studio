import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { Project, SlugAsset, VideoInfo } from "@content-tools/shared";
import {
  applyEditorCommands,
  CommandBatchRequestSchema,
  getProjectTotalFrames,
  getVideoFps,
  parseSourceTimelineText,
  ProjectSchema,
  SlugAssetSchema,
  SourceTimelineParseRequestSchema,
  type ArrowForEditing,
  type TemplateForEditing,
} from "@content-tools/shared";
import path from "node:path";
import { promises as fs, createWriteStream, createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Readable, Transform } from "node:stream";
import type { TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  createProject,
  deleteProject,
  listProjects,
  projectDir,
  readProject,
  writeProject,
} from "../services/workspace.js";
import { probeAudio, probeVideo } from "../services/ffprobe.js";
import {
  getSurgicalPatchStatus,
  renderFinal,
  renderSurgicalPatch,
  writeExportBundle,
  type RenderProgress,
} from "../services/exporter.js";
import { RenderPresetUnavailableError } from "../services/render-capabilities.js";
import { FFMPEG_PATH, UPLOAD_MAX_BYTES, WORKSPACE_ROOT } from "../config.js";
import { ensureDir, fileExists } from "../utils/fs.js";
import { ensureThumbnail } from "../services/thumbnails.js";
import { getTemplateCrop } from "../services/template-assets.js";
import { listTemplates } from "../services/templates.js";
import {
  getSlugAssetByPath,
  isManagedSlugPath,
  slugAssetFilePath,
  upsertSlugAssets,
} from "../services/slugs.js";
import {
  emitProjectDeleted,
  emitProjectUpdated,
  onProjectEvent,
  type ProjectEvent,
} from "../services/project-events.js";
import {
  assetParamsSchema,
  errorResponses,
  exportOptionsBodySchema,
  projectIdParamsSchema,
  routeDoc,
} from "../openapi.js";

const NORMALIZED_WIDTH = 1920;
const NORMALIZED_HEIGHT = 1080;
const BUNDLE_MANIFEST_FILENAME = "manifest.json";
const BUNDLE_PROJECT_FILENAME = "project.json";
const BUNDLE_MODE_VALUES = ["project", "project-media", "full"] as const;
type BundleMode = (typeof BUNDLE_MODE_VALUES)[number];
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".oga", ".opus"]);
const AUDIO_EXTENSION_RE = /\.(mp3|wav|m4a|aac|flac|ogg|oga|opus)(?:$|[?#])/i;
const AUDIO_CONTENT_TYPE_EXTENSION: Record<string, string> = {
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/flac": ".flac",
  "audio/ogg": ".ogg",
  "audio/opus": ".opus",
  "application/ogg": ".ogg",
};

function clampEven(value: number): number {
  if (!Number.isFinite(value)) return 2;
  const rounded = Math.round(value);
  const even = rounded % 2 === 0 ? rounded : rounded - 1;
  return Math.max(2, even);
}

class SizeLimitTransform extends Transform {
  private bytes = 0;

  constructor(private readonly limitBytes: number) {
    super();
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.limitBytes) {
      callback(new Error(`download exceeds ${this.limitBytes} bytes`));
      return;
    }
    callback(null, chunk);
  }
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

type RenderOptionsQuery = {
  presetId?: string;
  includeAudio?: string;
  includeSlug?: string;
  includeSlugStart?: string;
  includeSlugEnd?: string;
  speed?: string;
  renderMode?: string;
};

function sendRenderError(reply: FastifyReply, error: unknown) {
  if (error instanceof RenderPresetUnavailableError) {
    return reply.code(error.statusCode).send({
      error: error.message,
      presetId: error.presetId,
      capability: error.capability,
    });
  }
  return reply.code(500).send({ error: (error as Error).message });
}

function parseRenderOptionsQuery(query: RenderOptionsQuery): {
  presetId?: string;
  includeAudio?: boolean;
  includeSlug?: boolean;
  includeSlugStart?: boolean;
  includeSlugEnd?: boolean;
  speed?: 1 | 2;
  renderMode?: "final" | "rough";
} {
  const includeAudio =
    typeof query.includeAudio === "string" ? query.includeAudio === "true" : undefined;
  const includeSlug = query.includeSlug === "true";
  const includeSlugStart =
    query.includeSlugStart === "true" || (includeSlug && query.includeSlugStart == null);
  const includeSlugEnd =
    query.includeSlugEnd === "true" || (includeSlug && query.includeSlugEnd == null);
  return {
    presetId: query.presetId,
    includeAudio,
    includeSlug,
    includeSlugStart,
    includeSlugEnd,
    speed: query.speed ? (Number(query.speed) as 1 | 2) : undefined,
    renderMode:
      query.renderMode === "rough"
        ? "rough"
        : query.renderMode === "final"
          ? "final"
          : undefined,
  };
}

async function normalizeVideoIfNeeded(
  video: VideoInfo,
  inputPath: string,
  originalName: string,
  mediaDir: string
): Promise<{ filePath: string; filename: string; video: VideoInfo }> {
  const isPortrait = video.height > video.width;
  const maxWidth = isPortrait ? NORMALIZED_HEIGHT : NORMALIZED_WIDTH;
  const maxHeight = isPortrait ? NORMALIZED_WIDTH : NORMALIZED_HEIGHT;
  const widthScale = maxWidth / video.width;
  const heightScale = maxHeight / video.height;
  const scale = Math.min(1, widthScale, heightScale);
  if (scale >= 1) {
    return { filePath: inputPath, filename: originalName, video };
  }

  const parsed = path.parse(originalName);
  const normalizedWidth = clampEven(video.width * scale);
  const normalizedHeight = clampEven(video.height * scale);
  const normalizedName = `${parsed.name}_${normalizedWidth}x${normalizedHeight}.mp4`;
  const outputPath = path.join(mediaDir, normalizedName);
  const filter = `scale=${normalizedWidth}:${normalizedHeight},setsar=1`;

  const args = [
    "-y",
    "-i",
    inputPath,
    "-vf",
    filter,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-c:v",
    "libx264",
    "-crf",
    "18",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "copy",
    "-movflags",
    "+faststart",
    outputPath,
  ];

  await runFfmpeg(args);
  const normalizedVideo = await probeVideo(outputPath);
  return { filePath: outputPath, filename: normalizedName, video: normalizedVideo };
}

export async function importSourceVideo(
  project: Project,
  input: { stream: NodeJS.ReadableStream; filename: string }
): Promise<Project> {
  const filename = path.basename(input.filename);
  const projectRoot = path.join(WORKSPACE_ROOT, project.id);
  const mediaDir = path.join(projectRoot, "media");
  await ensureDir(mediaDir);

  const targetPath = path.join(mediaDir, filename);
  try {
    await pipeline(input.stream, new SizeLimitTransform(UPLOAD_MAX_BYTES), createWriteStream(targetPath));
  } catch (error) {
    await fs.unlink(targetPath).catch(() => undefined);
    throw error;
  }

  let video;
  try {
    video = await probeVideo(targetPath);
  } catch (error) {
    await fs.unlink(targetPath).catch(() => undefined);
    throw new Error(`video probe failed: ${(error as Error).message}`);
  }

  const normalized = await normalizeVideoIfNeeded(video, targetPath, filename, mediaDir);
  video = normalized.video;
  const finalPath = normalized.filePath;
  const finalFilename = normalized.filename;
  const stat = await fs.stat(finalPath);
  const sha256 = await hashFile(finalPath);

  const now = new Date().toISOString();
  const updatedProject = ProjectSchema.parse({
    ...project,
    revision: (project.revision ?? 1) + 1,
    updatedAt: now,
    source: {
      filename: finalFilename,
      sizeBytes: stat.size,
      sha256,
    },
    video,
  });

  await writeProject(updatedProject);
  return updatedProject;
}

async function getEditingTemplates(): Promise<TemplateForEditing[]> {
  return Promise.all(
    listTemplates().map(async (template) => {
      const crop = await getTemplateCrop(template.filePath);
      return {
        id: template.id,
        bounds: crop.bounds,
        sourceWidth: crop.sourceWidth,
        sourceHeight: crop.sourceHeight,
        align: template.align,
      };
    })
  );
}

function getEditingArrows(): ArrowForEditing[] {
  return [{ id: "arrow-right", sourceWidth: 128, sourceHeight: 128 }];
}

function sendProjectEvent(reply: FastifyReply, event: ProjectEvent): void {
  reply.raw.write(`event: ${event.type}\n`);
  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

function sanitizeArchiveName(value: string): string {
  return value.replace(/[^a-z0-9-_]+/gi, "_") || "project";
}

function sanitizeTimelineAssetFilename(value: string): string {
  const parsed = path.parse(path.basename(value));
  const name = parsed.name.replace(/[^a-z0-9._-]+/gi, "_") || "image";
  return `${name}.png`;
}

function audioExtensionFromContentType(contentType?: string | null): string | null {
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
  if (!normalized) return null;
  return AUDIO_CONTENT_TYPE_EXTENSION[normalized] ?? null;
}

function sanitizeAudioAssetFilename(
  value: string | undefined,
  contentType?: string | null
): string {
  const parsed = path.parse(path.basename(value || "audio"));
  const typeExtension = audioExtensionFromContentType(contentType);
  const extension = AUDIO_EXTENSIONS.has(parsed.ext.toLowerCase())
    ? parsed.ext.toLowerCase()
    : typeExtension ?? ".audio";
  const name = parsed.name.replace(/[^a-z0-9._-]+/gi, "_") || `audio-${randomUUID()}`;
  return `${name}${extension}`;
}

function filenameFromContentDisposition(value?: string | null): string | null {
  if (!value) return null;
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.replace(/^"|"$/g, ""));
    } catch {
      return encoded.replace(/^"|"$/g, "");
    }
  }
  return value.match(/filename="?([^";]+)"?/i)?.[1] ?? null;
}

function isAudioResponse(response: Response, requestUrl: string): boolean {
  const contentType = response.headers.get("content-type");
  if (audioExtensionFromContentType(contentType)) return true;
  if (contentType?.toLowerCase().includes("text/html")) return false;
  return AUDIO_EXTENSION_RE.test(new URL(response.url || requestUrl).pathname);
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#47;/g, "/")
    .replace(/&quot;/g, "\"");
}

function extractAudioUrlsFromHtml(html: string, pageUrl: string): string[] {
  const base = new URL(pageUrl);
  const candidates = new Set<string>();
  const attrPattern = /(?:href|src|content)=["']([^"']+)["']/gi;
  for (const match of html.matchAll(attrPattern)) {
    const raw = decodeHtmlAttribute(match[1] ?? "");
    if (!AUDIO_EXTENSION_RE.test(raw)) continue;
    try {
      const resolved = raw.startsWith("//")
        ? `${base.protocol}${raw}`
        : new URL(raw, base).toString();
      candidates.add(resolved);
    } catch {
      // Ignore malformed URLs discovered in arbitrary HTML.
    }
  }
  return [...candidates].sort((a, b) => {
    const aUpload = a.includes("upload.wikimedia.org") ? 0 : 1;
    const bUpload = b.includes("upload.wikimedia.org") ? 0 : 1;
    return aUpload - bUpload;
  });
}

async function fetchAudioResponse(inputUrl: string): Promise<Response> {
  let initialUrl: URL;
  try {
    initialUrl = new URL(inputUrl);
  } catch {
    throw new Error("audio URL is invalid");
  }
  if (initialUrl.protocol !== "http:" && initialUrl.protocol !== "https:") {
    throw new Error("audio URL must use http or https");
  }

  const response = await fetch(initialUrl, {
    redirect: "follow",
    headers: { "User-Agent": "content-tools-studio/1.0" },
  });
  if (!response.ok) {
    throw new Error(`audio URL returned ${response.status}`);
  }
  if (isAudioResponse(response, initialUrl.toString())) {
    return response;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/html")) {
    throw new Error("URL did not return an audio file");
  }

  const html = await response.text();
  const candidates = extractAudioUrlsFromHtml(html, response.url || initialUrl.toString());
  for (const candidate of candidates) {
    const candidateResponse = await fetch(candidate, {
      redirect: "follow",
      headers: { "User-Agent": "content-tools-studio/1.0" },
    });
    if (candidateResponse.ok && isAudioResponse(candidateResponse, candidate)) {
      return candidateResponse;
    }
  }

  throw new Error("Could not find an audio file link on the URL page");
}

async function persistAudioAsset(
  projectId: string,
  input: {
    stream: NodeJS.ReadableStream;
    filename?: string;
    contentType?: string | null;
    source: "upload" | "url";
    originalUrl?: string;
  }
) {
  const filename = sanitizeAudioAssetFilename(input.filename, input.contentType);
  const projectRoot = path.join(WORKSPACE_ROOT, projectId);
  const targetDir = path.join(projectRoot, "media", "audio");
  await ensureDir(targetDir);
  const targetPath = path.join(targetDir, filename);
  await pipeline(input.stream, new SizeLimitTransform(UPLOAD_MAX_BYTES), createWriteStream(targetPath));

  try {
    const audio = await probeAudio(targetPath);
    const stat = await fs.stat(targetPath);
    return {
      ok: true,
      path: toPosix(path.join("media", "audio", filename)),
      filename,
      sizeBytes: stat.size,
      sha256: await hashFile(targetPath),
      audio,
      source: input.source,
      originalUrl: input.originalUrl,
    };
  } catch (error) {
    await fs.unlink(targetPath).catch(() => undefined);
    throw error;
  }
}

function toPosix(inputPath: string): string {
  return inputPath.replace(/\\/g, "/");
}

function resolveBundleMode(raw: unknown): BundleMode {
  return typeof raw === "string" && (BUNDLE_MODE_VALUES as readonly string[]).includes(raw)
    ? (raw as BundleMode)
    : "project-media";
}

function normalizeBundleEntryPath(entryPath: string): string | null {
  const normalized = path.posix.normalize(entryPath.replace(/\\/g, "/"));
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    return null;
  }
  if (path.posix.isAbsolute(normalized)) return null;
  return normalized;
}

function isAllowedBundleEntry(entryPath: string): boolean {
  return (
    entryPath === BUNDLE_MANIFEST_FILENAME ||
    entryPath === BUNDLE_PROJECT_FILENAME ||
    entryPath.startsWith("media/") ||
    entryPath.startsWith("render/") ||
    entryPath.startsWith("exports/") ||
    entryPath.startsWith("slugs/media/")
  );
}

function getProjectTimelineAssetPaths(project: Project): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const segment of project.edits?.sourceSegments ?? []) {
    if (segment.kind !== "image" || !segment.assetPath) continue;
    const normalized = normalizeBundleEntryPath(segment.assetPath);
    if (!normalized || !normalized.startsWith("media/")) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    paths.push(normalized);
  }
  return paths;
}

function getProjectAudioAssetPaths(project: Project): string[] {
  const normalized = project.audioTrack?.assetPath
    ? normalizeBundleEntryPath(project.audioTrack.assetPath)
    : null;
  if (!normalized || !normalized.startsWith("media/audio/")) return [];
  return [normalized];
}

async function addBundleFile(
  entries: Record<string, Uint8Array>,
  rootDir: string,
  relativePath: string
): Promise<void> {
  const filePath = path.join(rootDir, relativePath);
  if (!(await fileExists(filePath))) return;
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) return;
  entries[toPosix(relativePath)] = new Uint8Array(await fs.readFile(filePath));
}

async function addBundleDirectory(
  entries: Record<string, Uint8Array>,
  rootDir: string,
  relativeDir: string
): Promise<void> {
  const directory = path.join(rootDir, relativeDir);
  if (!(await fileExists(directory))) return;
  const dirEntries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of dirEntries) {
    const childRelative = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      await addBundleDirectory(entries, rootDir, childRelative);
      continue;
    }
    if (entry.isFile()) {
      await addBundleFile(entries, rootDir, childRelative);
    }
  }
}

function getProjectManagedSlugPaths(project: Project): string[] {
  return [
    project.slug?.introPath,
    project.slug?.outroPath,
  ].filter((value): value is string => Boolean(value && isManagedSlugPath(value)));
}

async function collectProjectSlugAssets(
  entries: Record<string, Uint8Array>,
  project: Project
): Promise<SlugAsset[]> {
  const assets: SlugAsset[] = [];
  const seenPaths = new Set<string>();
  for (const slugPath of getProjectManagedSlugPaths(project)) {
    if (seenPaths.has(slugPath)) continue;
    seenPaths.add(slugPath);
    const asset = await getSlugAssetByPath(slugPath);
    if (!asset) continue;
    if (!(await fileExists(slugAssetFilePath(asset)))) continue;
    await addBundleFile(entries, WORKSPACE_ROOT, asset.path);
    assets.push(asset);
  }
  return assets;
}

async function buildProjectBundle(project: Project, mode: BundleMode): Promise<Buffer> {
  const rootDir = projectDir(project.id);
  const entries: Record<string, Uint8Array> = {
    [BUNDLE_PROJECT_FILENAME]: strToU8(JSON.stringify(project, null, 2)),
  };

  if (mode === "project-media") {
    await addBundleFile(entries, rootDir, path.join("media", project.source.filename));
    for (const assetPath of getProjectTimelineAssetPaths(project)) {
      await addBundleFile(entries, rootDir, assetPath);
    }
    for (const assetPath of getProjectAudioAssetPaths(project)) {
      await addBundleFile(entries, rootDir, assetPath);
    }
  }

  if (mode === "full") {
    await addBundleDirectory(entries, rootDir, "media");
    await addBundleDirectory(entries, rootDir, "render");
    await addBundleDirectory(entries, rootDir, "exports");
  }

  const slugAssets = mode === "project-media" || mode === "full"
    ? await collectProjectSlugAssets(entries, project)
    : [];
  entries[BUNDLE_MANIFEST_FILENAME] = strToU8(
    JSON.stringify(
      {
        apiVersion: "content-tools.bundle/v1",
        projectId: project.id,
        projectName: project.name,
        mode,
        createdAt: new Date().toISOString(),
        slugAssets,
      },
      null,
      2
    )
  );

  return Buffer.from(zipSync(entries, { level: 6 }));
}

async function importProjectBundleFromZip(payload: Buffer): Promise<Project> {
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(new Uint8Array(payload));
  } catch (error) {
    throw new Error(`invalid project bundle: ${(error as Error).message}`);
  }

  const safeEntries = Object.entries(archive)
    .map(([entryPath, value]) => [normalizeBundleEntryPath(entryPath), value] as const)
    .filter((entry): entry is readonly [string, Uint8Array] => Boolean(entry[0]));

  const projectEntry = safeEntries.find(([entryPath]) => entryPath === BUNDLE_PROJECT_FILENAME);
  if (!projectEntry) {
    throw new Error("project bundle is missing project.json");
  }
  const manifestEntry = safeEntries.find(
    ([entryPath]) => entryPath === BUNDLE_MANIFEST_FILENAME
  );
  const bundledSlugAssets = manifestEntry
    ? ((JSON.parse(strFromU8(manifestEntry[1])) as { slugAssets?: unknown[] }).slugAssets ?? [])
        .map((asset) => SlugAssetSchema.safeParse(asset))
        .filter((result) => result.success)
        .map((result) => result.data)
    : [];

  const sourceProject = ProjectSchema.parse(JSON.parse(strFromU8(projectEntry[1])));
  const newProjectId = randomUUID();
  const newProjectRoot = projectDir(newProjectId);
  await ensureDir(newProjectRoot);
  const resolvedRoot = path.resolve(newProjectRoot);
  const resolvedWorkspaceRoot = path.resolve(WORKSPACE_ROOT);

  for (const [entryPath, value] of safeEntries) {
    if (!isAllowedBundleEntry(entryPath)) continue;
    if (entryPath === BUNDLE_PROJECT_FILENAME || entryPath === BUNDLE_MANIFEST_FILENAME) continue;
    const targetBase = entryPath.startsWith("slugs/") ? WORKSPACE_ROOT : newProjectRoot;
    const resolvedBase = entryPath.startsWith("slugs/") ? resolvedWorkspaceRoot : resolvedRoot;
    const targetPath = path.resolve(targetBase, entryPath);
    if (targetPath !== resolvedBase && !targetPath.startsWith(`${resolvedBase}${path.sep}`)) {
      throw new Error(`unsafe bundle entry path: ${entryPath}`);
    }
    await ensureDir(path.dirname(targetPath));
    await fs.writeFile(targetPath, Buffer.from(value));
  }

  if (bundledSlugAssets.length) {
    await upsertSlugAssets(bundledSlugAssets);
  }

  let source: Project["source"] = { filename: sourceProject.source.filename };
  const sourcePath = path.join(newProjectRoot, "media", sourceProject.source.filename);
  if (await fileExists(sourcePath)) {
    const stat = await fs.stat(sourcePath);
    source = {
      filename: sourceProject.source.filename,
      sizeBytes: stat.size,
      sha256: await hashFile(sourcePath),
    };
  }

  const now = new Date().toISOString();
  const importedProject = ProjectSchema.parse({
    ...sourceProject,
    id: newProjectId,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    source,
    renderCache: { overlayAssetHash: {} },
  });
  await writeProject(importedProject);
  return importedProject;
}

function summarizeCommands(project: Project, commandTypes: string[]): string {
  if (commandTypes.includes("setSourceSegmentsFromText") || commandTypes.includes("setSourceSegments")) {
    const count = project.edits?.sourceSegments?.length ?? 0;
    return `Agent applied ${count} source segment${count === 1 ? "" : "s"}.`;
  }
  if (commandTypes.length === 1) {
    return `Agent applied ${commandTypes[0]}.`;
  }
  return `Agent applied ${commandTypes.length} commands.`;
}

export const projectsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/",
    routeDoc(["Projects"], "List projects", {
      response: {
        200: {
          type: "object",
          required: ["projects"],
          properties: {
            projects: {
              type: "array",
              items: { type: "object", additionalProperties: true },
            },
          },
        },
      },
    }),
    async () => {
    const projects = await listProjects();
    return {
      projects: projects.map((project) => ({
        id: project.id,
        revision: project.revision,
        name: project.name,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        source: project.source,
        video: project.video,
      })),
    };
  });

  app.post(
    "/",
    routeDoc(["Projects"], "Create a project", {
      body: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          video: { type: "object", additionalProperties: true },
        },
      },
      response: { 201: { type: "object", additionalProperties: true }, ...errorResponses },
    }),
    async (request, reply) => {
    const body = request.body as { name?: string; video?: Partial<VideoInfo> };
    const name = body?.name?.trim();
    if (!name) {
      return reply.code(400).send({ error: "name is required" });
    }

    const project = await createProject(name, body?.video);
    return reply.code(201).send(project);
  });

  app.post(
    "/import-bundle",
    routeDoc(["Projects"], "Import a project bundle", {
      consumes: ["multipart/form-data"],
      response: { 201: { type: "object", additionalProperties: true }, ...errorResponses },
    }),
    async (request, reply) => {
      const data = await request.file();
      if (!data) {
        return reply.code(400).send({ error: "file is required" });
      }

      const chunks: Buffer[] = [];
      for await (const chunk of data.file) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }

      try {
        const project = await importProjectBundleFromZip(Buffer.concat(chunks));
        emitProjectUpdated(project, "bundle-import", {
          actor: "api",
          summary: `Imported project bundle ${project.name}.`,
        });
        return reply.code(201).send(project);
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    }
  );

  app.get(
    "/:id",
    routeDoc(["Projects"], "Get a project", {
      params: projectIdParamsSchema,
      response: { 200: { type: "object", additionalProperties: true }, ...errorResponses },
    }),
    async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await readProject(id);
    if (!project) {
      return reply.code(404).send({ error: "project not found" });
    }
    return project;
  });

  app.get(
    "/:id/bundle",
    routeDoc(["Projects"], "Download a project bundle", {
      params: projectIdParamsSchema,
      querystring: {
        type: "object",
        properties: {
          mode: { type: "string", enum: [...BUNDLE_MODE_VALUES] },
        },
      },
      response: { 200: { type: "string", format: "binary" }, ...errorResponses },
      produces: ["application/zip"],
    }),
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const project = await readProject(id);
      if (!project) {
        return reply.code(404).send({ error: "project not found" });
      }

      const mode = resolveBundleMode((request.query as { mode?: string }).mode);
      const bundle = await buildProjectBundle(project, mode);
      const filename = `${sanitizeArchiveName(project.name)}-${project.id}-${mode}.zip`;
      reply
        .header("Content-Length", bundle.length)
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .type("application/zip");
      return reply.send(bundle);
    }
  );

  app.delete(
    "/:id",
    routeDoc(["Projects"], "Delete a project", {
      params: projectIdParamsSchema,
      response: {
        200: {
          type: "object",
          required: ["ok"],
          properties: { ok: { type: "boolean" } },
        },
        ...errorResponses,
      },
    }),
    async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = await deleteProject(id);
    if (!deleted) {
      return reply.code(404).send({ error: "project not found" });
    }
    emitProjectDeleted(id, "delete");
    return { ok: true };
  });

  app.put(
    "/:id",
    routeDoc(["Projects"], "Replace a project document", {
      params: projectIdParamsSchema,
      body: { type: "object", additionalProperties: true },
      response: { 200: { type: "object", additionalProperties: true }, ...errorResponses },
    }),
    async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Project | undefined;
    if (!body) {
      return reply.code(400).send({ error: "project payload is required" });
    }
    if (body.id && body.id !== id) {
      return reply.code(400).send({ error: "project id mismatch" });
    }

    const current = await readProject(id);
    if (!current) {
      return reply.code(404).send({ error: "project not found" });
    }
    const bodyRevision =
      typeof (request.body as { revision?: unknown })?.revision === "number"
        ? (request.body as { revision: number }).revision
        : undefined;
    if (typeof bodyRevision === "number" && bodyRevision !== current.revision) {
      return reply.code(409).send({
        error: "project revision conflict",
        project: current,
      });
    }

    const now = new Date().toISOString();
    const project = ProjectSchema.parse({
      ...body,
      id,
      revision: (current.revision ?? 1) + 1,
      updatedAt: now,
    });

    await writeProject(project);
    emitProjectUpdated(project, "put", {
      actor: "api",
      summary: "Project document was replaced through the API.",
    });
    return project;
  });

  app.post(
    "/:id/import",
    routeDoc(["Projects"], "Import source video", {
      params: projectIdParamsSchema,
      consumes: ["multipart/form-data"],
      response: { 200: { type: "object", additionalProperties: true }, ...errorResponses },
    }),
    async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await readProject(id);
    if (!project) {
      return reply.code(404).send({ error: "project not found" });
    }

    const data = await request.file();
    if (!data) {
      return reply.code(400).send({ error: "file is required" });
    }

    try {
      const updatedProject = await importSourceVideo(project, {
        stream: data.file,
        filename: data.filename,
      });
      emitProjectUpdated(updatedProject, "import", {
        actor: "api",
        summary: `Imported source video ${updatedProject.source.filename}.`,
      });
      return updatedProject;
    } catch (error) {
      return reply.code(400).send({
        error: "video import failed",
        message: (error as Error).message,
      });
    }
  });

  app.get(
    "/:id/media",
    routeDoc(["Projects"], "Stream project source media", {
      params: projectIdParamsSchema,
      response: { 200: { type: "string", format: "binary" }, ...errorResponses },
      produces: ["video/mp4"],
    }),
    async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await readProject(id);
    if (!project) {
      return reply.code(404).send({ error: "project not found" });
    }

    const videoPath = path.join(WORKSPACE_ROOT, id, "media", project.source.filename);
    if (!(await fileExists(videoPath))) {
      return reply.code(404).send({ error: "media not found" });
    }

    const stat = await fs.stat(videoPath);
    const range = request.headers.range;
    if (range) {
      const rangeValue = range.replace("bytes=", "");
      const firstRange = rangeValue.split(",")[0]?.trim() ?? "";
      const [startRaw, endRaw] = firstRange.split("-");

      let start: number | null = null;
      let end: number | null = null;

      if (!startRaw && endRaw) {
        const suffix = Number(endRaw);
        if (Number.isFinite(suffix) && suffix > 0) {
          start = Math.max(0, stat.size - suffix);
          end = stat.size - 1;
        }
      } else if (startRaw) {
        const parsedStart = Number(startRaw);
        if (Number.isFinite(parsedStart) && parsedStart >= 0) {
          start = parsedStart;
          if (endRaw) {
            const parsedEnd = Number(endRaw);
            if (Number.isFinite(parsedEnd) && parsedEnd >= parsedStart) {
              end = Math.min(parsedEnd, stat.size - 1);
            }
          } else {
            end = stat.size - 1;
          }
        }
      }

      if (start === null || end === null || start >= stat.size) {
        return reply
          .code(416)
          .header("Content-Range", `bytes */${stat.size}`)
          .send();
      }

      const chunkSize = end - start + 1;
      reply
        .code(206)
        .header("Content-Range", `bytes ${start}-${end}/${stat.size}`)
        .header("Accept-Ranges", "bytes")
        .header("Content-Length", chunkSize)
        .type("video/mp4");
      return reply.send(createReadStream(videoPath, { start, end }));
    }

    reply.header("Content-Length", stat.size).type("video/mp4");
    return reply.send(createReadStream(videoPath));
  });

  app.get(
    "/:id/exports/latest",
    routeDoc(["Rendering"], "Download latest final export", {
      params: projectIdParamsSchema,
      response: { 200: { type: "string", format: "binary" }, ...errorResponses },
      produces: ["video/mp4"],
    }),
    async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await readProject(id);
    if (!project) {
      return reply.code(404).send({ error: "project not found" });
    }

    const exportsRoot = path.join(WORKSPACE_ROOT, id, "exports");
    if (!(await fileExists(exportsRoot))) {
      return reply.code(404).send({ error: "no exports found" });
    }

    const entries = await fs.readdir(exportsRoot, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    if (!dirs.length) {
      return reply.code(404).send({ error: "no exports found" });
    }

    const latestExportId = dirs.sort().at(-1);
    if (!latestExportId) {
      return reply.code(404).send({ error: "no exports found" });
    }

    const finalPath = path.join(exportsRoot, latestExportId, "final.mp4");
    if (!(await fileExists(finalPath))) {
      return reply.code(404).send({ error: "final output not found" });
    }

    const stat = await fs.stat(finalPath);
    const range = request.headers.range;
    const safeName = project.name.replace(/[^a-z0-9-_]+/gi, "_");
    const filename = `${safeName || "export"}-${latestExportId}.mp4`;

    const origin = request.headers.origin ?? "*";
    reply.raw.setHeader("Access-Control-Allow-Origin", origin);
    reply.header("Accept-Ranges", "bytes");
    reply.header("Content-Disposition", `attachment; filename="${filename}"`);

    if (range) {
      const rangeValue = range.replace("bytes=", "");
      const firstRange = rangeValue.split(",")[0]?.trim() ?? "";
      const [startRaw, endRaw] = firstRange.split("-");

      let start: number | null = null;
      let end: number | null = null;

      if (!startRaw && endRaw) {
        const suffix = Number(endRaw);
        if (Number.isFinite(suffix) && suffix > 0) {
          start = Math.max(0, stat.size - suffix);
          end = stat.size - 1;
        }
      } else if (startRaw) {
        const parsedStart = Number(startRaw);
        if (Number.isFinite(parsedStart) && parsedStart >= 0) {
          start = parsedStart;
          if (endRaw) {
            const parsedEnd = Number(endRaw);
            if (Number.isFinite(parsedEnd) && parsedEnd >= parsedStart) {
              end = Math.min(parsedEnd, stat.size - 1);
            }
          } else {
            end = stat.size - 1;
          }
        }
      }

      if (start === null || end === null || start >= stat.size) {
        return reply
          .code(416)
          .header("Content-Range", `bytes */${stat.size}`)
          .send();
      }

      const chunkSize = end - start + 1;
      reply
        .code(206)
        .header("Content-Range", `bytes ${start}-${end}/${stat.size}`)
        .header("Content-Length", chunkSize)
        .type("video/mp4");
      return reply.send(createReadStream(finalPath, { start, end }));
    }

    reply.header("Content-Length", stat.size).type("video/mp4");
    return reply.send(createReadStream(finalPath));
  });

  app.get(
    "/:id/thumbnail",
    routeDoc(["Projects"], "Generate or read a frame thumbnail", {
      params: projectIdParamsSchema,
      querystring: {
        type: "object",
        properties: {
          frame: { type: "string" },
          width: { type: "string" },
        },
      },
      response: { 200: { type: "string", format: "binary" }, ...errorResponses },
      produces: ["image/jpeg"],
    }),
    async (request, reply) => {
    const { id } = request.params as { id: string };
    const { frame, width } = request.query as { frame?: string; width?: string };
    const project = await readProject(id);
    if (!project) {
      return reply.code(404).send({ error: "project not found" });
    }
    const frameValue = frame ? Number(frame) : 0;
    const widthValue = width ? Number(width) : 240;
    const targetFrame = Number.isFinite(frameValue) ? Math.max(0, Math.floor(frameValue)) : 0;
    const targetWidth = Number.isFinite(widthValue) ? Math.max(80, Math.floor(widthValue)) : 240;
    try {
      const thumbPath = await ensureThumbnail(project, targetFrame, targetWidth);
      return reply.type("image/jpeg").send(createReadStream(thumbPath));
    } catch (error) {
      request.log.error({ err: error }, "thumbnail generation failed");
      return reply.code(500).send({ error: (error as Error).message });
    }
  });

  app.post(
    "/:id/timeline-assets",
    routeDoc(["Projects"], "Upload a PNG still for source timeline recipes", {
      params: projectIdParamsSchema,
      consumes: ["multipart/form-data"],
      response: {
        200: {
          type: "object",
          required: ["ok", "path", "filename", "sizeBytes", "sha256"],
          properties: {
            ok: { type: "boolean" },
            path: { type: "string" },
            filename: { type: "string" },
            sizeBytes: { type: "number" },
            sha256: { type: "string" },
          },
        },
        ...errorResponses,
      },
    }),
    async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await readProject(id);
    if (!project) {
      return reply.code(404).send({ error: "project not found" });
    }

    const data = await request.file();
    if (!data) {
      return reply.code(400).send({ error: "file is required" });
    }

    const originalName = path.basename(data.filename);
    if (path.extname(originalName).toLowerCase() !== ".png") {
      data.file.resume();
      return reply.code(400).send({ error: "timeline asset must be a png file" });
    }

    const filename = sanitizeTimelineAssetFilename(originalName);
    const projectRoot = path.join(WORKSPACE_ROOT, id);
    const targetDir = path.join(projectRoot, "media", "stills");
    await ensureDir(targetDir);
    const targetPath = path.join(targetDir, filename);
    await pipeline(data.file, createWriteStream(targetPath));

    const stat = await fs.stat(targetPath);
    const sha256 = await hashFile(targetPath);
    return {
      ok: true,
      path: toPosix(path.join("media", "stills", filename)),
      filename,
      sizeBytes: stat.size,
      sha256,
    };
  });

  app.post(
    "/:id/audio-assets",
    routeDoc(["Projects"], "Upload an external audio asset", {
      params: projectIdParamsSchema,
      consumes: ["multipart/form-data"],
      response: { 200: { type: "object", additionalProperties: true }, ...errorResponses },
    }),
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const project = await readProject(id);
      if (!project) {
        return reply.code(404).send({ error: "project not found" });
      }

      const data = await request.file();
      if (!data) {
        return reply.code(400).send({ error: "file is required" });
      }

      try {
        return await persistAudioAsset(id, {
          stream: data.file,
          filename: data.filename,
          contentType: data.mimetype,
          source: "upload",
        });
      } catch (error) {
        return reply.code(400).send({
          error: "audio import failed",
          message: (error as Error).message,
        });
      }
    }
  );

  app.post(
    "/:id/audio-assets/from-url",
    routeDoc(["Projects"], "Import an external audio asset from a URL", {
      params: projectIdParamsSchema,
      body: {
        type: "object",
        required: ["url"],
        properties: { url: { type: "string" } },
      },
      response: { 200: { type: "object", additionalProperties: true }, ...errorResponses },
    }),
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const project = await readProject(id);
      if (!project) {
        return reply.code(404).send({ error: "project not found" });
      }

      const inputUrl = (request.body as { url?: string } | undefined)?.url?.trim();
      if (!inputUrl) {
        return reply.code(400).send({ error: "url is required" });
      }

      try {
        const response = await fetchAudioResponse(inputUrl);
        const contentLength = Number(response.headers.get("content-length") ?? 0);
        if (Number.isFinite(contentLength) && contentLength > UPLOAD_MAX_BYTES) {
          return reply.code(400).send({ error: "audio file is too large" });
        }
        if (!response.body) {
          return reply.code(400).send({ error: "audio URL returned an empty body" });
        }
        const responseUrl = response.url || inputUrl;
        const fallbackName = path.basename(new URL(responseUrl).pathname) || "audio";
        const filename =
          filenameFromContentDisposition(response.headers.get("content-disposition")) ??
          fallbackName;
        const stream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
        return await persistAudioAsset(id, {
          stream,
          filename,
          contentType: response.headers.get("content-type"),
          source: "url",
          originalUrl: inputUrl,
        });
      } catch (error) {
        return reply.code(400).send({
          error: "audio import failed",
          message: (error as Error).message,
        });
      }
    }
  );

  app.post(
    "/:id/assets/:kind/:overlayId",
    routeDoc(["Projects"], "Upload a rendered overlay or arrow asset", {
      params: assetParamsSchema,
      consumes: ["multipart/form-data"],
      response: {
        200: {
          type: "object",
          required: ["ok", "path"],
          properties: { ok: { type: "boolean" }, path: { type: "string" } },
        },
        ...errorResponses,
      },
    }),
    async (request, reply) => {
    const { id, kind, overlayId } = request.params as {
      id: string;
      kind: string;
      overlayId: string;
    };
    const project = await readProject(id);
    if (!project) {
      return reply.code(404).send({ error: "project not found" });
    }
    if (kind !== "overlays" && kind !== "arrows") {
      return reply.code(400).send({ error: "invalid asset kind" });
    }

    const data = await request.file();
    if (!data) {
      return reply.code(400).send({ error: "file is required" });
    }

    const projectRoot = path.join(WORKSPACE_ROOT, id);
    const targetDir = path.join(projectRoot, "render", kind);
    await ensureDir(targetDir);

    const targetPath = path.join(targetDir, `${overlayId}.png`);
    await pipeline(data.file, createWriteStream(targetPath));

    return { ok: true, path: targetPath };
  });

  app.post(
    "/:id/timeline/parse",
    routeDoc(["Automation"], "Preview source timeline shorthand as kept segments", {
      params: projectIdParamsSchema,
      body: { type: "object", additionalProperties: true },
      response: { 200: { type: "object", additionalProperties: true }, ...errorResponses },
    }),
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const project = await readProject(id);
      if (!project) {
        return reply.code(404).send({ error: "project not found" });
      }

      const parsed = SourceTimelineParseRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid timeline parse request",
          message: parsed.error.message,
        });
      }

      return parseSourceTimelineText(parsed.data.text, {
        fps: getVideoFps(project.video),
        totalFrames: getProjectTotalFrames(project),
        createId: randomUUID,
        defaultAudio: parsed.data.defaultAudio,
        fastAudio: parsed.data.fastAudio,
      });
    }
  );

  app.post(
    "/:id/commands",
    routeDoc(["Automation"], "Apply external editor commands atomically", {
      params: projectIdParamsSchema,
      body: { type: "object", additionalProperties: true },
      response: { 200: { type: "object", additionalProperties: true }, ...errorResponses },
    }),
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const project = await readProject(id);
      if (!project) {
        return reply.code(404).send({ error: "project not found" });
      }

      const parsed = CommandBatchRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid command batch",
          message: parsed.error.message,
        });
      }

      if (
        typeof parsed.data.baseRevision === "number" &&
        parsed.data.baseRevision !== project.revision
      ) {
        return reply.code(409).send({
          error: "project revision conflict",
          project,
        });
      }

      try {
        const applied = applyEditorCommands(project, parsed.data.commands, {
          templates: await getEditingTemplates(),
          arrows: getEditingArrows(),
          createId: randomUUID,
        });
        const now = new Date().toISOString();
        const updatedProject = ProjectSchema.parse({
          ...applied.project,
          revision: (project.revision ?? 1) + 1,
          updatedAt: now,
        });
        await writeProject(updatedProject);
        const commandTypes = parsed.data.commands.map((command) => command.type);
        emitProjectUpdated(updatedProject, "commands", {
          actor: parsed.data.actor ?? "agent",
          summary: parsed.data.summary ?? summarizeCommands(updatedProject, commandTypes),
          commands: commandTypes,
        });
        return { project: updatedProject, results: applied.results };
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    }
  );

  app.get(
    "/:id/events",
    routeDoc(["Automation"], "Stream project update events", {
      params: projectIdParamsSchema,
      response: { 200: { type: "string" }, ...errorResponses },
      produces: ["text/event-stream"],
    }),
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const project = await readProject(id);
      if (!project) {
        return reply.code(404).send({ error: "project not found" });
      }

      reply.raw.setHeader("Access-Control-Allow-Origin", request.headers.origin ?? "*");
      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.flushHeaders();
      reply.hijack();

      sendProjectEvent(reply, {
        type: "project-updated",
        projectId: project.id,
        revision: project.revision,
        source: "snapshot",
        at: new Date().toISOString(),
      });

      const unsubscribe = onProjectEvent(id, (event) => sendProjectEvent(reply, event));
      request.raw.on("close", unsubscribe);
    }
  );

  app.post(
    "/:id/export",
    routeDoc(["Rendering"], "Write an export bundle without final render", {
      params: projectIdParamsSchema,
      body: exportOptionsBodySchema,
      response: { 200: { type: "object", additionalProperties: true }, ...errorResponses },
    }),
    async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await readProject(id);
    if (!project) {
      return reply.code(404).send({ error: "project not found" });
    }

    const body = request.body as {
      presetId?: string;
      includeAudio?: boolean;
      includeSlug?: boolean;
      includeSlugStart?: boolean;
      includeSlugEnd?: boolean;
      speed?: 1 | 2;
      renderMode?: "final" | "rough";
    };
    let result: Awaited<ReturnType<typeof writeExportBundle>>;
    try {
      result = await writeExportBundle(project, body ?? {});
    } catch (error) {
      return sendRenderError(reply, error);
    }

    const now = new Date().toISOString();
    const hasAudio = Boolean(project.video.audio?.hasAudio);
    const includeAudio =
      (typeof body?.includeAudio === "boolean"
        ? body.includeAudio
        : project.exportOptions?.includeAudio ?? true) && hasAudio;
    const includeSlug =
      typeof body?.includeSlug === "boolean" ? body.includeSlug : project.exportOptions?.includeSlug;
    const includeSlugStart =
      typeof body?.includeSlugStart === "boolean"
        ? body.includeSlugStart
        : includeSlug ?? project.exportOptions?.includeSlugStart ?? false;
    const includeSlugEnd =
      typeof body?.includeSlugEnd === "boolean"
        ? body.includeSlugEnd
        : includeSlug ?? project.exportOptions?.includeSlugEnd ?? false;
    const updatedProject = ProjectSchema.parse({
      ...project,
      revision: (project.revision ?? 1) + 1,
      updatedAt: now,
      lastExportPresetId: body?.presetId ?? project.lastExportPresetId,
      exportOptions: body
        ? {
            speed: body.speed ?? project.exportOptions?.speed ?? 1,
            includeAudio,
            includeSlug: includeSlugStart && includeSlugEnd,
            includeSlugStart,
            includeSlugEnd,
          }
        : project.exportOptions,
    });

    await writeProject(updatedProject);
    emitProjectUpdated(updatedProject, "export", {
      actor: "api",
      summary: "Export bundle was written.",
    });

    return {
      exportId: result.exportId,
      exportDir: result.exportDir,
      manifest: result.manifest,
    };
  });

  app.post(
    "/:id/render",
    routeDoc(["Rendering"], "Render a final MP4", {
      params: projectIdParamsSchema,
      body: exportOptionsBodySchema,
      response: { 200: { type: "object", additionalProperties: true }, ...errorResponses },
    }),
    async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await readProject(id);
    if (!project) {
      return reply.code(404).send({ error: "project not found" });
    }

    const body = request.body as {
      presetId?: string;
      includeAudio?: boolean;
      includeSlug?: boolean;
      includeSlugStart?: boolean;
      includeSlugEnd?: boolean;
      speed?: 1 | 2;
      renderMode?: "final" | "rough";
    };
    try {
      const result = await renderFinal(project, body ?? {});
      const now = new Date().toISOString();
      const hasAudio = Boolean(project.video.audio?.hasAudio);
      const includeAudio =
        (typeof body?.includeAudio === "boolean"
          ? body.includeAudio
          : project.exportOptions?.includeAudio ?? true) && hasAudio;
      const includeSlug =
        typeof body?.includeSlug === "boolean" ? body.includeSlug : project.exportOptions?.includeSlug;
      const includeSlugStart =
        typeof body?.includeSlugStart === "boolean"
          ? body.includeSlugStart
          : includeSlug ?? project.exportOptions?.includeSlugStart ?? false;
      const includeSlugEnd =
        typeof body?.includeSlugEnd === "boolean"
          ? body.includeSlugEnd
          : includeSlug ?? project.exportOptions?.includeSlugEnd ?? false;
      const updatedProject = ProjectSchema.parse({
        ...project,
        revision: (project.revision ?? 1) + 1,
        updatedAt: now,
        lastExportPresetId: body?.presetId ?? project.lastExportPresetId,
        exportOptions: body
          ? {
              speed: body.speed ?? project.exportOptions?.speed ?? 1,
              includeAudio,
              includeSlug: includeSlugStart && includeSlugEnd,
              includeSlugStart,
              includeSlugEnd,
            }
          : project.exportOptions,
      });
      await writeProject(updatedProject);
      emitProjectUpdated(updatedProject, "render", {
        actor: "api",
        summary: "Final render completed.",
      });

      return {
        exportId: result.exportId,
        exportDir: result.exportDir,
        finalPath: result.finalPath,
        manifest: result.manifest,
      };
    } catch (error) {
      return sendRenderError(reply, error);
    }
  });

  app.get(
    "/:id/patch/status",
    routeDoc(["Rendering"], "Report whether latest final export can be surgically patched", {
      params: projectIdParamsSchema,
      querystring: {
        type: "object",
        properties: {
          presetId: { type: "string" },
          includeAudio: { type: "string" },
          includeSlug: { type: "string" },
          includeSlugStart: { type: "string" },
          includeSlugEnd: { type: "string" },
          speed: { type: "string" },
          renderMode: { type: "string", enum: ["final", "rough"] },
        },
      },
      response: { 200: { type: "object", additionalProperties: true }, ...errorResponses },
    }),
    async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as RenderOptionsQuery;
    const project = await readProject(id);
    if (!project) {
      return reply.code(404).send({ error: "project not found" });
    }

    return getSurgicalPatchStatus(project, parseRenderOptionsQuery(query));
  });

  app.get(
    "/:id/patch/stream",
    routeDoc(["Rendering"], "Stream surgical patch render progress with SSE", {
      params: projectIdParamsSchema,
      querystring: {
        type: "object",
        properties: {
          presetId: { type: "string" },
          includeAudio: { type: "string" },
          includeSlug: { type: "string" },
          includeSlugStart: { type: "string" },
          includeSlugEnd: { type: "string" },
          speed: { type: "string" },
          renderMode: { type: "string", enum: ["final", "rough"] },
        },
      },
      response: { 200: { type: "string" }, ...errorResponses },
      produces: ["text/event-stream"],
    }),
    async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as RenderOptionsQuery;
    const project = await readProject(id);
    if (!project) {
      return reply.code(404).send({ error: "project not found" });
    }

    const options = parseRenderOptionsQuery(query);
    const origin = request.headers.origin ?? "*";
    reply.raw.setHeader("Access-Control-Allow-Origin", origin);
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.flushHeaders();
    reply.hijack();

    const send = (event: string, data: RenderProgress | { message: string }) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send("status", { message: "Patch render started" });

    try {
      const result = await renderSurgicalPatch(project, options, (update) => {
        send("progress", update);
      });
      send("done", { message: result.finalPath });
    } catch (error) {
      send("error", { message: (error as Error).message });
    } finally {
      reply.raw.end();
    }
  });

  app.get(
    "/:id/render/stream",
    routeDoc(["Rendering"], "Stream final render progress with SSE", {
      params: projectIdParamsSchema,
      querystring: {
        type: "object",
        properties: {
          presetId: { type: "string" },
          includeAudio: { type: "string" },
          includeSlug: { type: "string" },
          includeSlugStart: { type: "string" },
          includeSlugEnd: { type: "string" },
          speed: { type: "string" },
          renderMode: { type: "string", enum: ["final", "rough"] },
        },
      },
      response: { 200: { type: "string" }, ...errorResponses },
      produces: ["text/event-stream"],
    }),
    async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as {
      presetId?: string;
      includeAudio?: string;
      includeSlug?: string;
      includeSlugStart?: string;
      includeSlugEnd?: string;
      speed?: string;
      renderMode?: string;
    };
    const project = await readProject(id);
    if (!project) {
      return reply.code(404).send({ error: "project not found" });
    }

    const includeAudio =
      typeof query.includeAudio === "string" ? query.includeAudio === "true" : undefined;
    const includeSlug = query.includeSlug === "true";
    const includeSlugStart =
      query.includeSlugStart === "true" || (includeSlug && query.includeSlugStart == null);
    const includeSlugEnd =
      query.includeSlugEnd === "true" || (includeSlug && query.includeSlugEnd == null);

    const options = {
      presetId: query.presetId,
      includeAudio,
      includeSlug,
      includeSlugStart,
      includeSlugEnd,
      speed: query.speed ? (Number(query.speed) as 1 | 2) : undefined,
      renderMode: query.renderMode === "rough" ? ("rough" as const) : undefined,
    };

    const origin = request.headers.origin ?? "*";
    reply.raw.setHeader("Access-Control-Allow-Origin", origin);
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.flushHeaders();
    reply.hijack();

    const send = (event: string, data: RenderProgress | { message: string }) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send("status", { message: "Render started" });

    try {
      const result = await renderFinal(project, options, (update) => {
        send("progress", update);
      });
      send("done", { message: result.finalPath });
    } catch (error) {
      send("error", { message: (error as Error).message });
    } finally {
      reply.raw.end();
    }
  });
};
