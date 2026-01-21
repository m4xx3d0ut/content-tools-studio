import { useEffect, useMemo, useRef, useState } from "react";
import {
  createProject,
  getProject,
  importVideo,
  listProjects,
  mediaUrl,
  renderProject,
  updateProject,
  uploadAsset,
  type Overlay,
  type Project,
  type ProjectSummary,
} from "./api";

const DEFAULT_CARD_SIZE = { w: 720, h: 160 };
const DEFAULT_ARROW_SIZE = { w: 128, h: 128 };

function isArrow(overlay: Overlay) {
  return overlay.templateId.startsWith("arrow");
}

function getFps(project: Project | null) {
  if (!project) return 30;
  return project.video.fpsDen === 0 ? 30 : project.video.fpsNum / project.video.fpsDen;
}

function formatFrame(frame: number) {
  return Math.max(0, Math.floor(frame));
}

function renderCardCanvas(overlay: Overlay): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(overlay.rect.w));
  canvas.height = Math.max(1, Math.floor(overlay.rect.h));
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const radius = Math.min(24, canvas.height / 2);
  ctx.fillStyle = "rgba(15, 19, 24, 0.85)";
  ctx.strokeStyle = "rgba(247, 179, 91, 0.6)";
  ctx.lineWidth = 2;

  ctx.beginPath();
  ctx.moveTo(radius, 0);
  ctx.lineTo(canvas.width - radius, 0);
  ctx.quadraticCurveTo(canvas.width, 0, canvas.width, radius);
  ctx.lineTo(canvas.width, canvas.height - radius);
  ctx.quadraticCurveTo(canvas.width, canvas.height, canvas.width - radius, canvas.height);
  ctx.lineTo(radius, canvas.height);
  ctx.quadraticCurveTo(0, canvas.height, 0, canvas.height - radius);
  ctx.lineTo(0, radius);
  ctx.quadraticCurveTo(0, 0, radius, 0);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  const title = String(overlay.fields.title ?? "Title");
  const subtitle = String(overlay.fields.subtitle ?? "Subtitle");

  ctx.fillStyle = "#f5f2ea";
  ctx.font = "bold 32px Trebuchet MS";
  ctx.fillText(title, 24, 48);
  ctx.fillStyle = "#d1c7b8";
  ctx.font = "20px Trebuchet MS";
  ctx.fillText(subtitle, 24, 88);

  return canvas;
}

function renderArrowCanvas(overlay: Overlay): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(overlay.rect.w));
  canvas.height = Math.max(1, Math.floor(overlay.rect.h));
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const w = canvas.width;
  const h = canvas.height;
  const angle = ((overlay.rotationDeg ?? 0) * Math.PI) / 180;

  ctx.translate(w / 2, h / 2);
  ctx.rotate(angle);
  ctx.translate(-w / 2, -h / 2);

  ctx.fillStyle = "rgba(247, 179, 91, 0.95)";
  ctx.beginPath();
  ctx.moveTo(w * 0.1, h * 0.3);
  ctx.lineTo(w * 0.7, h * 0.3);
  ctx.lineTo(w * 0.7, h * 0.15);
  ctx.lineTo(w * 0.95, h * 0.5);
  ctx.lineTo(w * 0.7, h * 0.85);
  ctx.lineTo(w * 0.7, h * 0.7);
  ctx.lineTo(w * 0.1, h * 0.7);
  ctx.closePath();
  ctx.fill();

  return canvas;
}

