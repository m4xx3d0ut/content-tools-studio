# Local Content Studio Build Doc (CPU-first + NVENC, Linux 1080p)

A local-first content creation web app:

* **React UI** for timeline + overlays + export controls.
* **Local backend** on `127.0.0.1` for workspace management, rendering overlays, and running native **FFmpeg/FFprobe**.
* **CPU-first encoding** (`libx264`) with optional **NVIDIA NVENC** preset if available (opt-in).
* Build local-first now; wrap later in **Tauri/Electron** by spawning the backend and swapping file-import UX.

---

## Goals

1. End-to-end workflow: **Import video → Edit overlays → Export MP4**.
2. Deterministic exports via `project.json` as the source of truth.
3. Smooth editing UX via **proxy playback** + frame-accurate checks.
4. CPU is the default export path; NVENC is opt-in.

---

## Original MVP spec (from CONTENT-PIPELINE.md)

### Goals

* Provide a local web UI to annotate video frames with overlay cards, text, and directional arrows.
* Let users scrub to exact frames/timestamps and capture placement/orientation decisions.
* Export a self-contained archive with assets plus a Markdown/README containing the exact ffmpeg command(s).

### Scope (MVP)

* Load a local MP4 and display a frame scrubber with thumbnail previews.
* Create/edit a list of annotations tied to a time range or single frame.
* For each annotation:

  * Select overlay card template.
  * Set text fields (including multi-line).
  * Optional arrow: position, orientation (left/right/45° down-left/45° down-right), and visibility window.
* Preview overlays on top of the video frame in the browser.
* Export an archive containing:

  * Generated overlay PNGs (card + text baked), arrow PNGs (transformed), and any fonts needed.
  * `filter_complex.txt` (or equivalent) for ffmpeg.
  * `README.md`/Markdown with the exact command to run locally.

### Non-goals (MVP)

* No collaborative editing or cloud storage.
* No final video rendering in-browser.
* No advanced motion graphics beyond basic fade/pulse (optional future preset support).

### UX flow

1. Import MP4 (local file picker).
2. Timeline scrubber with frame capture (exact timestamp + frame index).
3. Add annotation:

   * Choose overlay card template.
   * Enter text.
   * Place card via drag/resize; snap to grid/quadrant.
   * Optional arrow: select type (left/right/45° down-left/45° down-right), drag to position, adjust opacity and blink timing.
4. Preview: overlay the annotation on the current frame.
5. Export: generate assets + ffmpeg docs into a downloadable archive.

### Export bundle (canonical)

* `/assets/overlays/*.png`
* `/assets/arrows/*.png`
* `/filters/filter_complex.txt`
* `/README.md` (ffmpeg command + notes)
* `/project.json` (editable spec)

### Risks & mitigations

* Accurate frame-to-time alignment: detect fps and lock scrubbing to frame indices.
* Font consistency: bundle fonts in export and ensure renderer uses them.
* Template drift: version templates and store template version per overlay.

### Open questions

* Time ranges vs single-frame anchored with default durations.
* Per-overlay animation controls beyond pulse/blink.
* Multiple output resolutions (1x/2x) from one project.

---

## Added requirements (intro/outro + motion)

### Intro/outro slug

* Project must support **intro slug** + **outro slug** clips.
* Export must be able to:

  * Render the main annotated video (no slug), then
  * Concatenate: `intro + main + outro` (single ffmpeg invocation or a second pass).
* MVP recommendation: **two-pass** (matches your working manual commands and is easiest to debug).

### Per-quadrant card motion: slide-in

* Overlay cards/text must **slide in** horizontally:

  * **Right-side quadrants**: slide **right → left** (enter from offscreen right).
  * **Left-side quadrants**: slide **left → right** (enter from offscreen left).
* Each card needs:

  * `slideInFrames` (duration of slide)
  * `displayFrames` (how long it remains visible after slide completes) OR derive from `endFrame`.

### Arrow motion: bounce

* Arrows must **bounce** while visible.
* Each arrow needs:

  * `visibleStartFrame/visibleEndFrame` (arrow-only window override)
  * `bouncePx` (amplitude)
  * `bouncePeriodFrames` (period/speed)
  * Optional `bounceAxis` (x or y); for left/right arrows, bouncing on **x** often “reads” better.

---

