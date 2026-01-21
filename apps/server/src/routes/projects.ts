import type { FastifyPluginAsync } from "fastify";
import type { Project, VideoInfo } from "@content-tools/shared";
import { ProjectSchema } from "@content-tools/shared";
import path from "node:path";
import { promises as fs, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import {
  createProject,
  listProjects,
  readProject,
  writeProject,
} from "../services/workspace.js";
import { probeVideo } from "../services/ffprobe.js";
import { writeExportBundle } from "../services/exporter.js";
import { WORKSPACE_ROOT } from "../config.js";
import { ensureDir } from "../utils/fs.js";

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

    const video = await probeVideo(targetPath);
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
};
