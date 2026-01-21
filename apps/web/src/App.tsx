import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import type { Group as KonvaGroup } from "konva/lib/Group";
import type { Transformer as KonvaTransformer } from "konva/lib/shapes/Transformer";
import { Arrow, Group, Layer, Rect, Stage, Text, Transformer } from "react-konva";
import {
  createProject,
  getProject,
  importVideo,
  listProjects,
  mediaUrl,
  renderStreamUrl,
  thumbnailUrl,
  updateProject,
  type Overlay,
  type Project,
  type ProjectSummary,
} from "./api";

const DEFAULT_CARD_SIZE = { w: 720, h: 160 };
const DEFAULT_ARROW_SIZE = { w: 128, h: 128 };

const CARD_TEMPLATES = [
  { id: "card-lower-third-left", label: "Lower Third Left" },
  { id: "card-lower-third-right", label: "Lower Third Right" },
  { id: "card-lower-third-center", label: "Lower Third Center" },
  { id: "card-top-third-left", label: "Top Third Left" },
  { id: "card-top-third-right", label: "Top Third Right" },
  { id: "card-title-top", label: "Title Top" },
  { id: "card-callout-right", label: "Callout Right" },
  { id: "card-chapter-center", label: "Chapter Center" },
  { id: "card-corner-tag-top-right", label: "Corner Tag Top Right" },
  { id: "card-bug-bottom-right", label: "Bug Bottom Right" },
];

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

