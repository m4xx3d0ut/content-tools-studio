const fallbackBase =
  import.meta.env.DEV && typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.hostname}:3033`
    : "";
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? fallbackBase;

export class ApiError extends Error {
  status: number;
  payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, options);
  if (!response.ok) {
    const text = await response.text();
    let payload: unknown = text;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : text || `Request failed: ${response.status}`;
    throw new ApiError(message, response.status, payload);
  }
  return response.json() as Promise<T>;
}

export function assetUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  return `${API_BASE}${path}`;
}

export type ProjectSummary = {
  id: string;
  revision?: number;
  name: string;
  createdAt: string;
  updatedAt: string;
  source: { filename: string; rawFormSessionId?: string };
  video: {
    width: number;
    height: number;
    fpsNum: number;
    fpsDen: number;
    audio: { hasAudio: boolean; sampleRate?: number; channels?: number };
  };
};

export type RawFormEditType = "unsigned" | "commentator" | "signed";

export type RawFormConfig = {
  enabled: boolean;
  apiBaseConfigured: boolean;
  publicBaseUrl?: string;
  editorIngressUrl?: string;
  editTypes: RawFormEditType[];
};

export type RawFormEditSubmission = {
  projectId: string;
  sessionId: string;
  editType: RawFormEditType;
  editor?: Record<string, unknown>;
  copyrightHolder?: Record<string, unknown>;
  attestation?: Record<string, unknown>;
  sourceReferences?: Array<Record<string, unknown>>;
  commentaryContext?: Record<string, unknown>;
};

export type RawFormSessionSummary = {
  session_id?: string;
  sessionId: string;
  created_at_ms?: number;
  createdAtMs?: number | null;
  analysis_status?: string;
  record_present?: boolean;
  trust_color?: string | null;
  label?: string;
};

export type RawFormSessionsResponse = {
  sessions: RawFormSessionSummary[];
};

export type RawFormSessionImportRequest = {
  sessionId: string;
  projectId?: string;
};

export type RawFormSessionImportResponse = {
  ok: boolean;
  project: Project;
  sessionId: string;
};

export type Rect = { x: number; y: number; w: number; h: number };

export type Motion = {
  slideInFrames?: number;
  displayFrames?: number;
  slideOutFrames?: number;
  slideDirection?: "fromLeft" | "fromRight" | "none";
  visibleStartFrame?: number;
  visibleEndFrame?: number;
  pulsePeriodFrames?: number;
  pulseMinAlpha?: number;
  pulseMaxAlpha?: number;
  bouncePx?: number;
  bouncePeriodFrames?: number;
  bounceAxis?: "x" | "y";
};

export type Overlay = {
  id: string;
  templateId: string;
  templateVersion: string;
  startFrame: number;
  endFrame: number;
  rect: Rect;
  rotationDeg?: number;
  opacity?: number;
  zIndex: number;
  fields: Record<string, string | number | boolean | null>;
  motion?: Motion;
};

export type SourceSegment = {
  kind: "source" | "image";
  id: string;
  label?: string;
  startFrame: number;
  endFrameExclusive: number;
  playbackRate: number;
  audio: "preserve" | "mute";
  assetPath?: string;
  durationFrames?: number;
  transition?: { type: "cut" | "crossfade"; durationFrames: number };
};

export type TemplateTextLayout = {
  xPct: number;
  yPct: number;
  sizePct: number;
  color: string;
};

export type TemplateInfo = {
  id: string;
  label: string;
  imagePath: string;
  bounds: { left: number; top: number; width: number; height: number };
  sourceWidth: number;
  sourceHeight: number;
  align: "left" | "center" | "right";
  title: TemplateTextLayout;
  subtitle: TemplateTextLayout | null;
};

export type ArrowInfo = {
  id: string;
  label: string;
  imagePath: string;
  sourceWidth: number;
  sourceHeight: number;
};

export type SlugAsset = {
  id: string;
  label: string;
  filename: string;
  path: string;
  source: "seed" | "upload";
  video: {
    width: number;
    height: number;
    fpsNum: number;
    fpsDen: number;
    durationMs: number;
    audio: { hasAudio: boolean; sampleRate?: number; channels?: number };
  };
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  updatedAt: string;
  usageCount?: number;
};

export type AudioTrack = {
  assetPath: string;
  mode: "overlay" | "replace";
  startSec: number;
  source: "upload" | "url";
  filename?: string;
  originalUrl?: string;
  fadeOut?: {
    enabled: boolean;
    target: "tailSlug" | "end";
    durationSec: number;
  };
};

export type AudioAsset = {
  ok: boolean;
  path: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  source: "upload" | "url";
  originalUrl?: string;
  audio: {
    durationMs: number;
    sampleRate?: number;
    channels?: number;
    codecName?: string;
  };
};

export type Project = ProjectSummary & {
  schemaVersion: 1;
  revision: number;
  source: { filename: string; sizeBytes?: number; sha256?: string; rawFormSessionId?: string };
  video: {
    width: number;
    height: number;
    fpsNum: number;
    fpsDen: number;
    durationMs: number;
    audio: { hasAudio: boolean; sampleRate?: number; channels?: number };
  };
  proxy: {
    enabled: boolean;
    width?: number;
    height?: number;
    crf?: number;
    preset?: string;
  };
  overlays: Overlay[];
  exportOptions?: {
    speed: 1 | 2;
    includeAudio: boolean;
    includeSlug: boolean;
    includeSlugStart: boolean;
    includeSlugEnd: boolean;
  };
  lastExportPresetId?: string;
  edits?: {
    trimStartFrames: number;
    trimEndFrames: number;
    cuts: Array<{
      id: string;
      startFrame: number;
      endFrame: number;
      transition?: { type: "cut" | "crossfade"; durationFrames: number };
    }>;
    sourceSegments: SourceSegment[];
  };
  slug?: {
    introPath?: string;
    outroPath?: string;
    fps?: number;
    transition?: { type: "cut" | "crossfade"; durationFrames: number };
  };
  audioTrack?: AudioTrack;
  renderCache: {
    overlayAssetHash: Record<string, string>;
    templatesVersion?: string;
  };
};

export async function listProjects(): Promise<ProjectSummary[]> {
  const data = await request<{ projects: ProjectSummary[] }>("/projects");
  return data.projects;
}

export async function getRawFormConfig(): Promise<RawFormConfig> {
  return request<RawFormConfig>("/rawform/config");
}

export async function listRawFormSessions(limit = 50): Promise<RawFormSessionsResponse> {
  return request<RawFormSessionsResponse>(`/rawform/sessions?limit=${limit}`);
}

export async function importRawFormSession(
  payload: RawFormSessionImportRequest
): Promise<RawFormSessionImportResponse> {
  return request<RawFormSessionImportResponse>("/rawform/session-imports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function submitRawFormEdit(payload: RawFormEditSubmission) {
  return request<{ ok: boolean; rawform: Record<string, unknown> }>("/rawform/edit-submissions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function listTemplates(): Promise<{
  templates: TemplateInfo[];
  arrows: ArrowInfo[];
}> {
  return request("/templates");
}

export async function listSlugs(): Promise<SlugAsset[]> {
  const data = await request<{ slugs: SlugAsset[] }>("/slugs");
  return data.slugs;
}

export async function importSlugVideo(file: File): Promise<SlugAsset> {
  const form = new FormData();
  form.append("file", file);
  return request<SlugAsset>("/slugs", {
    method: "POST",
    body: form,
  });
}

export async function deleteSlug(slugId: string): Promise<{ ok: boolean }> {
  return request(`/slugs/${slugId}`, { method: "DELETE" });
}

export async function createProject(name: string): Promise<ProjectSummary> {
  return request<ProjectSummary>("/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export async function deleteProject(projectId: string): Promise<{ ok: boolean }> {
  return request(`/projects/${projectId}`, { method: "DELETE" });
}

export async function importVideo(projectId: string, file: File): Promise<ProjectSummary> {
  const form = new FormData();
  form.append("file", file);
  return request<ProjectSummary>(`/projects/${projectId}/import`, {
    method: "POST",
    body: form,
  });
}

export async function uploadTimelineAsset(projectId: string, file: File): Promise<{
  ok: boolean;
  path: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
}> {
  const form = new FormData();
  form.append("file", file);
  return request(`/projects/${projectId}/timeline-assets`, {
    method: "POST",
    body: form,
  });
}

export async function uploadAudioAsset(projectId: string, file: File): Promise<AudioAsset> {
  const form = new FormData();
  form.append("file", file);
  return request<AudioAsset>(`/projects/${projectId}/audio-assets`, {
    method: "POST",
    body: form,
  });
}

export async function importAudioAssetFromUrl(projectId: string, url: string): Promise<AudioAsset> {
  return request<AudioAsset>(`/projects/${projectId}/audio-assets/from-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

