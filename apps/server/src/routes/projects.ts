import type { FastifyPluginAsync } from "fastify";
import type { Project, VideoInfo } from "@content-tools/shared";
import { ProjectSchema } from "@content-tools/shared";
import path from "node:path";
import { promises as fs, createWriteStream, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import {
  createProject,
  listProjects,
  readProject,
  writeProject,
} from "../services/workspace.js";
import { probeVideo } from "../services/ffprobe.js";
import { renderFinal, writeExportBundle } from "../services/exporter.js";
import { WORKSPACE_ROOT } from "../config.js";
import { ensureDir, fileExists } from "../utils/fs.js";

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
      const match = range.match(/bytes=(\\d+)-(\\d+)?/);
      if (!match) {
        return reply.code(416).send();
      }
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : stat.size - 1;
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

    const body = request.body as { presetId?: string; includeSlug?: boolean; speed?: 1 | 2 };
    const result = await writeExportBundle(project, body ?? {});

    const now = new Date().toISOString();
    const updatedProject = ProjectSchema.parse({
      ...project,
      updatedAt: now,
      lastExportPresetId: body?.presetId ?? project.lastExportPresetId,
      exportOptions: body
        ? {
            speed: body.speed ?? project.exportOptions?.speed ?? 1,
            includeSlug: body.includeSlug ?? project.exportOptions?.includeSlug ?? false,
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

    const body = request.body as { presetId?: string; includeSlug?: boolean; speed?: 1 | 2 };
    try {
      const result = await renderFinal(project, body ?? {});
      const now = new Date().toISOString();
      const updatedProject = ProjectSchema.parse({
        ...project,
        updatedAt: now,
        lastExportPresetId: body?.presetId ?? project.lastExportPresetId,
        exportOptions: body
          ? {
              speed: body.speed ?? project.exportOptions?.speed ?? 1,
              includeSlug: body.includeSlug ?? project.exportOptions?.includeSlug ?? false,
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
};
