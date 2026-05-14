# External API

C&M Content Tools exposes a local-trusted HTTP API for scripts, agents, WorkerBee, and other OpenAPI-aware tools.

## Discovery

When running in WorkerBee, the app OpenAPI document is available at:

```text
https://app.content-tools-studio-dev-6b01ab0b06.workerbee.localhost:19443/openapi.json
```

Interactive docs are served from `/docs`. The automation capability summary is served from `/automation/capabilities`.

For local development, use the API server directly:

```bash
curl http://127.0.0.1:3033/openapi.json
curl http://127.0.0.1:3033/automation/capabilities
```

## Command Editing

Use `POST /projects/:id/commands` to apply high-level edits atomically. Coordinates are source-video pixels. Overlay and cut `endFrame` values are inclusive. Trim uses `endFrameExclusive`.

```bash
curl -X POST "$API/projects/$PROJECT_ID/commands" \
  -H 'content-type: application/json' \
  -d '{
    "baseRevision": 1,
    "commands": [
      {
        "type": "addCard",
        "templateId": "card-lower-third-left",
        "startFrame": 120,
        "durationFrames": 150,
        "fields": { "title": "Step 1", "text": "Open Settings" }
      },
      {
        "type": "addArrow",
        "startFrame": 120,
        "durationFrames": 60,
        "x": 860,
        "y": 520,
        "rotationDeg": 45
      }
    ]
  }'
```

If `baseRevision` is stale, the server returns `409` with the latest project document.

Optional `actor` and `summary` fields on command batches are echoed to project event subscribers. Use them when an agent edits an open project:

```json
{
  "actor": "agent",
  "summary": "Agent applied the demo source timeline.",
  "commands": [{ "type": "setSourceSegmentsFromText", "text": "0s-20s (2x speed) = Opening" }]
}
```

## Source Timeline Recipes

Use `POST /projects/:id/timeline/parse` to preview timestamp shorthand before mutating a project. The parser accepts ranges such as `0s-20s`, `5m25s-6m0s`, `00:05:00 to 00:05:05`, speed notes such as `2x`, and fit notes such as `speed up to fit in 10s`.

```bash
curl -X POST "$API/projects/$PROJECT_ID/timeline/parse" \
  -H 'content-type: application/json' \
  -d '{
    "text": "0s-20s (2x speed) = Opening\n30s-5m0s (5s 1x speed, remaining slice speed up to fit in 5 seconds) = Deploy",
    "defaultAudio": "preserve"
  }'
```

Apply a recipe through the command endpoint:

```json
{
  "baseRevision": 3,
  "commands": [
    {
      "type": "setSourceSegmentsFromText",
      "text": "0s-20s (2x speed) = Opening",
      "defaultAudio": "preserve",
      "fastAudio": "mute"
    }
  ]
}
```

When `sourceSegments` are present, gaps are dropped and global export speed is neutralized to `1x`; each segment carries its own `playbackRate` and `audio` mode.

## Project Bundles

Use bundles to move an editable project between workspaces or preserve a manual review state.

```bash
curl -L "$API/projects/$PROJECT_ID/bundle?mode=project-media" -o project.zip
curl -X POST "$API/projects/import-bundle" -F "file=@project.zip"
```

Bundle modes are `project` for the JSON document, `project-media` for JSON plus source media, and `full` for media, render assets, and exports. Imported bundles receive a new project id and revision `1`.

## Slug Library

Slug videos are managed at runtime, so adding a new intro/outro MP4 does not require a rebuild. On first startup, repo files under `slug/*.mp4` are seeded into the runtime library.

```bash
curl "$API/slugs"
curl -X POST "$API/slugs" -F "file=@slug/workerbee-title-variant3-motion-loop-3s-vignette.mp4"
curl -L "$API/slugs/$SLUG_ID/media" -o slug.mp4
curl -X DELETE "$API/slugs/$SLUG_ID"
```

Delete returns `409` while any project references the slug. Projects still use `setSlug` with the asset `path` returned by `GET /slugs`.

## Script Flow

```js
const api = "http://127.0.0.1:3033";
const templates = await fetch(`${api}/templates`).then((res) => res.json());
const project = await fetch(`${api}/projects/${projectId}`).then((res) => res.json());

await fetch(`${api}/projects/${projectId}/commands`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    baseRevision: project.revision,
    commands: [
      {
        type: "addCard",
        templateId: templates.templates[0].id,
        startFrame: 30,
        fields: { title: "Intro", text: "Automated overlay" }
      }
    ]
  })
});

await fetch(`${api}/projects/${projectId}/render`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ presetId: "balanced", renderMode: "final" })
});
```

Use `GET /projects/:id/events` to subscribe to `project-updated` events when coordinating an open UI with external edits. Event payloads include `source`, `actor`, `summary`, `commands`, and `revision` when available; the web UI shows summaries as toast notifications.
