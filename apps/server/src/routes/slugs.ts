import type { FastifyPluginAsync } from "fastify";
import { createReadStream } from "node:fs";
import { promises as fs, createWriteStream } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import {
  deleteSlugAsset,
  getSlugAsset,
  importSlugAsset,
  listSlugAssets,
  slugAssetFilePath,
} from "../services/slugs.js";
import { listProjects } from "../services/workspace.js";
import { ensureDir, fileExists } from "../utils/fs.js";
import { errorResponses, routeDoc } from "../openapi.js";
import { WORKSPACE_ROOT } from "../config.js";

const SLUG_UPLOAD_TMP = path.join(WORKSPACE_ROOT, "slugs", "tmp");

async function slugUsage(assetPath: string): Promise<Array<{ id: string; name: string }>> {
  const projects = await listProjects();
  return projects
    .filter((project) => project.slug?.introPath === assetPath || project.slug?.outroPath === assetPath)
    .map((project) => ({ id: project.id, name: project.name }));
}

export const slugsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "",
    routeDoc(["Slugs"], "List slug videos", {
      response: {
        200: {
          type: "object",
          required: ["slugs"],
          properties: {
            slugs: {
              type: "array",
              items: { type: "object", additionalProperties: true },
            },
          },
        },
      },
    }),
    async () => {
      const assets = await listSlugAssets();
      const slugs = await Promise.all(
        assets.map(async (asset) => ({
          ...asset,
          usageCount: (await slugUsage(asset.path)).length,
        }))
      );
      return { slugs };
    }
  );

  app.post(
    "",
    routeDoc(["Slugs"], "Import a slug video", {
      consumes: ["multipart/form-data"],
      response: { 201: { type: "object", additionalProperties: true }, ...errorResponses },
    }),
    async (request, reply) => {
      const data = await request.file();
      if (!data) {
        return reply.code(400).send({ error: "file is required" });
      }

      const filename = path.basename(data.filename);
      if (path.extname(filename).toLowerCase() !== ".mp4") {
        data.file.resume();
        return reply.code(400).send({ error: "slug video must be an mp4 file" });
      }

      await ensureDir(SLUG_UPLOAD_TMP);
      const tempPath = path.join(SLUG_UPLOAD_TMP, `${randomUUID()}-${filename}`);
      try {
        await pipeline(data.file, createWriteStream(tempPath));
        const asset = await importSlugAsset(tempPath, filename);
        return reply.code(201).send(asset);
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      } finally {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
      }
    }
  );

  app.get(
    "/:id/media",
    routeDoc(["Slugs"], "Stream a slug video", {
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
      response: { 200: { type: "string", format: "binary" }, ...errorResponses },
      produces: ["video/mp4"],
    }),
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const asset = await getSlugAsset(id);
      if (!asset) {
        return reply.code(404).send({ error: "slug not found" });
      }
      const filePath = slugAssetFilePath(asset);
      if (!(await fileExists(filePath))) {
        return reply.code(404).send({ error: "slug media not found" });
      }
      const stat = await fs.stat(filePath);
      reply.header("Content-Length", stat.size).type("video/mp4");
      return reply.send(createReadStream(filePath));
    }
  );

  app.delete(
    "/:id",
    routeDoc(["Slugs"], "Delete an unused slug video", {
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
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
      const asset = await getSlugAsset(id);
      if (!asset) {
        return reply.code(404).send({ error: "slug not found" });
      }
      const projects = await slugUsage(asset.path);
      if (projects.length) {
        return reply.code(409).send({
          error: "slug is used by projects",
          projects,
        });
      }
      await deleteSlugAsset(id);
      return { ok: true };
    }
  );
};
