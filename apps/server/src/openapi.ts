import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  AutomationCapabilitiesSchema,
  CommandBatchRequestSchema,
  CommandBatchResponseSchema,
  EditorCommandSchema,
  OverlaySchema,
  ProjectSchema,
  SourceSegmentSchema,
  SourceTimelineParseRequestSchema,
  SourceTimelineParseResponseSchema,
  SlugAssetSchema,
  SlugListResponseSchema,
  VideoSchema,
} from "@content-tools/shared";
import type { ZodTypeAny } from "zod";

function componentFromZod(name: string, schema: ZodTypeAny): unknown {
  const converted = zodToJsonSchema(schema, {
    name,
    target: "openApi3",
    $refStrategy: "none",
  }) as { definitions?: Record<string, unknown> };
  return converted.definitions?.[name] ?? converted;
}

export const openApiSchemas = {
  Project: componentFromZod("Project", ProjectSchema),
  Overlay: componentFromZod("Overlay", OverlaySchema),
  VideoInfo: componentFromZod("VideoInfo", VideoSchema),
  EditorCommand: componentFromZod("EditorCommand", EditorCommandSchema),
  SourceSegment: componentFromZod("SourceSegment", SourceSegmentSchema),
  SlugAsset: componentFromZod("SlugAsset", SlugAssetSchema),
  SlugListResponse: componentFromZod("SlugListResponse", SlugListResponseSchema),
  SourceTimelineParseRequest: componentFromZod(
    "SourceTimelineParseRequest",
    SourceTimelineParseRequestSchema
  ),
  SourceTimelineParseResponse: componentFromZod(
    "SourceTimelineParseResponse",
    SourceTimelineParseResponseSchema
  ),
  CommandBatchRequest: componentFromZod("CommandBatchRequest", CommandBatchRequestSchema),
  CommandBatchResponse: componentFromZod("CommandBatchResponse", CommandBatchResponseSchema),
  AutomationCapabilities: componentFromZod(
    "AutomationCapabilities",
    AutomationCapabilitiesSchema
  ),
  ExportOptions: {
    type: "object",
    properties: {
      presetId: { type: "string" },
      includeAudio: { type: "boolean" },
      includeSlug: { type: "boolean" },
      includeSlugStart: { type: "boolean" },
      includeSlugEnd: { type: "boolean" },
      speed: { type: "integer", enum: [1, 2] },
      renderMode: { type: "string", enum: ["final", "rough"] },
    },
  },
  ProjectBundleMode: {
    type: "string",
    enum: ["project", "project-media", "full"],
  },
  ProjectBundleImport: {
    type: "object",
    required: ["file"],
    properties: {
      file: { type: "string", format: "binary" },
    },
  },
  SlugImport: {
    type: "object",
    required: ["file"],
    properties: {
      file: { type: "string", format: "binary" },
    },
  },
  AudioAssetImport: {
    type: "object",
    required: ["file"],
    properties: {
      file: { type: "string", format: "binary" },
    },
  },
  AudioAssetFromUrl: {
    type: "object",
    required: ["url"],
    properties: {
      url: { type: "string", format: "uri" },
    },
  },
  AudioAssetResponse: {
    type: "object",
    required: ["ok", "path", "filename", "sizeBytes", "sha256", "audio", "source"],
    properties: {
      ok: { type: "boolean" },
      path: { type: "string" },
      filename: { type: "string" },
      sizeBytes: { type: "number" },
      sha256: { type: "string" },
      source: { type: "string", enum: ["upload", "url"] },
      originalUrl: { type: "string" },
      audio: {
        type: "object",
        properties: {
          durationMs: { type: "number" },
          sampleRate: { type: "number" },
          channels: { type: "number" },
          codecName: { type: "string" },
        },
      },
    },
  },
  TimelineAssetImport: {
    type: "object",
    required: ["file"],
    properties: {
      file: { type: "string", format: "binary" },
    },
  },
  TemplateInfo: {
    type: "object",
    required: ["id", "label", "imagePath", "bounds", "sourceWidth", "sourceHeight", "align"],
    properties: {
      id: { type: "string" },
      label: { type: "string" },
      imagePath: { type: "string" },
      bounds: {
        type: "object",
        required: ["left", "top", "width", "height"],
        properties: {
          left: { type: "number" },
          top: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
        },
      },
      sourceWidth: { type: "number" },
      sourceHeight: { type: "number" },
      align: { type: "string", enum: ["left", "center", "right"] },
      title: { type: "object", additionalProperties: true },
      subtitle: { type: "object", nullable: true, additionalProperties: true },
    },
  },
  ErrorResponse: {
    type: "object",
    required: ["error"],
    properties: {
      error: { type: "string" },
      message: { type: "string" },
    },
    additionalProperties: true,
  },
};

export const projectIdParamsSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string" } },
};

export const assetParamsSchema = {
  type: "object",
  required: ["id", "kind", "overlayId"],
  properties: {
    id: { type: "string" },
    kind: { type: "string", enum: ["overlays", "arrows"] },
    overlayId: { type: "string" },
  },
};

export const exportOptionsBodySchema = {
  type: "object",
  properties: (openApiSchemas.ExportOptions as { properties: unknown }).properties,
};

export const errorResponses = {
  400: { description: "Bad request", type: "object", additionalProperties: true },
  404: { description: "Not found", type: "object", additionalProperties: true },
  409: { description: "Conflict", type: "object", additionalProperties: true },
  500: { description: "Server error", type: "object", additionalProperties: true },
};

