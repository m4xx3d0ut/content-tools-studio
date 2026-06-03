import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { UPLOAD_MAX_BYTES } from "./config.js";
import { openApiDocument, openApiSchemas, routeDoc } from "./openapi.js";
import { projectsRoutes } from "./routes/projects.js";
import { rawformRoutes } from "./routes/rawform.js";
import { slugsRoutes } from "./routes/slugs.js";
import { templatesRoutes } from "./routes/templates.js";
import { ensureSlugLibrary } from "./services/slugs.js";
import { ensureWorkspaceRoot } from "./services/workspace.js";
import { getRenderCapabilities } from "./services/render-capabilities.js";

export async function buildApp() {
  const app = Fastify({ logger: true });

  await ensureWorkspaceRoot();
  await ensureSlugLibrary();

  await app.register(swagger, {
    openapi: {
      info: {
        title: "C&M Content Tools API",
        description: "Local-first project editing, automation, and rendering API.",
        version: "1.0.0",
      },
      tags: [
        { name: "System", description: "Health and discovery endpoints" },
        { name: "Templates", description: "Card and arrow template assets" },
        { name: "Slugs", description: "Reusable intro/outro slug videos" },
        { name: "Projects", description: "Project CRUD, media, and assets" },
        { name: "Automation", description: "External editing commands and project events" },
        { name: "Rendering", description: "Export bundle and final render endpoints" },
      ],
      components: {
        schemas: openApiSchemas as unknown as Record<string, never>,
      },
    },
  });

  await app.register(cors, { origin: true });
  await app.register(multipart, {
    limits: {
      fileSize: UPLOAD_MAX_BYTES,
      files: 1,
    },
    throwFileSizeLimit: true,
  });

  app.get(
    "/health",
    routeDoc(["System"], "Health check", {
      response: {
        200: {
          type: "object",
          required: ["ok", "at"],
          properties: { ok: { type: "boolean" }, at: { type: "string" } },
        },
      },
    }),
    async () => ({ ok: true, at: new Date().toISOString() })
  );

  app.get(
    "/render/capabilities",
    routeDoc(["Rendering"], "Report render preset and hardware encoder availability", {
      querystring: {
        type: "object",
        properties: {
          refresh: { type: "string" },
        },
      },
      response: { 200: { type: "object", additionalProperties: true } },
    }),
    async (request) => {
      const query = request.query as { refresh?: string };
      const refresh = query.refresh === "true" || query.refresh === "1";
      return getRenderCapabilities({ refresh });
    }
  );

  await app.register(projectsRoutes, { prefix: "/projects" });
  await app.register(rawformRoutes, { prefix: "/rawform" });
  await app.register(slugsRoutes, { prefix: "/slugs" });
  await app.register(templatesRoutes, { prefix: "/templates" });

  app.get(
    "/automation/capabilities",
    routeDoc(["Automation"], "Describe supported automation commands", {
      response: { 200: { type: "object", additionalProperties: true } },
    }),
    async () => ({
      apiVersion: "content-tools.automation/v1",
      schemaVersion: 1,
      projectRevisioning: "optimistic",
      coordinates: "source-video-pixels",
      frameSemantics: {
        overlays: "endFrame-inclusive",
        cuts: "endFrame-inclusive",
        trim: "endFrameExclusive",
        sourceSegments: "endFrameExclusive",
      },
      commands: [
        "addCard",
        "addArrow",
        "updateOverlay",
        "removeOverlay",
        "reorderOverlays",
        "setTrim",
        "addCut",
        "updateCut",
        "removeCut",
        "setSourceSegments",
        "addSourceSegment",
        "updateSourceSegment",
        "removeSourceSegment",
        "reorderSourceSegments",
        "setSourceSegmentsFromText",
        "setSlug",
        "setExportOptions",
        "setAudioTrack",
      ],
      slugLibrary: {
        list: "GET /slugs",
        import: "POST /slugs",
        media: "GET /slugs/:id/media",
        delete: "DELETE /slugs/:id",
      },
    })
  );

  app.get(
    "/openapi.json",
    { schema: { hide: true } },
    async () => openApiDocument(app)
  );

  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
    },
  });

  return app;
}