function drawOverlayPreview(
  ctx: CanvasRenderingContext2D,
  overlay: Overlay,
  currentFrame: number,
  fps: number,
  videoWidth: number
) {
  const motion = overlay.motion ?? {};
  const slideInFrames = motion.slideInFrames ?? 0;
  const slideOutFrames = motion.slideOutFrames ?? 0;
  const displayFrames = motion.displayFrames;
  const startFrame = overlay.startFrame;
  const derivedEnd =
    typeof displayFrames === "number"
      ? startFrame + slideInFrames + displayFrames + slideOutFrames
      : overlay.endFrame;
  const visStart = motion.visibleStartFrame ?? startFrame;
  const visEnd = motion.visibleEndFrame ?? derivedEnd;

  if (currentFrame < visStart || currentFrame > visEnd) return;

  let x = overlay.rect.x;
  let y = overlay.rect.y;

  if (!isArrow(overlay)) {
    const slideDir =
      motion.slideDirection ??
      overlay.rect.x + overlay.rect.w / 2 < videoWidth / 2
        ? "fromLeft"
        : "fromRight";
    const xStart = slideDir === "fromLeft" ? -overlay.rect.w : videoWidth;
    const xExit = xStart;
    const holdFrames =
      typeof displayFrames === "number"
        ? displayFrames
        : Math.max(0, visEnd - startFrame - slideInFrames - slideOutFrames);
    const slideInEnd = startFrame + slideInFrames;
    const holdEnd = slideInEnd + holdFrames;

    if (slideInFrames > 0 && currentFrame < slideInEnd) {
      const t = (currentFrame - startFrame) / slideInFrames;
      x = xStart + (overlay.rect.x - xStart) * Math.min(Math.max(t, 0), 1);
    } else if (slideOutFrames > 0 && currentFrame > holdEnd) {
      const t = (currentFrame - holdEnd) / slideOutFrames;
      x = overlay.rect.x + (xExit - overlay.rect.x) * Math.min(Math.max(t, 0), 1);
    }
  }

  const opacity = overlay.opacity ?? 1;
  let alpha = opacity;
  if (isArrow(overlay) && motion.pulsePeriodFrames) {
    const period = motion.pulsePeriodFrames;
    const minA = motion.pulseMinAlpha ?? 0.65;
    const maxA = motion.pulseMaxAlpha ?? 1.0;
    const phase = ((currentFrame - visStart) / period) * Math.PI * 2;
    alpha = minA + (maxA - minA) * (0.5 + 0.5 * Math.sin(phase));
  }

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  if (overlay.rotationDeg) {
    ctx.translate(overlay.rect.w / 2, overlay.rect.h / 2);
    ctx.rotate((overlay.rotationDeg * Math.PI) / 180);
    ctx.translate(-overlay.rect.w / 2, -overlay.rect.h / 2);
  }

  if (isArrow(overlay)) {
    const arrowCanvas = renderArrowCanvas(overlay);
    ctx.drawImage(arrowCanvas, 0, 0, overlay.rect.w, overlay.rect.h);
  } else {
    const cardCanvas = renderCardCanvas(overlay);
    ctx.drawImage(cardCanvas, 0, 0, overlay.rect.w, overlay.rect.h);
  }

  ctx.restore();
}