## Stack

### Frontend

* React + Vite + TypeScript
* Overlay editing: **Konva** (later milestone)
* Export progress: SSE (EventSource)

### Backend

* Node.js + TypeScript
* Fastify + CORS + multipart + static
* Playwright (Chromium) for template → PNG rendering
* FFmpeg/FFprobe installed system-wide for MVP

---

## Repo Layout

```
content-studio/
  apps/
    web/              # React UI (Vite)
    server/           # Fastify backend
  packages/
    shared/           # Types + Zod schemas + presets
    templates/        # HTML/CSS templates + fonts
  workspace/          # gitignored local projects
```

---

## Workspace Layout (per project)

```
workspace/<projectId>/
  project.json
  media/
    source.mp4
    proxy.mp4               # optional
  render/
    overlays/
      <overlayId>.png
    arrows/
      <arrowId>.png         # optional (pre-rendered variants)
  exports/
    <timestamp>/
      main_noslug.mp4
      final_with_slug.mp4   # optional
      manifest.json
      filter_complex_cards.txt
      filter_complex_cards_arrows.txt
```

**Key rules**

* `project.json` is authoritative.
* Timing is frame-based (CFR assumption for frame-accurate intent).
* Geometry is in source-video pixel coordinates (1920×1080).

---

## Data Model (project.json)

* Authoritative timing: **frames**.
* UI derives time from fps rational: `timeMs = frame * 1000 * fpsDen / fpsNum`.

### Recommended additions (slug + motion)

Add to project:

* `slug?: { introPath?: string; outroPath?: string; fps?: number; }`
* `export?: { speed?: 1 | 2; includeSlug?: boolean; }`

Add to overlays:

* `motion?: { slideInFrames?; displayFrames?; slideDirection?; visibleStartFrame?; visibleEndFrame?; bouncePx?; bouncePeriodFrames?; bounceAxis? }`

---

## Shared Schema (Zod + TS)

Create: `packages/shared/src/project.ts`

Below is the **updated** schema (includes `motion` and `slug`). If you’ve already created the earlier schema, use this version to replace/extend it.

```ts
import { z } from "zod";

export const RectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().positive(),
  h: z.number().finite().positive(),
});

export const VideoSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fpsNum: z.number().int().positive(),
  fpsDen: z.number().int().positive(),
  durationMs: z.number().int().nonnegative(),
  audio: z.object({
    hasAudio: z.boolean().default(true),
    sampleRate: z.number().int().positive().optional(),
    channels: z.number().int().positive().optional(),
  }).default({ hasAudio: true }),
});

export const SourceSchema = z.object({
  filename: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().optional(),
  sha256: z.string().length(64).optional(),
});

export const MotionSchema = z.object({
  // Card slide-in
  slideInFrames: z.number().int().nonnegative().optional(),
  displayFrames: z.number().int().nonnegative().optional(),
  slideDirection: z.enum(["fromLeft", "fromRight", "none"]).optional(),

  // Visibility override (esp. arrows)
  visibleStartFrame: z.number().int().nonnegative().optional(),
  visibleEndFrame: z.number().int().nonnegative().optional(),

  // Arrow bounce
  bouncePx: z.number().finite().nonnegative().optional(),
  bouncePeriodFrames: z.number().int().positive().optional(),
  bounceAxis: z.enum(["x", "y"]).optional(),
}).optional();

export const OverlaySchema = z.object({
  id: z.string().min(1),
  templateId: z.string().min(1),
  templateVersion: z.string().min(1).default("1"),

  startFrame: z.number().int().nonnegative(),
  endFrame: z.number().int().nonnegative(),

  rect: RectSchema,
  rotationDeg: z.number().finite().optional(),
  opacity: z.number().min(0).max(1).optional(),

  zIndex: z.number().int().default(0),

  fields: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  motion: MotionSchema,
});

export const ProxySpecSchema = z.object({
  enabled: z.boolean().default(false),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  crf: z.number().int().min(10).max(40).optional(),
  preset: z.string().optional(),
});

export const RenderCacheSchema = z.object({
  overlayAssetHash: z.record(z.string()).default({}),
  templatesVersion: z.string().optional(),
});

export const SlugSchema = z.object({
  introPath: z.string().optional(), // path within workspace or absolute (decide convention)
  outroPath: z.string().optional(),
  fps: z.number().positive().optional(), // expected fps for concat normalization, e.g. 30
}).optional();

export const ExportOptionsSchema = z.object({
  speed: z.union([z.literal(1), z.literal(2)]).default(1),
  includeSlug: z.boolean().default(false),
}).optional();

export const ProjectSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),

  source: SourceSchema,
  video: VideoSchema,

  proxy: ProxySpecSchema.default({ enabled: false }),
  overlays: z.array(OverlaySchema).default([]),

  slug: SlugSchema,
  exportOptions: ExportOptionsSchema,

  lastExportPresetId: z.string().optional(),
  renderCache: RenderCacheSchema.default({ overlayAssetHash: {} }),
});

export type Project = z.infer<typeof ProjectSchema>;
export type Overlay = z.infer<typeof OverlaySchema>;
export type VideoInfo = z.infer<typeof VideoSchema>;

export function validateProject(json: unknown): Project {
  return ProjectSchema.parse(json);
}
```

