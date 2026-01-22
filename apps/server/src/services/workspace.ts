import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Project, VideoInfo } from "@content-tools/shared";
import { ProjectSchema } from "@content-tools/shared";
import { WORKSPACE_ROOT } from "../config.js";
import { ensureDir, fileExists } from "../utils/fs.js";

const PROJECT_FILENAME = "project.json";

function projectDir(id: string): string {
  return path.join(WORKSPACE_ROOT, id);
}

export function projectFilePath(id: string): string {
  return path.join(projectDir(id), PROJECT_FILENAME);
}

export async function ensureWorkspaceRoot(): Promise<void> {
  await ensureDir(WORKSPACE_ROOT);
}

export async function listProjects(): Promise<Project[]> {
  await ensureWorkspaceRoot();
  const entries = await fs.readdir(WORKSPACE_ROOT, { withFileTypes: true });
  const projects: Project[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const filePath = projectFilePath(entry.name);
    if (!(await fileExists(filePath))) continue;

    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = ProjectSchema.safeParse(JSON.parse(raw));
    if (parsed.success) {
      projects.push(parsed.data);
    }
  }

  return projects;
}

export async function readProject(id: string): Promise<Project | null> {
  const filePath = projectFilePath(id);
  if (!(await fileExists(filePath))) return null;
  const raw = await fs.readFile(filePath, "utf-8");
  return ProjectSchema.parse(JSON.parse(raw));
}

export async function writeProject(project: Project): Promise<void> {
  await ensureDir(projectDir(project.id));
  const payload = JSON.stringify(project, null, 2);
  await fs.writeFile(projectFilePath(project.id), payload, "utf-8");
}

export async function deleteProject(id: string): Promise<boolean> {
  const dir = projectDir(id);
  const filePath = projectFilePath(id);
  if (!(await fileExists(filePath))) return false;
  await fs.rm(dir, { recursive: true, force: true });
  return true;
}

function defaultVideoInfo(): VideoInfo {
  return {
    width: 1920,
    height: 1080,
    fpsNum: 30,
    fpsDen: 1,
    durationMs: 0,
    audio: { hasAudio: false },
  };
}

export async function createProject(
  name: string,
  overrides?: Partial<VideoInfo>
): Promise<Project> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const video = { ...defaultVideoInfo(), ...overrides };

  const project = ProjectSchema.parse({
    id,
    name,
    createdAt: now,
    updatedAt: now,
    source: {
      filename: "source.mp4",
    },
    video,
    proxy: { enabled: false },
    overlays: [],
    renderCache: { overlayAssetHash: {} },
  });

  await writeProject(project);
  return project;
}
