import type { FastifyPluginAsync } from "fastify";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { VideoInfo } from "@content-tools/shared";
import { RAWFORM_API_BASE, RAWFORM_EDITOR_INGRESS_URL, RAWFORM_PUBLIC_BASE_URL, WORKSPACE_ROOT } from "../config.js";
import { routeDoc } from "../openapi.js";
import { createProject, readProject, writeProject } from "../services/workspace.js";
import { fileExists } from "../utils/fs.js";
import { importSourceVideo } from "./projects.js";
import { emitProjectUpdated } from "../services/project-events.js";

type RawFormEditSubmissionBody = {
  projectId?: string;
  sessionId?: string;
  editType?: "unsigned" | "commentator" | "signed";
  editor?: Record<string, unknown>;
  copyrightHolder?: Record<string, unknown>;
  attestation?: Record<string, unknown>;
  sourceReferences?: Array<Record<string, unknown>>;
  commentaryContext?: Record<string, unknown>;
};

type RawFormSessionImportBody = {
  sessionId?: string;
  projectId?: string;
};

export const rawformRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/config",
    routeDoc(["System"], "RawForm integration config", {
      response: { 200: { type: "object", additionalProperties: true } },
    }),
    async () => ({
      enabled: Boolean(RAWFORM_API_BASE),
      apiBaseConfigured: Boolean(RAWFORM_API_BASE),
      publicBaseUrl: RAWFORM_PUBLIC_BASE_URL,
      editorIngressUrl: RAWFORM_EDITOR_INGRESS_URL,
      editTypes: ["unsigned", "commentator", "signed"],
    })
  );

  app.get(
    "/sessions",
    routeDoc(["Automation"], "List RawForm sessions for editor import", {
      response: { 200: { type: "object", additionalProperties: true } },
    }),
    async (request, reply) => {
      if (!RAWFORM_API_BASE) {
        return reply.code(503).send({ error: "RAWFORM_API_BASE is not configured" });
      }

      const rawLimit = Number((request.query as { limit?: string })?.limit ?? 50);
      const limit = Math.max(1, Math.min(100, Number.isFinite(rawLimit) ? rawLimit : 50));
      const response = await rawformFetch(`/api/sessions?limit=${limit}`, { method: "GET" });
      const sessions = Array.isArray(response.sessions) ? response.sessions : [];
      return {
        sessions: sessions.map((session) => normalizeRawFormSession(session)),
      };
    }
  );

  app.post(
    "/session-imports",
    routeDoc(["Automation"], "Import a RawForm session video into an editor project", {
      body: { type: "object", additionalProperties: true },
      response: { 200: { type: "object", additionalProperties: true } },
    }),
    async (request, reply) => {
      if (!RAWFORM_API_BASE) {
        return reply.code(503).send({ error: "RAWFORM_API_BASE is not configured" });
      }

      const body = (request.body ?? {}) as RawFormSessionImportBody;
      const sessionId = String(body.sessionId ?? "").trim();
      const projectId = String(body.projectId ?? "").trim();
      if (!sessionId) {
        return reply.code(400).send({ error: "sessionId is required" });
      }

      const mediaResponse = await fetch(
        `${RAWFORM_API_BASE}/api/raw_media/${encodeURIComponent(sessionId)}`,
        { headers: { "User-Agent": "content-tools-studio/1.0" } }
      );
      if (!mediaResponse.ok || !mediaResponse.body) {
        const text = await mediaResponse.text().catch(() => "");
        return reply.code(mediaResponse.status || 502).send({
          error: text || `RawForm media request failed: ${mediaResponse.status}`,
        });
      }

      let project = projectId ? await readProject(projectId) : null;
      if (projectId && !project) {
        return reply.code(404).send({ error: "project not found" });
      }
      if (!project) {
        project = await createProject(`RawForm ${sessionId.slice(0, 8)}`);
      }

      try {
        const record = await rawformFetch(`/api/record/${encodeURIComponent(sessionId)}`, { method: "GET" }).catch(
          () => null
        );
        const filename = filenameForRawFormMedia(sessionId, mediaResponse);
        const updatedProject = await importSourceVideo(project, {
          stream: Readable.fromWeb(mediaResponse.body as unknown as WebReadableStream<Uint8Array>),
          filename,
        });
        const rawFormProject = {
          ...updatedProject,
          source: {
            ...updatedProject.source,
            rawFormSessionId: sessionId,
          },
          video: videoInfoForRawFormRecord(updatedProject.video, record),
        };
        await writeProject(rawFormProject);
        emitProjectUpdated(rawFormProject, "rawform-import", {
          actor: "api",
          summary: `Imported RawForm session ${sessionId}.`,
        });
        return { ok: true, project: rawFormProject, sessionId };
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    }
  );

  app.post(
    "/edit-submissions",
    routeDoc(["Automation"], "Submit latest rendered export to RawForm as an edit", {
      body: { type: "object", additionalProperties: true },
      response: { 200: { type: "object", additionalProperties: true } },
    }),
    async (request, reply) => {
      if (!RAWFORM_API_BASE) {
        return reply.code(503).send({ error: "RAWFORM_API_BASE is not configured" });
      }

      const body = (request.body ?? {}) as RawFormEditSubmissionBody;
      const projectId = String(body.projectId ?? "").trim();
      const sessionId = String(body.sessionId ?? "").trim();
      const editType = String(body.editType ?? "unsigned").trim().toLowerCase();
      if (!projectId || !sessionId) {
        return reply.code(400).send({ error: "projectId and sessionId are required" });
      }
      if (!isRawFormSessionId(sessionId)) {
        return reply.code(400).send({ error: "sessionId must be the full RawForm session UUID" });
      }
      if (!["unsigned", "commentator", "signed"].includes(editType)) {
        return reply.code(400).send({ error: "invalid editType" });
      }
      for (const reference of body.sourceReferences ?? []) {
        const sourceSessionId = String(reference.source_session_id ?? "").trim();
        if (sourceSessionId && !isRawFormSessionId(sourceSessionId)) {
          return reply.code(400).send({ error: "sourceReferences.source_session_id must be the full RawForm session UUID" });
        }
      }

      const project = await readProject(projectId);
      if (!project) {
        return reply.code(404).send({ error: "project not found" });
      }
      const projectRawFormSessionId = getProjectRawFormSessionId(project);
      if (!projectRawFormSessionId) {
        return reply.code(400).send({ error: "project source is not a RawForm video" });
      }
      if (sessionId !== projectRawFormSessionId) {
        return reply.code(400).send({ error: "sessionId must match the project's RawForm source session" });
      }
      const latest = await findLatestFinalExport(projectId);
      if (!latest) {
        return reply.code(400).send({ error: "render a final export before submitting to RawForm" });
      }

      const fileBuffer = await fs.readFile(latest.finalPath);
      const sha256 = createHash("sha256").update(fileBuffer).digest("hex");
      const editId = randomUUID();
      const uploadResponse = await rawformFetch(
        `/api/edited_clip/${encodeURIComponent(sessionId)}/upload?ext=mp4&edit_id=${encodeURIComponent(editId)}`,
        {
          method: "POST",
          headers: { "content-type": "video/mp4" },
          body: fileBuffer,
        }
      );

      const manifest = {
        edit_id: editId,
        session_id: sessionId,
        edit_type: editType,
        edited_media_key: uploadResponse.edited_media_key,
        edited_media_sha256: sha256,
        edited_media_bytes: fileBuffer.length,
        content_type: "video/mp4",
        editor: body.editor ?? {},
        copyright_holder: body.copyrightHolder ?? {},
        attestation: body.attestation ?? {},
        source_references: body.sourceReferences ?? [],
        commentary_context: body.commentaryContext ?? {},
        timeline: {
          cuts: project.edits?.cuts ?? [],
          source_segments: project.edits?.sourceSegments ?? [],
          overlays: project.overlays.map((overlay) => ({
            id: overlay.id,
            template_id: overlay.templateId,
            start_frame: overlay.startFrame,
            end_frame: overlay.endFrame,
            fields: overlay.fields,
          })),
          audio: project.audioTrack ?? {},
          export_id: latest.exportId,
          export_manifest: latest.manifest,
        },
        content_tools: {
          project_id: project.id,
          project_name: project.name,
          project_revision: project.revision,
          source_filename: project.source.filename,
          export_id: latest.exportId,
          editor_ingress_url: RAWFORM_EDITOR_INGRESS_URL || undefined,
        },
      };

      const manifestResponse = await rawformFetch("/api/edit_manifest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(manifest),
      });

      return {
        ok: true,
        rawform: manifestResponse,
        editedMedia: uploadResponse,
        manifest,
      };
    }
  );
};

