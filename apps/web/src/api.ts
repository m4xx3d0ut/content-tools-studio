const fallbackBase =
  typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.hostname}:3033`
    : "http://127.0.0.1:3033";
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? fallbackBase;

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, options);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export type ProjectSummary = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  source: { filename: string };
  video: { width: number; height: number; fpsNum: number; fpsDen: number };
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

export type Project = ProjectSummary & {
  schemaVersion?: number;
  source: { filename: string; sizeBytes?: number; sha256?: string };
  video: {
    width: number;
    height: number;
    fpsNum: number;
    fpsDen: number;
    durationMs: number;
  };
  overlays: Overlay[];
  exportOptions?: { speed?: 1 | 2; includeSlug?: boolean };
  slug?: { introPath?: string; outroPath?: string; fps?: number };
};

export async function listProjects(): Promise<ProjectSummary[]> {
  const data = await request<{ projects: ProjectSummary[] }>("/projects");
  return data.projects;
}

export async function createProject(name: string): Promise<ProjectSummary> {
  return request<ProjectSummary>("/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export async function importVideo(projectId: string, file: File): Promise<ProjectSummary> {
  const form = new FormData();
  form.append("file", file);
  return request<ProjectSummary>(`/projects/${projectId}/import`, {
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
  includeSlug?: boolean;
  speed?: 1 | 2;
};

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

export function renderStreamUrl(projectId: string, options: ExportOptions): string {
  const params = new URLSearchParams();
  if (options.presetId) params.set("presetId", options.presetId);
  if (typeof options.includeSlug === "boolean") {
    params.set("includeSlug", String(options.includeSlug));
  }
  if (options.speed) params.set("speed", String(options.speed));
  const query = params.toString();
  return `${API_BASE}/projects/${projectId}/render/stream${query ? `?${query}` : ""}`;
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
