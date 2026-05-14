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

Use `GET /projects/:id/events` to subscribe to `project-updated` events when coordinating an open UI with external edits.