function normalizeRawFormSession(session: unknown): Record<string, unknown> {
  if (!session || typeof session !== "object") return {};
  const payload = session as Record<string, unknown>;
  const sessionId = String(payload.session_id ?? payload.sessionId ?? "");
  return {
    ...payload,
    sessionId,
    createdAtMs: payload.created_at_ms ?? payload.createdAtMs ?? null,
    label: sessionId ? formatRawFormSessionLabel(payload, sessionId) : "RawForm session",
  };
}

function formatRawFormSessionLabel(payload: Record<string, unknown>, sessionId: string): string {
  const createdAtMs = Number(payload.created_at_ms ?? payload.createdAtMs ?? 0);
  const date = Number.isFinite(createdAtMs) && createdAtMs > 0
    ? new Date(createdAtMs).toLocaleString()
    : "Unknown date";
  const status = String(payload.analysis_status ?? "not_started").replace(/_/g, " ");
  return `${date} · ${status} · ${sessionId.slice(0, 8)}`;
}

function filenameForRawFormMedia(sessionId: string, response: Response): string {
  const disposition = response.headers.get("content-disposition");
  const dispositionName = disposition?.match(/filename="?([^";]+)"?/i)?.[1];
  if (dispositionName) return dispositionName;
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  const extension =
    contentType === "video/webm" ? "webm"
      : contentType === "video/quicktime" ? "mov"
        : "mp4";
  return `rawform-${sessionId}.${extension}`;
}