---

## Export Presets (CPU-first + NVENC opt-in)

Create: `packages/shared/src/presets.ts` (same as earlier; unchanged)

CPU defaults:

* Draft: `-crf 23 -preset veryfast`
* Balanced: `-crf 20 -preset medium`
* Quality: `-crf 18 -preset slow`

NVENC preset:

* Optional: `h264_nvenc` with `-preset p5 -cq 20`

---

## Template System (HTML/CSS → PNG)

### Folder layout

```
packages/templates/
  templates/
    lower-third/
      v1/
        template.html
        style.css
  fonts/
```

Render requirements:

* Transparent output (`omitBackground: true`)
* Deterministic font loading (bundle `.woff2` and use `@font-face` later)
* Render cache keyed by: template/version + fields + size + DPR + templatesVersion

---

## Quadrant presets (1080p)

Because you’re “per-quadrant cards,” define deterministic quadrant slots.

Let:

* `videoW=1920`, `videoH=1080`
* `margin=80`
* `gutter=40`
* `cardW=1100` (tune)
* `cardH=180` (tune)

Default anchors:

* **TL**: `x=margin`, `y=margin`
* **TR**: `x=videoW - margin - cardW`, `y=margin`
* **BL**: `x=margin`, `y=videoH - margin - cardH`
* **BR**: `x=videoW - margin - cardW`, `y=videoH - margin - cardH`

Stacking multiple cards:

* TL/TR stack downward: `y = baseY + idx*(cardH+gutter)`
* BL/BR stack upward: `y = baseY - idx*(cardH+gutter)`

Quadrant → slide direction defaults:

* TL/BL: `fromLeft`
* TR/BR: `fromRight`

---

## Backend Plan

### Dependencies

`apps/server`

```bash
npm i fastify @fastify/cors @fastify/multipart @fastify/static zod playwright
npx playwright install chromium
npm i -D tsx typescript @types/node
```

### Config

`apps/server/src/config.ts`

```ts
import path from "node:path";

export const WORKSPACE_ROOT =
  process.env.WORKSPACE_ROOT || path.resolve(process.cwd(), "../../workspace");

export const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
export const FFPROBE_PATH = process.env.FFPROBE_PATH || "ffprobe";

export const SERVER_HOST = process.env.HOST || "127.0.0.1";
export const SERVER_PORT = Number(process.env.PORT || 3033);
```

---

## Motion + overlay strategy: what gets rendered vs what gets animated

You have two main implementation choices:

### Option A (recommended MVP): animate by moving overlay images with FFmpeg expressions

* Renderer produces static PNGs (cards and arrows).
* FFmpeg `overlay` filter uses expressions for `x`/`y` (slide/bounce).
* Pro: simplest asset pipeline; matches your manual approach closely.
* Con: filter expressions get a bit gnarly (we’ll generate them).

### Option B (future): pre-render animations as short RGBA videos and overlay those

* Render a small overlay video with alpha.
* Overlay via `overlay` with simpler `enable`.
* Pro: trivial filter graph; flexible animation.
* Con: heavier rendering step; more data; more caching.

**This doc assumes Option A.**

---

## Filter_complex generation strategy (match your proto conventions)

Your manual commands imply:

* Cards only → final label `[v14]`
* Cards + arrows → final label `[v28]`

