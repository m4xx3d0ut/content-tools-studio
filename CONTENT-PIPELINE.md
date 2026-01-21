# Content Pipeline App Plan

## Goals
- Provide a local web UI to annotate video frames with overlay cards, text, and directional arrows.
- Let users scrub to exact frames/timestamps and capture placement/orientation decisions.
- Export a self-contained archive with assets + a Markdown file containing the exact ffmpeg command(s).

## Scope (MVP)
- Load a local MP4 and display a frame scrubber with thumbnail previews.
- Create/edit a list of annotations tied to a time range or single frame.
- For each annotation:
  - Select overlay card template.
  - Set text fields.
  - Optional arrow: position, orientation (left/right/45deg), and visibility window.
- Preview overlays on top of the video frame in the browser.
- Export archive containing:
  - Generated overlay PNGs (card + text baked), arrow PNGs (transformed), and any fonts needed.
  - A filter_complex.txt (or equivalent) for ffmpeg.
  - A README/Markdown with the exact command to run locally.

## Non-goals (MVP)
- No collaborative editing or cloud storage.
- No direct video rendering in-browser for the final output.
- No advanced motion graphics beyond basic fade/pulse presets.

## UX Flow
1. Import MP4 (local file picker).
2. Timeline scrubber with frame capture (exact timestamp and frame index).
3. Add annotation:
   - Choose overlay card template.
   - Enter text (supports multi-line).
   - Place card via drag/resize; snap to grid/quadrant.
   - Optional arrow: select type (left/right/45deg down-left/45deg down-right), drag to position, adjust opacity and blink timing.
4. Preview: overlay the annotation on the current frame.
5. Export: generate assets + ffmpeg docs into a downloadable archive.

## Data Model (Draft)
- Project
  - sourceVideoPath
  - fps (detected)
  - resolution
  - overlays[]
- Overlay
  - id
  - timeStart / timeEnd (or frame index)
  - templateId
  - textFields[]
  - position {x,y}
  - size {w,h}
  - arrow {type, position, rotation, opacityAnim}
  - zIndex
- Export
  - outputName
  - includeSlug (bool)
  - scaleVariant (1x/2x)

## Architecture
- Frontend: local web UI (React or Svelte) with timeline and canvas overlay editor.
- Backend: lightweight local server (Node or Python) to:
  - Extract thumbnails with ffmpeg.
  - Render overlay PNGs using a headless renderer (Canvas/Skia).
  - Generate filter_complex + command doc.
- Store project JSON locally in a workspace folder.

## Export Details
- Bundle structure:
  - /assets/overlays/*.png
  - /assets/arrows/*.png
  - /filters/filter_complex.txt
  - /README.md (ffmpeg command + notes)
  - /project.json (editable spec)
- README includes:
  - Input video path
  - Output file name
  - Full ffmpeg command with filter_complex reference
  - Optional variants (2x, slugged)

## Milestones
1. **Discovery & Spec**
   - Finalize overlay templates and arrow types.
   - Define animation presets (pulse/blink timings).
2. **Prototype UI**
   - Load MP4, scrub frames, add overlays, place arrows.
   - Save/load project JSON.
3. **Asset Export**
   - Generate overlay PNGs with text.
   - Generate arrow PNGs with transforms.
4. **FFmpeg Integration**
   - Generate filter_complex and README command.
   - Validate output with sample videos.
5. **Polish**
   - Keyboard shortcuts, grid snapping, template library.
   - Basic validation (missing text, offscreen overlays).

## Risks & Mitigations
- Accurate frame-to-time alignment: detect fps and lock scrubbing to frame indices.
- Font consistency: bundle fonts in export and reference them in rendering pipeline.
- Template drift: store template definitions centrally and version them in project JSON.

## Open Questions
- Should overlays be time ranges (start/end) or single-frame anchored with default durations?
- Do we need per-overlay animation controls beyond opacity pulse?
- Do we support multiple output resolutions from one project?

## Proposed Next Step
- Confirm MVP requirements and pick frontend framework + backend runtime.
