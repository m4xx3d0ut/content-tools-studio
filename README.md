# C&M Content Tools

Local-first video annotation and rendering pipeline for screencast overlays. Import MP4 footage, scrub frames, place branded cards and directional arrows, trim/cut sections, and render a final MP4 directly into a workspace export folder with FFmpeg.

---

## What this app does

**C&M Content Tools** is a desktop-style web editor built for precise overlay work on screen recordings:

- Create/select/delete local projects and keep all edits in a workspace folder.
- Import MP4 footage and scrub frame-by-frame with thumbnails and a track view.
- Place branded overlay cards and directional arrows on exact frames.
- Configure per-overlay timing, animation, and layout settings.
- Trim a clip (start/end) and cut out arbitrary sections.
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
- **Undo/redo** (Ctrl+Z / Ctrl+Y) and delete selected overlays with Delete.

### Rendering
- Generates overlay and arrow PNG assets.
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
- Sharp for overlay/arrow PNG generation

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

Optional environment variables:

- `WORKSPACE_ROOT` (default: `<repo>/workspace`)
- `FFMPEG_PATH` (default: `ffmpeg`)
- `FFPROBE_PATH` (default: `ffprobe`)
- `HOST` (default: `127.0.0.1`)
- `PORT` (default: `3033`)

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