We’ll generate filter graphs deterministically:

### Labeling convention

* Base: `[0:v]setpts=PTS-STARTPTS[v0]`
* After each overlay stage: `[v1]`, `[v2]`, ...
* If there are **N** card overlays: card-only output = `[vN]`
* If there are **M** arrow overlays applied after cards: final output = `[v(N+M)]`

### Two-phase script files

In each export run folder, emit:

* `filter_complex_cards.txt` (cards)
* `filter_complex_cards_arrows.txt` (cards + arrows)

And record everything in `manifest.json`:

* inputs, script used, computed fps, computed seconds, preset, final ffmpeg args.

---

## Motion expressions (slide-in + display window + bounce)

FFmpeg expressions are easiest in seconds (`t`), not frames, but your UI is frame-based. We convert.

Compute:

* `fps = fpsNum / fpsDen`
* `startSec = startFrame / fps`
* `endSec = endFrame / fps`
* `slideSec = slideInFrames / fps` (0 if missing)
* `displaySec = displayFrames / fps` (optional)

### Visibility window proveable rule

For each overlay:

* `visStartFrame = motion.visibleStartFrame ?? startFrame`
* `visEndFrame   = motion.visibleEndFrame   ?? endFrame`

So:

* `visStartSec = visStartFrame / fps`
* `visEndSec   = visEndFrame / fps`

Use:

```text
enable='between(t, visStartSec, visEndSec)'
```

### Card display time rule (slide + hold)

If `displayFrames` is set (and you want end derived):

* `visEndSec = startSec + slideSec + displaySec`

Else:

* use reminder `endFrame` as authored.

### Slide-in X expression

Let:

* `xFinal = rect.x`
* `w = rect.w`
* `videoW = 1920`
* `xStart = -w` for fromLeft, `xStart = videoW` for fromRight

```text
x = if(lt(t, startSec), NAN,
     if(lt(t, startSec+slideSec),
        xStart + (xFinal-xStart)*((t-startSec)/slideSec),
        xFinal))
```

If `slideSec` is 0 or absent, just use `x=xFinal`.

### Arrow bounce (x or y)

Let:

* `A = bouncePx`
* `periodSec = bouncePeriodFrames/fps`
* `t0 = visStartSec`

Bounce on Y:

```text
y = yFinal + A*sin(2*PI*(t-t0)/periodSec)
```

Bounce on X:

```text
x = xFinal + A*sin(2*PI*(t-t0)/periodSec)
```

### Escaping for filter_complex_script

Commas inside expressions must be escaped:

* `between(t\,4.5\,7.0)`
* `if(lt(t\,0)...)`

(Your generator should escape `,` as `\\,` when writing scripts.)

---

## Arrow assets: direction + variants

To match your manual approach:

* Keep canonical `arrow-right-128x128.png`
* For left arrows:

  * pre-render `arrow-left-128x128.png`, **or**
  * use `hflip` filter inside graph:

```text
[arrowIn]hflip[arrowLeft]
```

For diagonal arrows (45° down-left/down-right):

* MVP: pre-render assets per angle (simplest).
* Later: rotate at render-time via SVG/canvas to PNG.

---

## FFmpeg command generation: overlays + arrows + slug

We will generate equivalent invocations to your proto workflow:

### Pass 1: render main annotated video (no slug)

* Inputs: source video + `-loop 1` PNGs for cards + (optional) arrows.
* Filter: `-filter_complex_script filter_complex_cards*.txt`
* Output: `main_noslug.mp4`

### Pass 2: concat intro + main + outro (slug)

* Inputs: intro slug MP4 + `main_noslug.mp4` + outro slug MP4
* Filter: normalize fps + SAR + concat
* Output: `final_with_slug.mp4`

---

## 2× speed mode (matches your half-duration `-t` prototypes)

Your `2x` outputs show roughly half duration, implying 2× speed.

Implement speed-up in the filter graph:

### Video

* `setpts=0.5*PTS` (2× speed)

### Audio (if you include it later)

* `atempo=2.0`

**If you’re producing video-only exports right now**, you can ignore audio until you decide to keep it.

---

## Filter graph builder implementation notes (TypeScript)

### Key decisions

