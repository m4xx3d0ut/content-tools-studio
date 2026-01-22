import type { FastifyPluginAsync } from "fastify";
import { createReadStream } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config.js";
import { getTemplateCrop } from "../services/template-assets.js";
import { getTemplateById, listTemplates } from "../services/templates.js";

const ARROW_ROOT = path.join(REPO_ROOT, "k1s-directional-arrows");
const ARROW_FILE = "arrow-right-128x128.png";

export const templatesRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", async () => {
    const templates = await Promise.all(
      listTemplates().map(async (template) => {
        const crop = await getTemplateCrop(template.filePath);
        return {
          id: template.id,
          label: template.label,
          imagePath: `/templates/cards/${template.id}`,
          bounds: crop.bounds,
          sourceWidth: crop.sourceWidth,
          sourceHeight: crop.sourceHeight,
          align: template.align,
          title: template.title,
          subtitle: template.subtitle ?? null,
        };
      })
    );

    return {
      templates,
      arrows: [
        {
          id: "arrow-right",
          label: "Arrow Right",
          imagePath: `/templates/arrows/${ARROW_FILE}`,
          sourceWidth: 128,
          sourceHeight: 128,
        },
      ],
    };
  });

  app.get("/cards/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const template = getTemplateById(id);
    if (!template) {
      return reply.code(404).send({ error: "template not found" });
    }
    return reply.type("image/png").send(createReadStream(template.filePath));
  });

  app.get("/arrows/:filename", async (request, reply) => {
    const { filename } = request.params as { filename: string };
    if (filename !== ARROW_FILE) {
      return reply.code(404).send({ error: "arrow asset not found" });
    }
    const arrowPath = path.join(ARROW_ROOT, ARROW_FILE);
    return reply.type("image/png").send(createReadStream(arrowPath));
  });

  app.get("/cards", async (_request, reply) => {
    return reply.code(400).send({ error: "card template id is required" });
  });

  app.get("/arrows", async (_request, reply) => {
    return reply.code(400).send({ error: "arrow asset filename is required" });
  });
};
