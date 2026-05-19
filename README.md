# C&M Content Tools

Local-first video annotation and rendering pipeline for screencast overlays. Import MP4 footage, scrub frames, place branded cards and directional arrows, trim/cut sections, and render a final MP4 directly into a workspace export folder with FFmpeg.

<p>
  <a href="https://github.com/the-cm-collective/k1s-workerbee">
    <img src="https://raw.githubusercontent.com/the-cm-collective/k1s-workerbee/dev/docs/assets/k1s-workerbee-hero.jpg" alt="K1S WorkerBee" width="140">
  </a>
</p>

Optimized for [K1S WorkerBee](https://github.com/the-cm-collective/k1s-workerbee): the app is built to redeploy, probe, render, export, and restore editable video projects inside a project-scoped k1s workbench.

---

## What this app does

**C&M Content Tools** is a desktop-style web editor built for precise overlay work on screen recordings:

- Create/select/delete local projects and keep all edits in a workspace folder.
- Import MP4 footage and scrub frame-by-frame with thumbnails and a track view.
- Place branded overlay cards and directional arrows on exact frames.
- Configure per-overlay timing, animation, and layout settings.
- Trim a clip (start/end) and cut out arbitrary sections.
- Compose source timelines from shorthand recipes that mix video slices, speed changes, and still PNG slugs.
- Overlay or replace audio with uploaded or URL-imported audio tracks, including tail fade-out.
- Optionally prepend/append a slug clip.
- Render the final MP4 via FFmpeg and track progress in the UI.
- Download the final export or copy its full filesystem path.

---

## Key features

### Editing
- **Frame scrubber** with thumbnails, frame stepping, and a playhead line across track rows.
- **Canvas overlays** (cards + arrows) with drag/resize and per-frame anchoring.
- **Arrow tools** with free rotation on-canvas, plus 45° rotate buttons.
- **Text controls** per overlay: Title/Text sizes, text alignment, text margins, and vertical offsets.
- **Timeline tracks** for video/cards/arrows with highlighted cut sections.
- **Autosave** enabled by default, with a configurable interval and an off switch.
- **Undo/redo** (Ctrl+Z / Ctrl+Y) and delete selected overlays with Delete.

### Rendering
- Generates editor-matched overlay and arrow PNG assets, with a server fallback for API-only renders.
- Builds `filter_complex` scripts for FFmpeg.
- Runs FFmpeg server-side and writes `final.mp4` into the project export folder.
- Streams FFmpeg output into the UI for troubleshooting.
- Optional **slug intro/outro** concatenation.

---

## Hotkeys

- **Ctrl+Z**: Undo
- **Ctrl+Y**: Redo
- **Delete**: Remove selected overlay/arrow
- **Ctrl+/**: Toggle hotkey cheat sheet
- **Esc**: Close hotkey cheat sheet

---

## Architecture

**Frontend** (`apps/web`)
- React + Vite + TypeScript
- Konva canvas for interactive overlays

**Backend** (`apps/server`)
- Fastify API for projects, uploads, thumbnails, and exports
- FFmpeg/FFprobe for media inspection and rendering
- Sharp fallback for overlay/arrow PNG generation when no editor-rasterized assets exist

**Shared** (`packages/shared`)
- Zod schemas and shared types

---

## Repo layout

```
.
├── apps/
│   ├── server/            # Fastify backend
│   └── web/               # React UI (Vite)
├── packages/
│   └── shared/            # Types + Zod schemas
├── workspace/             # Local projects (gitignored)
├── 1920x1080/             # Card template assets
├── k1s-directional-arrows/# Arrow assets
├── slug/                  # Slug/intro/outro clips
├── docs/                  # API and automation notes
├── CONTENT-PIPELINE.md    # High-level pipeline plan
└── CONTENT-TOOLS-APP.md   # Detailed app spec + pipeline notes
```

---

## Workspace layout (per project)

```
workspace/<projectId>/
  project.json
  media/
    <source>.mp4
  render/
    overlays/
      <overlayId>.png
    arrows/
      <arrowId>.png
  exports/
    <timestamp>/
      filter_complex_cards.txt
      filter_complex_cards_arrows.txt
      manifest.json
      README.md
      main_noslug.mp4
      main_noslug_arrows.mp4
      final_with_slug.mp4
      final.mp4
```

---

## Requirements

- **Node.js 20+** (tested with Node 22)
- **FFmpeg + FFprobe** installed and available on PATH
- Optional: **K1S WorkerBee** for local k1s deployment, HTTPS ingress, probes, logs, security review, and project-scoped render validation.

Optional environment variables:

- `WORKSPACE_ROOT` (default: `<repo>/workspace`)
- `FFMPEG_PATH` (default: `ffmpeg`)
- `FFPROBE_PATH` (default: `ffprobe`)
- `HOST` (default: `127.0.0.1`)
- `PORT` (default: `3033`)

### WorkerBee runtime

WorkerBee is the preferred local deployment loop for this project. It builds the app image, applies the repo manifests, exposes the UI through `*.workerbee.localhost`, and gives agents bounded tools for deploy, logs, probes, exports, and cleanup.

Typical WorkerBee flow:

```bash
workerbee mcp start
codex mcp add workerbee --url http://127.0.0.1:8765/mcp
```

Then ask the agent to bring the stack up in WorkerBee. The app should be validated through the WorkerBee HTTPS URL and the OpenAPI document at `/openapi.json`.

#### WorkerBee GPU/NVENC

The default WorkerBee manifest stays CPU-only. For NVIDIA hosts, use the opt-in GPU manifest in `deploy/workerbee/manifests-gpu/`. It requests exactly one GPU with `runtimeClassName: nvidia`, matching `nvidia.com/gpu` requests/limits, and `nodeSelector: gpu.present=true`.

Before using the GPU manifest, the host/container runtime should make `nvidia-smi`, `/dev/nvidia*`, `nvidia-container-runtime`, and the NVIDIA encode libraries visible to the workload. The GPU manifest sets `NVIDIA_DRIVER_CAPABILITIES=compute,utility,video` so `libnvidia-encode.so.1` is injected for NVENC. The app exposes `GET /render/capabilities`; NVENC is considered available only when FFmpeg both lists `h264_nvenc` and completes a tiny real encode probe. If the probe fails, the UI disables the NVENC preset and the API rejects hardware renders with a clear error.

To seed a repeatable manual smoke project, run:

```bash
npm run seed:nvenc-smoke
```

The script creates or replaces `workspace/nvenc-smoke` with a generated 720p MP4, overlay/card assets to render, and `lastExportPresetId=nvencP5Cq20`. In the WorkerBee container it writes to `WORKSPACE_ROOT`, so the same script can be run with `node /app/scripts/seed-nvenc-smoke-project.mjs` after the app is deployed. Open the app, select **NVENC smoke test**, confirm **NVENC P5 CQ20** is available, and run a final render.

For core-proxy edge deployments, run this app on the GPU-capable edge node and expose it through the normal ingress/core-proxy path. Keep rendering physically on the edge node; core-proxy should only transport UI/API/SSE/download traffic.

#### MicroK8s remote k1s GPU test

Use `deploy/workerbee/manifests-core-proxy-gpu/` to test WorkerBee remote deploy against the `k1s-dev-a` MicroK8s dev cluster. The manifest pins the app to k1s site `host-b`, requests one NVIDIA GPU with `runtimeClassName: nvidia`, and exposes the app through `content-tools-studio.apps.k1s-dev-a.core.home.arpa`.

Before deploying, build and push the registry image referenced by the manifest:

```bash
docker build -t reg.microk8s.core.home.arpa:32000/content-tools-studio:nvenc-smoke .
docker push reg.microk8s.core.home.arpa:32000/content-tools-studio:nvenc-smoke
```

Then stage the manifest with WorkerBee, validate it, and deploy the returned stage with `workerbee_v1_manifest_deploy_remote_k1s`. The remote deploy tool needs the controller apply API on port `9108`, not the externally exposed node/agent API on `9110`; for this dev cluster, port-forward the controller API and use the forwarded URL:

```bash
kubectl -n k1s-dev-a port-forward --address 127.0.0.1 pod/<controller-pod> 19118:9108
```

Use `server=http://127.0.0.1:19118`, namespace `content-tools-studio-gpu-dev`, and the `apishim-admin-token` from the `k1s-dev-a-k1s-core-ha-auth` secret. The controller must have mutations enabled with `AE_API_MUTATIONS=1` and an `AE_API_ADMIN_TOKEN` matching that token. Validate the route through the core ingress and refresh `/render/capabilities` to confirm NVENC.

### Podman on macOS

Podman works through a Linux VM on macOS, so give the machine enough resources for FFmpeg renders and image builds before deploying through WorkerBee.

```bash
brew install podman
podman machine init --cpus 6 --memory 12288 --disk-size 80
podman machine start
podman system connection list
```

Best-effort macOS notes:

- Increase CPU, memory, and disk if final renders or image builds are killed under load.
- Keep the repo under a path shared with the Podman machine.
- If a tool expects Docker-compatible access, enable or export the Podman socket for that shell.
- Trust the WorkerBee local CA in the browser or OS trust store when testing HTTPS ingress.
- File sharing and VM I/O can be slower than native Linux; prefer WorkerBee probes and server logs when diagnosing render failures.

---

## Getting started

Install dependencies:

```bash
npm install
```

Run all dev processes (shared package watcher, backend, UI):

```bash
npm run dev:all
```

Then open:

- Web UI: `http://localhost:5173`
- API server: `http://localhost:3033`

Build all packages:

```bash
npm run build
```

### NixOS development

This repository includes a project-local Nix flake for a reproducible development toolchain. It provides Node.js 22, npm, FFmpeg/FFprobe, and native build tools while leaving `node_modules` managed by npm.

With direnv:

```bash
direnv allow
npm ci
npm run dev:all
```

Without direnv:

```bash
nix develop path:$PWD
npm ci
npm run dev:all
```

---

## Typical workflow

1. **Create a project** in the left panel.
2. **Import a video** (MP4).
3. **Scrub frames** and add cards/arrows to specific frames.
4. **Adjust text** (title/text), alignment, margins, and offsets.
5. **Trim or cut sections** if needed.
6. **Select slug options** (intro/outro) if desired.
7. **Render final** and monitor FFmpeg output in the UI.
8. **Download** the final MP4 or copy its path.

---

## Notes

- Example videos and frame dumps are ignored by default (`*.mp4`, `frames*`).
- The app is **local-first** and writes outputs into the `workspace/` folder.
- All edits are stored in `project.json` and can be reloaded at any time.