export default function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [videoDurationSec, setVideoDurationSec] = useState(0);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [renderOptions, setRenderOptions] = useState({ speed: 1 as 1 | 2, includeSlug: false });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const fps = useMemo(() => getFps(project), [project]);
  const totalFrames = useMemo(() => {
    if (project?.video.durationMs) {
      return Math.max(1, Math.floor((project.video.durationMs / 1000) * fps));
    }
    return Math.max(1, Math.floor(videoDurationSec * fps));
  }, [project, fps, videoDurationSec]);

  const selectedOverlay =
    project?.overlays.find((overlay) => overlay.id === selectedOverlayId) ?? null;

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

  useEffect(() => {
    if (!selectedId) {
      setProject(null);
      return;
    }
    getProject(selectedId)
      .then((data) => {
        setProject(data);
        if (!selectedOverlayId && data.overlays.length) {
          setSelectedOverlayId(data.overlays[0].id);
        }
      })
      .catch((error) => setStatus((error as Error).message));
  }, [selectedId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !project) return;
    canvas.width = project.video.width;
    canvas.height = project.video.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const overlays = [...project.overlays].sort((a, b) => a.zIndex - b.zIndex);
    overlays.forEach((overlay) => {
      drawOverlayPreview(ctx, overlay, currentFrame, fps, project.video.width);
    });
  }, [project, currentFrame, fps]);

  useEffect(() => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = currentFrame / fps;
  }, [currentFrame, fps]);

  async function handleCreate() {
    if (!nameInput.trim()) return;
    setStatus("Creating project...");
    try {
      const created = await createProject(nameInput.trim());
      setNameInput("");
      await refreshProjects(created.id);
      setStatus(`Created ${created.name}.`);
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
      await importVideo(selectedId, file);
      await refreshProjects(selectedId);
      const updated = await getProject(selectedId);
      setProject(updated);
      setStatus(`Imported ${file.name}.`);
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  function updateProjectState(next: Project) {
    setProject(next);
    if (!selectedOverlayId && next.overlays.length) {
      setSelectedOverlayId(next.overlays[0].id);
    }
  }

  function updateOverlay(id: string, patch: Partial<Overlay>) {
    if (!project) return;
    const overlays = project.overlays.map((overlay) =>
      overlay.id === id ? { ...overlay, ...patch } : overlay
    );
    updateProjectState({ ...project, overlays });
  }

  function updateOverlayMotion(id: string, patch: Partial<Overlay["motion"]>) {
    if (!project) return;
    const overlays = project.overlays.map((overlay) => {
      if (overlay.id !== id) return overlay;
      return { ...overlay, motion: { ...overlay.motion, ...patch } };
    });
    updateProjectState({ ...project, overlays });
  }

  function addOverlayCard() {
    if (!project) return;
    const id = crypto.randomUUID();
    const start = currentFrame;
    const end = start + Math.floor(fps * 5);
    const overlay: Overlay = {
      id,
      templateId: "card-basic",
      templateVersion: "1",
      startFrame: start,
      endFrame: end,
      rect: {
        x: 80,
        y: 80,
        w: DEFAULT_CARD_SIZE.w,
        h: DEFAULT_CARD_SIZE.h,
      },
      rotationDeg: 0,
      opacity: 1,
      zIndex: project.overlays.length,
      fields: { title: "Title", subtitle: "Subtitle" },
      motion: {
        slideInFrames: 12,
        displayFrames: Math.floor(fps * 3),
        slideOutFrames: 12,
        slideDirection: "fromLeft",
      },
    };
    updateProjectState({ ...project, overlays: [...project.overlays, overlay] });
    setSelectedOverlayId(id);
  }

  function addOverlayArrow() {
    if (!project) return;
    const id = crypto.randomUUID();
    const start = currentFrame;
    const end = start + Math.floor(fps * 2);
    const overlay: Overlay = {
      id,
      templateId: "arrow-basic",
      templateVersion: "1",
      startFrame: start,
      endFrame: end,
      rect: {
        x: 320,
        y: 240,
        w: DEFAULT_ARROW_SIZE.w,
        h: DEFAULT_ARROW_SIZE.h,
      },
      rotationDeg: 0,
      opacity: 1,
      zIndex: project.overlays.length,
      fields: {},
      motion: {
        visibleStartFrame: start,
        visibleEndFrame: end,
        pulsePeriodFrames: Math.floor(fps * 0.8),
        pulseMinAlpha: 0.65,
        pulseMaxAlpha: 1,
      },
    };
    updateProjectState({ ...project, overlays: [...project.overlays, overlay] });
    setSelectedOverlayId(id);
  }

  async function handleSaveProject() {
    if (!project || !selectedId) return;
    setStatus("Saving project...");
    try {
      const saved = await updateProject(selectedId, project);
      updateProjectState(saved);
      await refreshProjects(selectedId);
      setStatus("Project saved.");
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  async function renderAssetsForProject(current: Project) {
    for (const overlay of current.overlays) {
      const canvas = isArrow(overlay) ? renderArrowCanvas(overlay) : renderCardCanvas(overlay);
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((result) => resolve(result), "image/png");
      });
      if (!blob) {
        throw new Error(`Failed to render asset for ${overlay.id}`);
      }
      await uploadAsset(current.id, isArrow(overlay) ? "arrows" : "overlays", overlay.id, blob);
    }
  }

  async function handleRenderFinal() {
    if (!project || !selectedId) return;
    setStatus("Rendering assets...");
    try {
      await handleSaveProject();
      await renderAssetsForProject(project);
      setStatus("Running FFmpeg render...");
      const result = await renderProject(selectedId, renderOptions);
      setStatus(`Render complete: ${JSON.stringify(result)}`);
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  return (
    <main>
      <h1>Content Tools Studio</h1>
      <p className="subtitle">
        Upload footage, scrub frames, place overlay cards and arrows, and render a final
        cut directly into the workspace exports folder.
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
            {projects.map((proj) => (
              <li className="project-card" key={proj.id}>
                <div>
                  <strong>{proj.name}</strong>
                  <div className="details">{proj.id}</div>
                </div>
                <button onClick={() => setSelectedId(proj.id)}>Select</button>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <h2>Video</h2>
          <div className="details">
            {project ? `Selected: ${project.name}` : "Select a project to attach media."}
          </div>
          {project && (
            <div className="details">
              Source: {project.source.filename || "—"}
              <br />
              Video: {project.video.width}×{project.video.height} @ {fps.toFixed(2)} fps
            </div>
          )}
          <div className="actions">
            <input
              type="file"
              accept="video/*"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleImport(file);
              }}
            />
          </div>
          {project && project.source.filename && (
            <div className="video-wrapper">
              <video
                ref={videoRef}
                src={mediaUrl(project.id)}
                className="video-preview"
                controls
                onLoadedMetadata={(event) => {
                  setVideoDurationSec((event.target as HTMLVideoElement).duration || 0);
                }}
                onTimeUpdate={(event) => {
                  const time = (event.target as HTMLVideoElement).currentTime;
                  setCurrentFrame(formatFrame(time * fps));
                }}
              />
              <canvas ref={canvasRef} className="overlay-canvas" />
            </div>
          )}
          {project && (
            <div className="scrubber">
              <label htmlFor="frame">Frame scrubber</label>
              <input
                id="frame"
                type="range"
                min={0}
                max={Math.max(1, totalFrames - 1)}
                value={currentFrame}
                onChange={(event) => setCurrentFrame(Number(event.target.value))}
              />
              <div className="details">
                Frame {currentFrame} / {totalFrames}
              </div>
            </div>
          )}
        </section>

        <section className="panel">
          <h2>Overlays</h2>
          <div className="actions">
            <button onClick={addOverlayCard} disabled={!project}>
              Add card
            </button>
            <button onClick={addOverlayArrow} disabled={!project}>
              Add arrow
            </button>
            <button className="secondary" onClick={handleSaveProject} disabled={!project}>
              Save project
            </button>
          </div>

          {project && (
            <ul className="overlay-list">
              {project.overlays.map((overlay) => (
                <li
                  key={overlay.id}
                  className={overlay.id === selectedOverlayId ? "overlay-item active" : "overlay-item"}
                >
                  <button className="secondary" onClick={() => setSelectedOverlayId(overlay.id)}>
                    {overlay.templateId}
                  </button>
                  <div className="details">{overlay.id}</div>
                </li>
              ))}
            </ul>
          )}

          {project && selectedOverlay && (
            <div className="overlay-editor">
              <h3>Edit overlay</h3>
              <label>Start frame</label>
              <div className="actions">
                <input
                  type="number"
                  value={selectedOverlay.startFrame}
                  onChange={(event) =>
                    updateOverlay(selectedOverlay.id, {
                      startFrame: Number(event.target.value),
                    })
                  }
                />
                <button
                  className="secondary"
                  onClick={() =>
                    updateOverlay(selectedOverlay.id, { startFrame: currentFrame })
                  }
                >
                  Set to current
                </button>
              </div>

              <label>End frame</label>
              <div className="actions">
                <input
                  type="number"
                  value={selectedOverlay.endFrame}
                  onChange={(event) =>
                    updateOverlay(selectedOverlay.id, {
                      endFrame: Number(event.target.value),
                    })
                  }
                />
                <button
                  className="secondary"
                  onClick={() =>
                    updateOverlay(selectedOverlay.id, { endFrame: currentFrame })
                  }
                >
                  Set to current
                </button>
              </div>

              <label>Position (x, y)</label>
              <div className="actions">
                <input
                  type="number"
                  value={selectedOverlay.rect.x}
                  onChange={(event) =>
                    updateOverlay(selectedOverlay.id, {
                      rect: { ...selectedOverlay.rect, x: Number(event.target.value) },
                    })
                  }
                />
                <input
                  type="number"
                  value={selectedOverlay.rect.y}
                  onChange={(event) =>
                    updateOverlay(selectedOverlay.id, {
                      rect: { ...selectedOverlay.rect, y: Number(event.target.value) },
                    })
                  }
                />
              </div>

              <label>Size (w, h)</label>
              <div className="actions">
                <input
                  type="number"
                  value={selectedOverlay.rect.w}
                  onChange={(event) =>
                    updateOverlay(selectedOverlay.id, {
                      rect: { ...selectedOverlay.rect, w: Number(event.target.value) },
                    })
                  }
                />
                <input
                  type="number"
                  value={selectedOverlay.rect.h}
                  onChange={(event) =>
                    updateOverlay(selectedOverlay.id, {
                      rect: { ...selectedOverlay.rect, h: Number(event.target.value) },
                    })
                  }
                />
              </div>

              {!isArrow(selectedOverlay) && (
                <>
                  <label>Title</label>
                  <input
                    type="text"
                    value={String(selectedOverlay.fields.title ?? "")}
                    onChange={(event) =>
                      updateOverlay(selectedOverlay.id, {
                        fields: { ...selectedOverlay.fields, title: event.target.value },
                      })
                    }
                  />
                  <label>Subtitle</label>
                  <input
                    type="text"
                    value={String(selectedOverlay.fields.subtitle ?? "")}
                    onChange={(event) =>
                      updateOverlay(selectedOverlay.id, {
                        fields: { ...selectedOverlay.fields, subtitle: event.target.value },
                      })
                    }
                  />
                  <label>Slide-in frames</label>
                  <input
                    type="number"
                    value={selectedOverlay.motion?.slideInFrames ?? 0}
                    onChange={(event) =>
                      updateOverlayMotion(selectedOverlay.id, {
                        slideInFrames: Number(event.target.value),
                      })
                    }
                  />
                  <label>Display frames</label>
                  <input
                    type="number"
                    value={selectedOverlay.motion?.displayFrames ?? 0}
                    onChange={(event) =>
                      updateOverlayMotion(selectedOverlay.id, {
                        displayFrames: Number(event.target.value),
                      })
                    }
                  />
                  <label>Slide-out frames</label>
                  <input
                    type="number"
                    value={selectedOverlay.motion?.slideOutFrames ?? 0}
                    onChange={(event) =>
                      updateOverlayMotion(selectedOverlay.id, {
                        slideOutFrames: Number(event.target.value),
                      })
                    }
                  />
                </>
              )}

              {isArrow(selectedOverlay) && (
                <>
                  <label>Rotation (deg)</label>
                  <input
                    type="number"
                    value={selectedOverlay.rotationDeg ?? 0}
                    onChange={(event) =>
                      updateOverlay(selectedOverlay.id, {
                        rotationDeg: Number(event.target.value),
                      })
                    }
                  />
                  <label>Pulse period (frames)</label>
                  <input
                    type="number"
                    value={selectedOverlay.motion?.pulsePeriodFrames ?? 0}
                    onChange={(event) =>
                      updateOverlayMotion(selectedOverlay.id, {
                        pulsePeriodFrames: Number(event.target.value),
                      })
                    }
                  />
                  <label>Visible start frame</label>
                  <input
                    type="number"
                    value={selectedOverlay.motion?.visibleStartFrame ?? selectedOverlay.startFrame}
                    onChange={(event) =>
                      updateOverlayMotion(selectedOverlay.id, {
                        visibleStartFrame: Number(event.target.value),
                      })
                    }
                  />
                  <label>Visible end frame</label>
                  <input
                    type="number"
                    value={selectedOverlay.motion?.visibleEndFrame ?? selectedOverlay.endFrame}
                    onChange={(event) =>
                      updateOverlayMotion(selectedOverlay.id, {
                        visibleEndFrame: Number(event.target.value),
                      })
                    }
                  />
                </>
              )}
            </div>
          )}
        </section>

        <section className="panel">
          <h2>Render</h2>
          <label htmlFor="speed">Speed</label>
          <select
            id="speed"
            value={renderOptions.speed}
            onChange={(event) =>
              setRenderOptions((prev) => ({
                ...prev,
                speed: Number(event.target.value) as 1 | 2,
              }))
            }
          >
            <option value={1}>1× (normal)</option>
            <option value={2}>2× (fast)</option>
          </select>

          <label htmlFor="slug" style={{ marginTop: "12px" }}>
            Include slug intro/outro
          </label>
          <select
            id="slug"
            value={renderOptions.includeSlug ? "yes" : "no"}
            onChange={(event) =>
              setRenderOptions((prev) => ({
                ...prev,
                includeSlug: event.target.value === "yes",
              }))
            }
          >
            <option value="no">No slug</option>
            <option value="yes">Include slug</option>
          </select>

          <div className="actions">
            <button onClick={handleRenderFinal} disabled={!project}>
              Render final output
            </button>
          </div>
        </section>
      </div>

      {status && <div className="status">{status}</div>}
    </main>
  );
}