export function routeDoc(
  tags: string[],
  summary: string,
  extra: RouteShorthandOptions["schema"] = {}
): RouteShorthandOptions {
  return {
    schema: {
      tags,
      summary,
      ...extra,
    },
  };
}

function patchPathContent(
  document: Record<string, unknown>,
  path: string,
  method: string,
  status: string,
  contentType: string,
  schema: unknown
) {
  const paths = document.paths as Record<string, Record<string, { responses?: Record<string, unknown> }>>;
  const operation = paths?.[path]?.[method];
  const responses = operation?.responses as Record<string, Record<string, unknown>> | undefined;
  if (!responses?.[status]) return;
  responses[status].content = {
    [contentType]: { schema },
  };
}

function patchJsonRequestBody(
  document: Record<string, unknown>,
  path: string,
  method: string,
  schema: unknown
) {
  const paths = document.paths as Record<string, Record<string, Record<string, unknown>>>;
  const operation = paths?.[path]?.[method];
  if (!operation) return;
  operation.requestBody = {
    required: true,
    content: {
      "application/json": { schema },
    },
  };
}

function patchMultipartRequestBody(
  document: Record<string, unknown>,
  path: string,
  method: string,
  schema: unknown
) {
  const paths = document.paths as Record<string, Record<string, Record<string, unknown>>>;
  const operation = paths?.[path]?.[method];
  if (!operation) return;
  operation.requestBody = {
    required: true,
    content: {
      "multipart/form-data": { schema },
    },
  };
}

function patchJsonResponse(
  document: Record<string, unknown>,
  path: string,
  method: string,
  status: string,
  schema: unknown
) {
  patchPathContent(document, path, method, status, "application/json", schema);
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

export function openApiDocument(app: FastifyInstance): Record<string, unknown> {
  const document = app.swagger() as Record<string, unknown>;
  patchJsonRequestBody(document, "/projects", "post", {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string" },
      video: { $ref: "#/components/schemas/VideoInfo" },
    },
  });
  patchJsonResponse(document, "/projects", "post", "201", ref("Project"));
  patchMultipartRequestBody(document, "/projects/import-bundle", "post", ref("ProjectBundleImport"));
  patchJsonResponse(document, "/projects/import-bundle", "post", "201", ref("Project"));
  patchJsonResponse(document, "/projects/{id}", "get", "200", ref("Project"));
  patchJsonRequestBody(document, "/projects/{id}", "put", ref("Project"));
  patchJsonResponse(document, "/projects/{id}", "put", "200", ref("Project"));
  patchJsonResponse(document, "/projects/{id}/import", "post", "200", ref("Project"));
  patchMultipartRequestBody(
    document,
    "/projects/{id}/timeline-assets",
    "post",
    ref("TimelineAssetImport")
  );
  patchMultipartRequestBody(
    document,
    "/projects/{id}/audio-assets",
    "post",
    ref("AudioAssetImport")
  );
  patchJsonResponse(document, "/projects/{id}/audio-assets", "post", "200", ref("AudioAssetResponse"));
  patchJsonRequestBody(
    document,
    "/projects/{id}/audio-assets/from-url",
    "post",
    ref("AudioAssetFromUrl")
  );
  patchJsonResponse(
    document,
    "/projects/{id}/audio-assets/from-url",
    "post",
    "200",
    ref("AudioAssetResponse")
  );
  patchJsonRequestBody(document, "/projects/{id}/commands", "post", ref("CommandBatchRequest"));
  patchJsonResponse(document, "/projects/{id}/commands", "post", "200", ref("CommandBatchResponse"));
  patchJsonRequestBody(
    document,
    "/projects/{id}/timeline/parse",
    "post",
    ref("SourceTimelineParseRequest")
  );
  patchJsonResponse(
    document,
    "/projects/{id}/timeline/parse",
    "post",
    "200",
    ref("SourceTimelineParseResponse")
  );
  patchJsonResponse(
    document,
    "/automation/capabilities",
    "get",
    "200",
    ref("AutomationCapabilities")
  );
  patchJsonResponse(document, "/slugs", "get", "200", ref("SlugListResponse"));
  patchMultipartRequestBody(document, "/slugs", "post", ref("SlugImport"));
  patchJsonResponse(document, "/slugs", "post", "201", ref("SlugAsset"));
  patchPathContent(document, "/slugs/{id}/media", "get", "200", "video/mp4", {
    type: "string",
    format: "binary",
  });
  patchJsonRequestBody(document, "/projects/{id}/export", "post", ref("ExportOptions"));
  patchJsonRequestBody(document, "/projects/{id}/render", "post", ref("ExportOptions"));
  patchPathContent(document, "/projects/{id}/media", "get", "200", "video/mp4", {
    type: "string",
    format: "binary",
  });
  patchPathContent(document, "/projects/{id}/bundle", "get", "200", "application/zip", {
    type: "string",
    format: "binary",
  });
  patchPathContent(document, "/projects/{id}/exports/latest", "get", "200", "video/mp4", {
    type: "string",
    format: "binary",
  });
  patchPathContent(document, "/projects/{id}/thumbnail", "get", "200", "image/jpeg", {
    type: "string",
    format: "binary",
  });
  patchPathContent(document, "/templates/cards/{id}", "get", "200", "image/png", {
    type: "string",
    format: "binary",
  });
  patchPathContent(document, "/templates/arrows/{filename}", "get", "200", "image/png", {
    type: "string",
    format: "binary",
  });
  patchPathContent(document, "/projects/{id}/render/stream", "get", "200", "text/event-stream", {
    type: "string",
  });
  patchPathContent(document, "/projects/{id}/events", "get", "200", "text/event-stream", {
    type: "string",
  });
  return document;
}