* Use **time-based enable** for motion overlays (`between(t, ...)`) rather than `between(n, ...)`.
* Still keep frame numbers in project data; convert to sec in generator.
* Emit deterministic labels `[v0]..[vN]` to match your manual scripts.

### Pseudocode sketch

```ts
for each overlay in orderedByZ:
  const {xExpr, yExpr, enableExpr} = buildExpr(overlay, fps, videoW, videoH)
  lines.push(`[${inputIndex}:v]format=rgba[ov${i}]`)
  lines.push(`${prev}[ov${i}]overlay=x='${xExpr}':y='${yExpr}':enable='${enableExpr}'[v${i+1}]`)
  prev = `[v${i+1}]`
```

### Expression builder rules

* For cards: xExpr uses slide; yExpr constant.
* For arrows: xExpr constant or bounce; yExpr constant or bounce.
* enableExpr always uses `between(t, startSec, endSec)` based on visibility window.

---

## Prototype FFmpeg commands (manual reference)

All commands run from `/home/m4xx3d0ut/Documents/PK/k1s/demo-content`.

### 1x (labeled_5s) — overlays only (no slug)

```bash
ffmpeg -y -i k1s-demo-0.1.0-0-2026-01-19_1080p.mp4 \
  -loop 1 -i overlays/ov_01.png \
  -loop 1 -i overlays/ov_02.png \
  -loop 1 -i overlays/ov_03.png \
  -loop 1 -i overlays/ov_04.png \
  -loop 1 -i overlays/ov_05.png \
  -loop 1 -i overlays/ov_06.png \
  -loop 1 -i overlays/ov_07.png \
  -loop 1 -i overlays/ov_08.png \
  -loop 1 -i overlays/ov_09.png \
  -loop 1 -i overlays/ov_10.png \
  -loop 1 -i overlays/ov_11.png \
  -loop 1 -i overlays/ov_12.png \
  -loop 1 -i overlays/ov_13.png \
  -loop 1 -i overlays/ov_14.png \
  -filter_complex_script filter_complex_full.txt \
  -map "[v14]" -t 247.233333 -c:v libx264 -crf 18 -preset veryfast -pix_fmt yuv420p \
  k1s-demo-0.1.0-0-2026-01-19_labeled_5s_noslug.mp4
```

### 1x (labeled_5s_arrows) — overlays + arrows (no slug)

```bash
ffmpeg -y -i k1s-demo-0.1.0-0-2026-01-19_1080p.mp4 \
  -loop 1 -i overlays/ov_01.png \
  -loop 1 -i overlays/ov_02.png \
  -loop 1 -i overlays/ov_03.png \
  -loop 1 -i overlays/ov_04.png \
  -loop 1 -i overlays/ov_05.png \
  -loop 1 -i overlays/ov_06.png \
  -loop 1 -i overlays/ov_07.png \
  -loop 1 -i overlays/ov_08.png \
  -loop 1 -i overlays/ov_09.png \
  -loop 1 -i overlays/ov_10.png \
  -loop 1 -i overlays/ov_11.png \
  -loop 1 -i overlays/ov_12.png \
  -loop 1 -i overlays/ov_13.png \
  -loop 1 -i overlays/ov_14.png \
  -loop 1 -i k1s-directional-arrows/arrow-right-128x128.png \
  -filter_complex_script filter_complex_full_arrows.txt \
  -map "[v28]" -t 247.233333 -c:v libx264 -crf 18 -preset ultrafast -pix_fmt yuv420p \
  k1s-demo-0.1.0-0-2026-01-19_labeled_5s_arrows_noslug.mp4
```

Note: `filter_complex_full_arrows.txt` uses right-pointing arrows on the right side, left-pointing arrows on the left side, and the two arrows in the Events/Logs panel point left.

### Add slug intro/outro (concat)

```bash
ffmpeg -y -i slug/k1s-title-variant3-motion-loop-3s_1080p30.mp4 \
  -i k1s-demo-0.1.0-0-2026-01-19_labeled_5s_arrows_noslug.mp4 \
  -i slug/k1s-title-variant3-motion-loop-3s_1080p30.mp4 \
  -filter_complex "[0:v]fps=30,setsar=1[v0];[1:v]fps=30,setsar=1[v1];[2:v]fps=30,setsar=1[v2];[v0][v1][v2]concat=n=3:v=1:a=0[v]" \
  -map "[v]" -c:v libx264 -crf 18 -preset veryfast -pix_fmt yuv420p \
  k1s-demo-0.1.0-0-2026-01-19_labeled_5s_arrows.mp4
```