type StageMetrics = {
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
};

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
  const [renderProgress, setRenderProgress] = useState<number | null>(null);
  const [leftTab, setLeftTab] = useState<"media" | "overlays" | "exports">("media");

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRefs = useRef<Record<string, KonvaGroup>>({});
  const transformerRef = useRef<KonvaTransformer | null>(null);
  const videoWrapperRef = useRef<HTMLDivElement | null>(null);
  const [stageMetrics, setStageMetrics] = useState<StageMetrics>({
    width: 0,
    height: 0,
    scaleX: 1,
    scaleY: 1,
  });

  const fps = useMemo(() => getFps(project), [project]);
  const totalFrames = useMemo(() => {
    if (project?.video.durationMs) {
      return Math.max(1, Math.floor((project.video.durationMs / 1000) * fps));
    }
    return Math.max(1, Math.floor(videoDurationSec * fps));
  }, [project, fps, videoDurationSec]);

  const selectedOverlay =
    project?.overlays.find((overlay) => overlay.id === selectedOverlayId) ?? null;

  const thumbnailFrames = useMemo(() => {
    const count = 8;
    return Array.from({ length: count }, (_: unknown, index: number) =>
      Math.floor((index / Math.max(1, count - 1)) * (totalFrames - 1))
    );
  }, [totalFrames]);

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
      .then((data: Project) => {
        setProject(data);
        if (!selectedOverlayId && data.overlays.length) {
          setSelectedOverlayId(data.overlays[0].id);
        }
      })
      .catch((error: unknown) => setStatus((error as Error).message));
  }, [selectedId]);

  useLayoutEffect(() => {
    if (!project || !videoRef.current) return;
    const element = videoRef.current;

    const update = () => {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const scaleX = rect.width / project.video.width;
      const scaleY = rect.height / project.video.height;
      setStageMetrics({ width: rect.width, height: rect.height, scaleX, scaleY });
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [project]);

  useEffect(() => {
    if (!transformerRef.current) return;
    if (!selectedOverlayId || !selectedOverlay || isArrow(selectedOverlay)) {
      transformerRef.current.nodes([]);
      transformerRef.current.getLayer()?.batchDraw();
      return;
    }
    const node = overlayRefs.current[selectedOverlayId];
    if (node) {
      transformerRef.current.nodes([node]);
      transformerRef.current.getLayer()?.batchDraw();
    }
  }, [selectedOverlayId, selectedOverlay, stageMetrics]);

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
    const overlays = project.overlays.map((overlay: Overlay) =>
      overlay.id === id ? { ...overlay, ...patch } : overlay
    );
    updateProjectState({ ...project, overlays });
  }

  function updateOverlayMotion(id: string, patch: Partial<Overlay["motion"]>) {
    if (!project) return;
    const overlays = project.overlays.map((overlay: Overlay) => {
      if (overlay.id !== id) return overlay;
      return { ...overlay, motion: { ...overlay.motion, ...patch } };
    });
    updateProjectState({ ...project, overlays });
  }

  function createCardOverlay(templateId: string, x: number, y: number) {
    if (!project) return;
    const id = crypto.randomUUID();
    const start = currentFrame;
    const end = start + Math.floor(fps * 5);
    const overlay: Overlay = {
      id,
      templateId,
      templateVersion: "1",
      startFrame: start,
      endFrame: end,
      rect: {
        x,
        y,
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

  function createArrowOverlay(x: number, y: number) {
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
        x,
        y,
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

  function addOverlayCard() {
    createCardOverlay("card-lower-third-left", 80, 80);
  }

  function addOverlayArrow() {
    createArrowOverlay(320, 240);
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

  async function handleRenderFinal() {
    if (!project || !selectedId) return;
    setStatus("Starting render...");
    setRenderProgress(0);
    try {
      await handleSaveProject();
      const es = new EventSource(renderStreamUrl(selectedId, renderOptions));
      es.addEventListener("progress", (event) => {
        const data = JSON.parse((event as MessageEvent).data) as {
          stage: string;
          message?: string;
          percent?: number;
        };
        if (typeof data.percent === "number") {
          setRenderProgress(data.percent);
        }
        if (data.message) {
          setStatus(`[${data.stage}] ${data.message}`);
        }
      });
      es.addEventListener("done", (event) => {
        const data = JSON.parse((event as MessageEvent).data) as { message: string };
        setStatus(`Render complete: ${data.message}`);
        setRenderProgress(1);
        es.close();
      });
      es.addEventListener("error", (event) => {
        setStatus(`Render error: ${(event as MessageEvent).data || "unknown"}`);
        es.close();
      });
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  function handleDragStart(type: "card" | "arrow", templateId?: string) {
    return (event: DragEvent) => {
      const payload = JSON.stringify({ type, templateId });
      event.dataTransfer.setData("text/plain", payload);
    };
  }

  function handleDragOver(event: DragEvent) {
    event.preventDefault();
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    if (!project || !videoWrapperRef.current) return;
    const payload = event.dataTransfer.getData("text/plain");
    if (!payload) return;
    try {
      const data = JSON.parse(payload) as { type: "card" | "arrow"; templateId?: string };
      const rect = videoWrapperRef.current.getBoundingClientRect();
      const dropX = event.clientX - rect.left;
      const dropY = event.clientY - rect.top;
      const x = dropX / stageMetrics.scaleX - DEFAULT_CARD_SIZE.w / 2;
      const y = dropY / stageMetrics.scaleY - DEFAULT_CARD_SIZE.h / 2;
      if (data.type === "card") {
        createCardOverlay(data.templateId ?? "card-lower-third-left", Math.max(0, x), Math.max(0, y));
      } else {
        const arrowX = dropX / stageMetrics.scaleX - DEFAULT_ARROW_SIZE.w / 2;
        const arrowY = dropY / stageMetrics.scaleY - DEFAULT_ARROW_SIZE.h / 2;
        createArrowOverlay(Math.max(0, arrowX), Math.max(0, arrowY));
      }
    } catch {
      return;
    }
  }

  function renderCardShape(overlay: Overlay) {
    const scaleX = stageMetrics.scaleX;
    const scaleY = stageMetrics.scaleY;
    const width = overlay.rect.w * scaleX;
    const height = overlay.rect.h * scaleY;
    const x = overlay.rect.x * scaleX;
    const y = overlay.rect.y * scaleY;

    return (
      <Group
        key={overlay.id}
        ref={(node) => {
          if (node) overlayRefs.current[overlay.id] = node;
        }}
        x={x}
        y={y}
        draggable
        onClick={() => setSelectedOverlayId(overlay.id)}
        onTap={() => setSelectedOverlayId(overlay.id)}
        onDragEnd={(event) => {
          const node = event.target;
          updateOverlay(overlay.id, {
            rect: {
              ...overlay.rect,
              x: node.x() / scaleX,
              y: node.y() / scaleY,
            },
          });
        }}
        onTransformEnd={(event) => {
          const node = event.target;
          const scaleXNode = node.scaleX();
          const scaleYNode = node.scaleY();
          const newWidth = Math.max(20, overlay.rect.w * scaleXNode);
          const newHeight = Math.max(20, overlay.rect.h * scaleYNode);
          node.scaleX(1);
          node.scaleY(1);
          updateOverlay(overlay.id, {
            rect: {
              x: node.x() / scaleX,
              y: node.y() / scaleY,
              w: newWidth,
              h: newHeight,
            },
          });
        }}
      >
        <Rect
          width={width}
          height={height}
          fill="rgba(15, 19, 24, 0.65)"
          stroke={overlay.id === selectedOverlayId ? "#f7b35b" : "rgba(255,255,255,0.2)"}
          cornerRadius={12}
        />
        <Text
          text={String(overlay.fields.title ?? "")}
          fontSize={Math.max(14, height * 0.3)}
          fill="#f5f2ea"
          x={16}
          y={Math.max(8, height * 0.18)}
          width={width - 24}
        />
        <Text
          text={String(overlay.fields.subtitle ?? "")}
          fontSize={Math.max(12, height * 0.18)}
          fill="#d1c7b8"
          x={16}
          y={Math.max(8, height * 0.55)}
          width={width - 24}
        />
      </Group>
    );
  }

  function renderArrowShape(overlay: Overlay) {
    const scaleX = stageMetrics.scaleX;
    const scaleY = stageMetrics.scaleY;
    const width = overlay.rect.w * scaleX;
    const height = overlay.rect.h * scaleY;
    const centerX = overlay.rect.x * scaleX + width / 2;
    const centerY = overlay.rect.y * scaleY + height / 2;
    const pointerLength = Math.min(width * 0.3, 48);
    const pointerWidth = Math.min(height * 0.6, 48);

    return (
      <Arrow
        key={overlay.id}
        x={centerX}
        y={centerY}
        points={[-width / 2, 0, width / 2, 0]}
        pointerLength={pointerLength}
        pointerWidth={pointerWidth}
        fill="rgba(247, 179, 91, 0.8)"
        stroke="rgba(247, 179, 91, 0.9)"
        strokeWidth={Math.max(2, height * 0.15)}
        rotation={overlay.rotationDeg ?? 0}
        draggable
        onClick={() => setSelectedOverlayId(overlay.id)}
        onTap={() => setSelectedOverlayId(overlay.id)}
        onDragEnd={(event) => {
          const node = event.target;
          const newX = (node.x() - width / 2) / scaleX;
          const newY = (node.y() - height / 2) / scaleY;
          updateOverlay(overlay.id, {
            rect: { ...overlay.rect, x: newX, y: newY },
          });
        }}
      />
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>Content Tools Studio</h1>
          <div className="subtitle">
            Editing workspace · {project ? project.name : "Select a project"} · Frame {currentFrame}
          </div>
        </div>
        <div className="topbar-actions">
          <button className="secondary" onClick={handleSaveProject} disabled={!project}>
            Save
          </button>
          <button onClick={handleRenderFinal} disabled={!project}>
            Render final
          </button>
          {renderProgress !== null && (
            <div className="progress slim">
              <div className="progress-bar" style={{ width: `${renderProgress * 100}%` }} />
            </div>
          )}
        </div>
      </header>

      <div className="editor-grid">
        <aside className="sidebar left">
          <div className="tabs">
            {(["media", "overlays", "exports"] as const).map((tab) => (
              <button
                key={tab}
                className={leftTab === tab ? "tab active" : "tab"}
                onClick={() => setLeftTab(tab)}
              >
                {tab}
              </button>
            ))}
          </div>

          {leftTab === "media" && (
            <div className="panel-block">
              <label htmlFor="project-name">New project</label>
              <input
                id="project-name"
                type="text"
                value={nameInput}
                onChange={(event) => setNameInput(event.target.value)}
                placeholder="K1s demo walkthrough"
              />
              <div className="actions">
                <button onClick={handleCreate}>Create</button>
                <button className="secondary" onClick={() => refreshProjects()}>
                  Refresh
                </button>
              </div>

              <div className="media-section">
                <h3>Projects</h3>
                <ul className="project-list">
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
              </div>

              <div className="media-section">
                <label>Import video</label>
                <input
                  type="file"
                  accept="video/*"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void handleImport(file);
                  }}
                />
                {project && (
                  <div className="details">
                    Source: {project.source.filename || "—"}
                    <br />
                    Video: {project.video.width}×{project.video.height} @ {fps.toFixed(2)} fps
                  </div>
                )}
              </div>

              <div className="asset-section">
                <h3>Card templates</h3>
                <div className="asset-grid">
                  {CARD_TEMPLATES.map((template) => (
                    <div
                      key={template.id}
                      className="asset-card"
                      draggable
                      onDragStart={handleDragStart("card", template.id)}
                      onClick={() => createCardOverlay(template.id, 120, 120)}
                    >
                      {template.label}
                    </div>
                  ))}
                </div>
                <h3>Arrows</h3>
                <div
                  className="asset-card"
                  draggable
                  onDragStart={handleDragStart("arrow")}
                  onClick={() => createArrowOverlay(320, 240)}
                >
                  Directional Arrow
                </div>
              </div>
            </div>
          )}

          {leftTab === "overlays" && (
            <div className="panel-block">
              <div className="actions">
                <button onClick={addOverlayCard} disabled={!project}>
                  Add card
                </button>
                <button onClick={addOverlayArrow} disabled={!project}>
                  Add arrow
                </button>
              </div>
              {project && (
                <ul className="overlay-list">
                  {project.overlays.map((overlay: Overlay) => (
                    <li
                      key={overlay.id}
                      className={overlay.id === selectedOverlayId ? "overlay-item active" : "overlay-item"}
                    >
                      <button className="secondary" onClick={() => setSelectedOverlayId(overlay.id)}>
                        {overlay.templateId}
                      </button>
                      <div className="details">
                        {overlay.startFrame} → {overlay.endFrame}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {leftTab === "exports" && (
            <div className="panel-block">
              <div className="details">Final renders live in workspace exports folder.</div>
              <div className="actions">
                <button onClick={handleRenderFinal} disabled={!project}>
                  Render final
                </button>
              </div>
            </div>
          )}
        </aside>

        <section className="editor-center">
          <div
            className="preview-pane"
            ref={videoWrapperRef}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            {project && project.source.filename ? (
              <>
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
                {stageMetrics.width > 0 && (
                  <Stage
                    width={stageMetrics.width}
                    height={stageMetrics.height}
                    className="overlay-stage"
                  >
                    <Layer>
                      {project.overlays.map((overlay: Overlay) =>
                        isArrow(overlay) ? renderArrowShape(overlay) : renderCardShape(overlay)
                      )}
                      <Transformer
                        ref={transformerRef}
                        rotateEnabled={false}
                        keepRatio={false}
                        boundBoxFunc={(oldBox, newBox) => {
                          if (newBox.width < 40 || newBox.height < 20) return oldBox;
                          return newBox;
                        }}
                      />
                    </Layer>
                  </Stage>
                )}
              </>
            ) : (
              <div className="preview-placeholder">Import a video to start editing</div>
            )}
          </div>

          <div className="playback-bar">
            <button
              className="secondary"
              onClick={() => setCurrentFrame((prev) => Math.max(0, prev - 1))}
            >
              ◀︎ Frame
            </button>
            <button
              className="secondary"
              onClick={() => setCurrentFrame((prev) => Math.min(totalFrames - 1, prev + 1))}
            >
              Frame ▶︎
            </button>
            <div className="details">
              {project ? project.source.filename : "No media"} · {currentFrame} / {totalFrames}
            </div>
          </div>
        </section>

        <aside className="sidebar right">
          <div className="panel-block">
            <h3>Inspector</h3>
            {project && selectedOverlay && (
              <>
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
                    Use playhead
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
                    Use playhead
                  </button>
                </div>

                {!isArrow(selectedOverlay) && (
                  <>
                    <label>Template</label>
                    <select
                      value={selectedOverlay.templateId}
                      onChange={(event) =>
                        updateOverlay(selectedOverlay.id, { templateId: event.target.value })
                      }
                    >
                      {CARD_TEMPLATES.map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.label}
                        </option>
                      ))}
                    </select>
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
              </>
            )}
            {!selectedOverlay && <div className="details">Select an overlay to edit.</div>}
          </div>

          <div className="panel-block">
            <h3>Render settings</h3>
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

            <label htmlFor="slug">Include slug intro/outro</label>
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
          </div>
        </aside>
      </div>

      <section className="timeline">
        <div className="scrubber">
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
        <div className="thumbnail-strip">
          {project &&
            thumbnailFrames.map((frame: number) => (
              <img
                key={frame}
                src={thumbnailUrl(project.id, frame, 180)}
                alt={`Frame ${frame}`}
                className={frame === currentFrame ? "thumbnail active" : "thumbnail"}
                onClick={() => setCurrentFrame(frame)}
              />
            ))}
        </div>
        {project && (
          <div className="track-list">
            <div className="track-row">
              <div className="track-label">Video</div>
              <div className="track-lane">
                <div className="track-clip full">Source</div>
              </div>
            </div>
            <div className="track-row">
              <div className="track-label">Cards</div>
              <div className="track-lane">
                {project.overlays
                  .filter((overlay) => !isArrow(overlay))
                  .map((overlay) => {
                    const left = (overlay.startFrame / totalFrames) * 100;
                    const width = ((overlay.endFrame - overlay.startFrame) / totalFrames) * 100;
                    return (
                      <div
                        key={overlay.id}
                        className="track-clip card"
                        style={{ left: `${left}%`, width: `${Math.max(2, width)}%` }}
                        onClick={() => setSelectedOverlayId(overlay.id)}
                      >
                        {overlay.templateId}
                      </div>
                    );
                  })}
              </div>
            </div>
            <div className="track-row">
              <div className="track-label">Arrows</div>
              <div className="track-lane">
                {project.overlays
                  .filter((overlay) => isArrow(overlay))
                  .map((overlay) => {
                    const left = (overlay.startFrame / totalFrames) * 100;
                    const width = ((overlay.endFrame - overlay.startFrame) / totalFrames) * 100;
                    return (
                      <div
                        key={overlay.id}
                        className="track-clip arrow"
                        style={{ left: `${left}%`, width: `${Math.max(2, width)}%` }}
                        onClick={() => setSelectedOverlayId(overlay.id)}
                      >
                        Arrow
                      </div>
                    );
                  })}
              </div>
            </div>
          </div>
        )}
      </section>

      {status && <div className="status">{status}</div>}
    </div>
  );
}