export type ProjectBundleMode = "project" | "project-media" | "full";

export async function importProjectBundle(file: File): Promise<Project> {
  const form = new FormData();
  form.append("file", file);
  return request<Project>("/projects/import-bundle", {
    method: "POST",
    body: form,
  });
}

export async function getProject(projectId: string): Promise<Project> {
  return request<Project>(`/projects/${projectId}`);
}

export async function updateProject(projectId: string, project: Project): Promise<Project> {
  return request<Project>(`/projects/${projectId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(project),
  });
}

export type ExportOptions = {
  presetId?: string;
  includeAudio?: boolean;
  includeSlug?: boolean;
  includeSlugStart?: boolean;
  includeSlugEnd?: boolean;
  speed?: 1 | 2;
  renderMode?: "final" | "rough";
};

export type RenderCapability = "nvenc";

export type RenderCapabilityStatus = {
  available: boolean;
  reason?: string;
};

export type RenderPresetStatus = {
  id: string;
  label: string;
  codec: string;
  hardware: boolean;
  requiresCapability?: RenderCapability;
  available: boolean;
  reason?: string;
};

export type RenderCapabilities = {
  checkedAt: string;
  ffmpegPath: string;
  capabilities: Record<RenderCapability, RenderCapabilityStatus>;
  presets: RenderPresetStatus[];
};

export type SurgicalPatchStatus = {
  patchable: boolean;
  reason?: string;
  latestExportId?: string;
  changedOverlayIds: string[];
  affectedWindows: Array<{ startSec: number; endSec: number }>;
  estimatedPatchSec?: number;
};

export async function getRenderCapabilities(options: { refresh?: boolean } = {}) {
  const params = new URLSearchParams();
  if (options.refresh) params.set("refresh", "true");
  const query = params.toString();
  return request<RenderCapabilities>(`/render/capabilities${query ? `?${query}` : ""}`);
}

export async function exportProject(projectId: string, options: ExportOptions) {
  return request(`/projects/${projectId}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
}

export async function renderProject(projectId: string, options: ExportOptions) {
  return request(`/projects/${projectId}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
}

export async function getPatchStatus(
  projectId: string,
  options: ExportOptions
): Promise<SurgicalPatchStatus> {
  const params = renderOptionsParams(options);
  const query = params.toString();
  return request<SurgicalPatchStatus>(
    `/projects/${projectId}/patch/status${query ? `?${query}` : ""}`
  );
}

export async function parseSourceTimeline(
  projectId: string,
  text: string,
  options: { defaultAudio?: "preserve" | "mute"; fastAudio?: "preserve" | "mute" } = {}
) {
  return request<{
    segments: SourceSegment[];
    warnings: string[];
    outputDurationSeconds: number;
    outputFrames: number;
  }>(`/projects/${projectId}/timeline/parse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, ...options }),
  });
}

