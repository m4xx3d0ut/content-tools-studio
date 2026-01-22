import type { FastifyPluginAsync } from "fastify";
import type { Project, VideoInfo } from "@content-tools/shared";
import { ProjectSchema } from "@content-tools/shared";
import path from "node:path";
import { promises as fs, createWriteStream, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import {
  createProject,
  deleteProject,
  listProjects,
  readProject,
  writeProject,
} from "../services/workspace.js";
import { probeVideo } from "../services/ffprobe.js";
import { renderFinal, writeExportBundle, type RenderProgress } from "../services/exporter.js";
import { WORKSPACE_ROOT } from "../config.js";
import { ensureDir, fileExists } from "../utils/fs.js";
import { ensureThumbnail } from "../services/thumbnails.js";

export const projectsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", async () => {
    const projects = await listProjects();
    return {
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        source: project.source,
        video: project.video,
      })),
    };
  });

  app.post("/", async (request, reply) => {
    const body = request.body as { name?: string; video?: Partial<VideoInfo> };
    const name = body?.name?.trim();
    if (!name) {
      return reply.code(400).send({ error: "name is required" });
    }

    const project = await createProject(name, body?.video);
    return reply.code(201).send(project);
  });

  app.get("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await readProject(id);
    if (!project) {
      return reply.code(404).send({ error: "project not found" });
    }
    return project;
  });

  app.delete("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = await deleteProject(id);
    if (!deleted) {
      return reply.code(404).send({ error: "project not found" });
    }
    return { ok: true };
  });

  app.put("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Project | undefined;
    if (!body) {
      return reply.code(400).send({ error: "project payload is required" });
    }
    if (body.id && body.id !== id) {
      return reply.code(400).send({ error: "project id mismatch" });
    }

    const now = new Date().toISOString();
    const project = ProjectSchema.parse({
      ...body,
      id,
      updatedAt: now,
    });

    await writeProject(project);
    return project;
  });

  app.post("/:id/import", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await readProject(id);
    if (!project) {
      return reply.code(404).send({ error: "project not found" });
    }

    const data = await request.file();
    if (!data) {
      return reply.code(400).send({ error: "file is required" });
    }

    const filename = path.basename(data.filename);
    const projectRoot = path.join(WORKSPACE_ROOT, id);
    const mediaDir = path.join(projectRoot, "media");
    await ensureDir(mediaDir);

    const targetPath = path.join(mediaDir, filename);
    const hash = createHash("sha256");
    let bytes = 0;
    data.file.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      hash.update(chunk);
    });

    await pipeline(data.file, createWriteStream(targetPath));

    let video;
    try {
      video = await probeVideo(targetPath);
    } catch (error) {
      await fs.unlink(targetPath).catch(() => undefined);
      return reply.code(400).send({
        error: "video probe failed",
        message: (error as Error).message,
      });
    }
    const now = new Date().toISOString();
    const updatedProject = ProjectSchema.parse({
      ...project,
      updatedAt: now,
      source: {
        filename,
        sizeBytes: bytes,
        sha256: hash.digest("hex"),
      },
      video,
    });

    await writeProject(updatedProject);
    return updatedProject;
  });

  app.get("/:id/media", async (request, reply) => {
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

  app.get("/:id/thumbnail", async (request, reply) => {
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

  app.post("/:id/assets/:kind/:overlayId", async (request, reply) => {
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

  app.post("/:id/export", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await readProject(id);
    if (!project) {
      return reply.code(404).send({ error: "project not found" });
    }

    const body = request.body as {
      presetId?: string;
      includeSlug?: boolean;
      includeSlugStart?: boolean;
      includeSlugEnd?: boolean;
      speed?: 1 | 2;
    };
    const result = await writeExportBundle(project, body ?? {});

    const now = new Date().toISOString();
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
      updatedAt: now,
      lastExportPresetId: body?.presetId ?? project.lastExportPresetId,
      exportOptions: body
        ? {
            speed: body.speed ?? project.exportOptions?.speed ?? 1,
            includeSlug: includeSlugStart && includeSlugEnd,
            includeSlugStart,
            includeSlugEnd,
          }
        : project.exportOptions,
    });

    await writeProject(updatedProject);

    return {
      exportId: result.exportId,
      exportDir: result.exportDir,
      manifest: result.manifest,
    };
  });

  app.post("/:id/render", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await readProject(id);
    if (!project) {
      return reply.code(404).send({ error: "project not found" });
    }

    const body = request.body as {
      presetId?: string;
      includeSlug?: boolean;
      includeSlugStart?: boolean;
      includeSlugEnd?: boolean;
      speed?: 1 | 2;
    };
    try {
      const result = await renderFinal(project, body ?? {});
      const now = new Date().toISOString();
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
        updatedAt: now,
        lastExportPresetId: body?.presetId ?? project.lastExportPresetId,
        exportOptions: body
          ? {
              speed: body.speed ?? project.exportOptions?.speed ?? 1,
              includeSlug: includeSlugStart && includeSlugEnd,
              includeSlugStart,
              includeSlugEnd,
            }
          : project.exportOptions,
      });
      await writeProject(updatedProject);

      return {
        exportId: result.exportId,
        exportDir: result.exportDir,
        finalPath: result.finalPath,
        manifest: result.manifest,
      };
    } catch (error) {
      return reply.code(500).send({ error: (error as Error).message });
    }
  });

  app.get("/:id/render/stream", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as {
      presetId?: string;
      includeSlug?: string;
      includeSlugStart?: string;
      includeSlugEnd?: string;
      speed?: string;
    };
    const project = await readProject(id);
    if (!project) {
      return reply.code(404).send({ error: "project not found" });
    }

    const includeSlug = query.includeSlug === "true";
    const includeSlugStart =
      query.includeSlugStart === "true" || (includeSlug && query.includeSlugStart == null);
    const includeSlugEnd =
      query.includeSlugEnd === "true" || (includeSlug && query.includeSlugEnd == null);

    const options = {
      presetId: query.presetId,
      includeSlug,
      includeSlugStart,
      includeSlugEnd,
      speed: query.speed ? (Number(query.speed) as 1 | 2) : undefined,
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