### Add slug intro/outro (concat) — overlays-only version

```bash
ffmpeg -y -i slug/k1s-title-variant3-motion-loop-3s_1080p30.mp4 \
  -i k1s-demo-0.1.0-0-2026-01-19_labeled_5s_noslug.mp4 \
  -i slug/k1s-title-variant3-motion-loop-3s_1080p30.mp4 \
  -filter_complex "[0:v]fps=30,setsar=1[v0];[1:v]fps=30,setsar=1[v1];[2:v]fps=30,setsar=1[v2];[v0][v1][v2]concat=n=3:v=1:a=0[v]" \
  -map "[v]" -c:v libx264 -crf 18 -preset veryfast -pix_fmt yuv420p \
  k1s-demo-0.1.0-0-2026-01-19_labeled_5s.mp4
```

### 2x (labeled_5s_2x) — overlays only (no slug)

```bash
ffmpeg -y -i k1s-demo-0.1.0-0-2026-01-19_1080p.mp4 \
  -loop 1 -i overlays/ov_01.png \
  -loop 1 -i overlays/ov_02.png \
  -loop 1 -i overlays/ov_03.png \
  -loop 1 -i overlays/ov_04.png \
  -loop 1 -i overlays/ov_05.png \
  -loop 1 -i overlays/ov_06.png \
  -loop 1 -i overlays/ov_07.png \
  -loop 1 -i overlays/ov_08.png \
  -loop 1 -i overlays/ov_09.png \
  -loop 1 -i overlays/ov_10.png \
  -loop 1 -i overlays/ov_11.png \
  -loop 1 -i overlays/ov_12.png \
  -loop 1 -i overlays/ov_13.png \
  -loop 1 -i overlays/ov_14.png \
  -filter_complex_script filter_complex_full_2x.txt \
  -map "[v14]" -t 123.6166665 -c:v libx264 -crf 18 -preset veryfast -pix_fmt yuv420p \
  k1s-demo-0.1.0-0-2026-01-19_labeled_5s_2x_noslug.mp4
```

### 2x (labeled_5s_arrows_2x) — overlays + arrows (no slug)

```bash
ffmpeg -y -i k1s-demo-0.1.0-0-2026-01-19_1080p.mp4 \
  -loop 1 -i overlays/ov_01.png \
  -loop 1 -i overlays/ov_02.png \
  -loop 1 -i overlays/ov_03.png \
  -loop 1 -i overlays/ov_04.png \
  -loop 1 -i overlays/ov_05.png \
  -loop 1 -i overlays/ov_06.png \
  -loop 1 -i overlays/ov_07.png \
  -loop 1 -i overlays/ov_08.png \
  -loop 1 -i overlays/ov_09.png \
  -loop 1 -i overlays/ov_10.png \
  -loop 1 -i overlays/ov_11.png \
  -loop 1 -i overlays/ov_12.png \
  -loop 1 -i overlays/ov_13.png \
  -loop 1 -i overlays/ov_14.png \
  -loop 1 -i k1s-directional-arrows/arrow-right-128x128.png \
  -filter_complex_script filter_complex_full_arrows_2x.txt \
  -map "[v28]" -t 123.6166665 -c:v libx264 -crf 18 -preset ultrafast -pix_fmt yuv420p \
  k1s-demo-0.1.0-0-2026-01-19_labeled_5s_arrows_2x_noslug.mp4
```

### Add slug intro/outro — 2x

```bash
ffmpeg -y -i slug/k1s-title-variant3-motion-loop-3s_1080p30.mp4 \
  -i k1s-demo-0.1.0-0-2026-01-19_labeled_5s_arrows_2x_noslug.mp4 \
  -i slug/k1s-title-variant3-motion-loop-3s_1080p30.mp4 \
  -filter_complex "[0:v]fps=30,setsar=1[v0];[1:v]fps=30,setsar=1[v1];[2:v]fps=30,setsar=1[v2];[v0][v1][v2]concat=n=3:v=1:a=0[v]" \
  -map "[v]" -c:v libx264 -crf 18 -preset veryfast -pix_fmt yuv420p \
  k1s-demo-0.1.0-0-2026-01-19_labeled_5s_arrows_2x.mp4
```