function renderOptionsParams(options: ExportOptions): URLSearchParams {
  const params = new URLSearchParams();
  if (options.presetId) params.set("presetId", options.presetId);
  if (typeof options.includeAudio === "boolean") {
    params.set("includeAudio", String(options.includeAudio));
  }
  if (typeof options.includeSlug === "boolean") {
    params.set("includeSlug", String(options.includeSlug));
  }
  if (typeof options.includeSlugStart === "boolean") {
    params.set("includeSlugStart", String(options.includeSlugStart));
  }
  if (typeof options.includeSlugEnd === "boolean") {
    params.set("includeSlugEnd", String(options.includeSlugEnd));
  }
  if (options.speed) params.set("speed", String(options.speed));
  if (options.renderMode === "rough") params.set("renderMode", options.renderMode);
  if (options.renderMode === "final") params.set("renderMode", options.renderMode);
  return params;
}

export function renderStreamUrl(projectId: string, options: ExportOptions): string {
  const params = renderOptionsParams(options);
  const query = params.toString();
  return `${API_BASE}/projects/${projectId}/render/stream${query ? `?${query}` : ""}`;
}

export function patchStreamUrl(projectId: string, options: ExportOptions): string {
  const params = renderOptionsParams(options);
  const query = params.toString();
  return `${API_BASE}/projects/${projectId}/patch/stream${query ? `?${query}` : ""}`;
}

export async function uploadAsset(
  projectId: string,
  kind: "overlays" | "arrows",
  overlayId: string,
  blob: Blob
) {
  const form = new FormData();
  form.append("file", blob, `${overlayId}.png`);
  return request(`/projects/${projectId}/assets/${kind}/${overlayId}`, {
    method: "POST",
    body: form,
  });
}

export function mediaUrl(projectId: string): string {
  return `${API_BASE}/projects/${projectId}/media`;
}

export function thumbnailUrl(projectId: string, frame: number, width = 240): string {
  const params = new URLSearchParams({ frame: String(frame), width: String(width) });
  return `${API_BASE}/projects/${projectId}/thumbnail?${params.toString()}`;
}

export function exportLatestUrl(projectId: string): string {
  return `${API_BASE}/projects/${projectId}/exports/latest`;
}

export function projectBundleUrl(projectId: string, mode: ProjectBundleMode = "project-media"): string {
  const params = new URLSearchParams({ mode });
  return `${API_BASE}/projects/${projectId}/bundle?${params.toString()}`;
}

export function projectEventsUrl(projectId: string): string {
  return `${API_BASE}/projects/${projectId}/events`;
}

export function slugMediaUrl(slugId: string): string {
  return `${API_BASE}/slugs/${slugId}/media`;
}
