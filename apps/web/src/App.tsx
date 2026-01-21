import { useEffect, useState } from "react";
import {
  createProject,
  exportProject,
  importVideo,
  listProjects,
  type ProjectSummary,
} from "./api";

export default function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [speed, setSpeed] = useState<1 | 2>(1);
  const [includeSlug, setIncludeSlug] = useState(false);
  const [exportResult, setExportResult] = useState<unknown>(null);

  const selectedProject = projects.find((project) => project.id === selectedId) ?? null;

  async function refreshProjects(nextSelectedId?: string) {
    const list = await listProjects();
    setProjects(list);
    if (nextSelectedId) {
      setSelectedId(nextSelectedId);
      return;
    }
    if (list.length && !selectedId) {
      setSelectedId(list[0].id);
    }
  }

  useEffect(() => {
    refreshProjects();
  }, []);

  async function handleCreate() {
    if (!nameInput.trim()) return;
    setStatus("Creating project...");
    try {
      const project = await createProject(nameInput.trim());
      setNameInput("");
      await refreshProjects(project.id);
      setStatus(`Created ${project.name}.`);
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  async function handleImport(file: File) {
    if (!selectedId) {
      setStatus("Select a project first.");
      return;
    }
    setStatus("Uploading video and probing metadata...");
    try {
      const project = await importVideo(selectedId, file);
      await refreshProjects(project.id);
      setStatus(`Imported ${project.source.filename}.`);
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  async function handleExport() {
    if (!selectedId) {
      setStatus("Select a project first.");
      return;
    }
    setStatus("Generating export bundle...");
    try {
      const result = await exportProject(selectedId, { speed, includeSlug });
      setExportResult(result);
      setStatus("Export bundle ready.");
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  return (
    <main>
      <h1>Content Tools Studio</h1>
      <p className="subtitle">
        Local-first annotation workflow for video overlays. Create a project, import
        footage, and export FFmpeg bundles with deterministic filter graphs.
      </p>

      <div className="panel-grid">
        <section className="panel">
          <h2>Projects</h2>
          <label htmlFor="project-name">New project name</label>
          <input
            id="project-name"
            type="text"
            value={nameInput}
            onChange={(event) => setNameInput(event.target.value)}
            placeholder="K1s demo walkthrough"
          />
          <div className="actions">
            <button onClick={handleCreate}>Create project</button>
            <button className="secondary" onClick={() => refreshProjects()}>
              Refresh list
            </button>
          </div>

          <ul className="project-list" style={{ marginTop: "16px" }}>
            {projects.map((project) => (
              <li className="project-card" key={project.id}>
                <div>
                  <strong>{project.name}</strong>
                  <div className="details">{project.id}</div>
                </div>
                <button onClick={() => setSelectedId(project.id)}>Select</button>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <h2>Import</h2>
          <div className="details">
            {selectedProject
              ? `Selected: ${selectedProject.name}`
              : "Select a project to attach media."}
          </div>
          {selectedProject && (
            <div className="details">
              Source: {selectedProject.source.filename || "—"}
              <br />
              Video: {selectedProject.video.width}×{selectedProject.video.height} @{
                selectedProject.video.fpsNum / selectedProject.video.fpsDen
              }
              fps
            </div>
          )}
          <div className="actions">
            <input
              type="file"
              accept="video/*"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  void handleImport(file);
                }
              }}
            />
          </div>
        </section>

        <section className="panel">
          <h2>Export</h2>
          <label htmlFor="speed">Speed</label>
          <select
            id="speed"
            value={speed}
            onChange={(event) => setSpeed(Number(event.target.value) as 1 | 2)}
          >
            <option value={1}>1× (normal)</option>
            <option value={2}>2× (fast)</option>
          </select>

          <label htmlFor="slug" style={{ marginTop: "12px" }}>
            Include slug intro/outro
          </label>
          <select
            id="slug"
            value={includeSlug ? "yes" : "no"}
            onChange={(event) => setIncludeSlug(event.target.value === "yes")}
          >
            <option value="no">No slug</option>
            <option value="yes">Include slug</option>
          </select>

          <div className="actions">
            <button onClick={handleExport}>Generate bundle</button>
          </div>

          {exportResult && (
            <div className="details">
              Export manifest ready. Check the server console or workspace exports
              folder for output.
            </div>
          )}
        </section>
      </div>

      {status && <div className="status">{status}</div>}
    </main>
  );
}
