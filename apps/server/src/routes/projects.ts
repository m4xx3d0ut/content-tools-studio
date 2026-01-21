import type { FastifyPluginAsync } from "fastify";
import type { Project, VideoInfo } from "@content-tools/shared";
import { ProjectSchema } from "@content-tools/shared";
import {
  createProject,
  listProjects,
  readProject,
  writeProject,
} from "../services/workspace.js";

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
};
