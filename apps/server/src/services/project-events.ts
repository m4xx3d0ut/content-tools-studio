import { EventEmitter } from "node:events";
import type { Project } from "@content-tools/shared";

export type ProjectEvent = {
  type: "project-updated" | "project-deleted";
  projectId: string;
  revision?: number;
  source: string;
  at: string;
};

const projectEvents = new EventEmitter();
projectEvents.setMaxListeners(0);

export function onProjectEvent(
  projectId: string,
  listener: (event: ProjectEvent) => void
): () => void {
  projectEvents.on(projectId, listener);
  return () => projectEvents.off(projectId, listener);
}

export function emitProjectUpdated(project: Project, source: string): void {
  const event: ProjectEvent = {
    type: "project-updated",
    projectId: project.id,
    revision: project.revision,
    source,
    at: new Date().toISOString(),
  };
  projectEvents.emit(project.id, event);
}

export function emitProjectDeleted(projectId: string, source: string): void {
  const event: ProjectEvent = {
    type: "project-deleted",
    projectId,
    source,
    at: new Date().toISOString(),
  };
  projectEvents.emit(projectId, event);
}
