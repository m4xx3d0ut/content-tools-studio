const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ??
  "http://127.0.0.1:3033";

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