### Add slug intro/outro — 2x overlays-only

```bash
ffmpeg -y -i slug/k1s-title-variant3-motion-loop-3s_1080p30.mp4 \
  -i k1s-demo-0.1.0-0-2026-01-19_labeled_5s_2x_noslug.mp4 \
  -i slug/k1s-title-variant3-motion-loop-3s_1080p30.mp4 \
  -filter_complex "[0:v]fps=30,setsar=1[v0];[1:v]fps=30,setsar=1[v1];[2:v]fps=30,setsar=1[v2];[v0][v1][v2]concat=n=3:v=1:a=0[v]" \
  -map "[v]" -c:v libx264 -crf 18 -preset veryfast -pix_fmt yuv420p \
  k1s-demo-0.1.0-0-2026-01-19_labeled_5s_2x.mp4
```

---

## Example overlay specs (cards + arrows)

### Card overlay (slide-in)

```json
{
  "id": "ov1",
  "templateId": "lower-third",
  "templateVersion": "1",
  "startFrame": 0,
  "endFrame": 300,
  "rect": { "x": 80, "y": 880, "w": 1100, "h": 180 },
  "zIndex": 10,
  "fields": {
    "title": "Application Engines",
    "subtitle": "Event-driven workflows: patterns + pitfalls"
  },
  "motion": {
    "slideInFrames": 15,
    "displayFrames": 285,
    "slideDirection": "fromLeft"
  }
}
```

### Arrow overlay (bounce + shorter visibility)

```json
{
  "id": "arrow1",
  "templateId": "arrow-right",
  "templateVersion": "1",
  "startFrame": 120,
  "endFrame": 240,
  "rect": { "x": 1480, "y": 520, "w": 128, "h": 128 },
  "zIndex": 50,
  "fields": {},
  "motion": {
    "visibleStartFrame": 135,
    "visibleEndFrame": 210,
    "bouncePx": 10,
    "bouncePeriodFrames": 24,
    "bounceAxis": "x"
  }
}
```

---

## Frontend plan (MVP → full editor)

### MVP UI

* Create project
* Import video (upload)
* Choose preset + speed (1×/2×) + include slug
* Start export
* SSE progress + logs
* Download outputs (main_noslug + final_with_slug if enabled)

### Editor milestones

* Overlay CRUD list editor (fields, start/end frames, quadrant selection)
* Konva overlay placement (drag/resize, snapping)
* Arrow placement with bounce preview (CSS animation in UI; authoritative export is ffmpeg expression)

---

## Milestones

### M1 — Skeleton + Persistence

* Workspace service + schema
* Create/open/save projects

### M2 — Import + Metadata

* Streaming upload
* ffprobe metadata saved

### M3 — Export Pipeline (CPU)

* Job manager + SSE
* Export MP4 with static overlays

### M4 — Template Rendering (Playwright)

* HTML/CSS → PNG
* Overlay correctness validated

### M5 — Motion (slide + bounce)

* Time-based expressions in filter generator
* Quadrant defaults for slide direction
* Arrow visibility windows

### M6 — Slug concat + 2× speed mode

* Two-pass slug concat
* `setpts` speed options (and audio atempo later if needed)

### M7 — NVENC opt-in

* Detect `h264_nvenc`
* Enable NVENC preset (explicit selection)

### M8 — Wrap (Tauri/Electron)

* Path-based import
* Spawn backend automatically
* Optional bundled ffmpeg

---

## Implementation notes / gotchas

* If source videos can be VFR, frame-accurate timing is tricky. MVP assumption: **CFR**; enforce with proxy generation if needed.
* For motion expressions, prefer **time `t`**. It’s more robust than `n` once you add `setpts` speed changes and sliding.
* Keep `manifest.json` in every export for reproducibility and debugging.
* Fonts: bundle `.woff2` and load explicitly in templates for consistent render across machines.

---

If you want, next I can also output the **exact TypeScript implementation** for a motion-capable `filterGraphBuilder` that:

* separates card overlays vs arrow overlays,
* emits `filter_complex_cards*.txt`,
* handles escaping automatically,
* and supports the 2× `setpts` mode in a clean, predictable way.