function videoInfoForRawFormRecord(video: VideoInfo, record: Record<string, unknown> | null): VideoInfo {
  if (!record) return video;
  const capture = typeof record.capture === "object" && record.capture ? record.capture as Record<string, unknown> : {};
  const timing = typeof record.timing === "object" && record.timing ? record.timing as Record<string, unknown> : {};
  const segments = Array.isArray(record.segments) ? record.segments as Array<Record<string, unknown>> : [];

  const segmentDurationMs = segments.reduce((max, segment) => {
    const end = Number(segment.t_end_ms);
    return Number.isFinite(end) ? Math.max(max, end) : max;
  }, 0);
  const timingDurationMs = Number(timing.end_monotonic_ms) - Number(timing.start_monotonic_ms);
  const durationMs = firstPositiveInteger(segmentDurationMs, timingDurationMs, video.durationMs);

  const fpsEstimate = Number(capture.fps_estimate);
  const fps = Number.isFinite(fpsEstimate) && fpsEstimate > 0 && fpsEstimate <= 120
    ? Math.round(fpsEstimate)
    : (video.fpsNum / video.fpsDen > 0 && video.fpsNum / video.fpsDen <= 120 ? Math.round(video.fpsNum / video.fpsDen) : 30);

  return {
    ...video,
    width: firstPositiveInteger(Number(capture.width), video.width),
    height: firstPositiveInteger(Number(capture.height), video.height),
    fpsNum: fps,
    fpsDen: 1,
    durationMs,
  };
}

function firstPositiveInteger(...values: number[]): number {
  for (const value of values) {
    if (Number.isFinite(value) && value > 0) {
      return Math.round(value);
    }
  }
  return 0;
}

async function rawformFetch(pathname: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(`${RAWFORM_API_BASE}${pathname}`, init);
  const text = await response.text();
  let payload: unknown = text;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : text || `RawForm request failed: ${response.status}`;
    throw new Error(message);
  }
  return (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
}

function isRawFormSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

function getProjectRawFormSessionId(project: { name?: string; source?: { filename?: string; rawFormSessionId?: string } }): string {
  const recorded = String(project.source?.rawFormSessionId ?? "").trim();
  if (isRawFormSessionId(recorded)) return recorded;

  const filename = String(project.source?.filename ?? "");
  const match = filename.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (match && String(project.name ?? "").startsWith("RawForm ")) return match[0];
  return "";
}

async function findLatestFinalExport(
  projectId: string
): Promise<{ exportId: string; exportDir: string; finalPath: string; manifest: unknown } | null> {
  const exportsRoot = path.join(WORKSPACE_ROOT, projectId, "exports");
  if (!(await fileExists(exportsRoot))) return null;
  const entries = await fs.readdir(exportsRoot, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const exportId of dirs) {
    const exportDir = path.join(exportsRoot, exportId);
    const finalPath = path.join(exportDir, "final.mp4");
    if (!(await fileExists(finalPath))) continue;
    const manifestPath = path.join(exportDir, "manifest.json");
    let manifest: unknown = null;
    if (await fileExists(manifestPath)) {
      manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
    }
    return { exportId, exportDir, finalPath, manifest };
  }
  return null;
}
