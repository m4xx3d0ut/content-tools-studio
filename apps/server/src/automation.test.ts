import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const startingCwd = process.cwd();
const repoRoot = startingCwd.endsWith(path.join("apps", "server"))
  ? path.resolve(startingCwd, "../..")
  : startingCwd;
const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "content-tools-api-"));
process.env.WORKSPACE_ROOT = workspaceRoot;
process.chdir(path.join(repoRoot, "apps", "server"));

after(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

async function createTestApp() {
  const { buildApp } = await import("./app.js");
  const app = await buildApp();
  await app.ready();
  return app;
}

test("command endpoint applies overlay edits and enforces revisions", async (t) => {
  const app = await createTestApp();
  t.after(async () => app.close());

  const createdResponse = await app.inject({
    method: "POST",
    url: "/projects",
    payload: {
      name: "Automation Test",
      video: { durationMs: 60000, audio: { hasAudio: false } },
    },
  });
  assert.equal(createdResponse.statusCode, 201);
  const created = createdResponse.json();

  const commandResponse = await app.inject({
    method: "POST",
    url: `/projects/${created.id}/commands`,
    payload: {
      baseRevision: created.revision,
      commands: [
        {
          type: "addCard",
          templateId: "card-lower-third-left",
          startFrame: 30,
          durationFrames: 90,
          fields: { title: "Step 1", text: "Automated card" },
        },
        {
          type: "addArrow",
          startFrame: 45,
          durationFrames: 30,
          x: 860,
          y: 520,
          rotationDeg: 45,
        },
      ],
    },
  });
  assert.equal(commandResponse.statusCode, 200);
  const commandResult = commandResponse.json();
  assert.equal(commandResult.project.revision, created.revision + 1);
  assert.equal(commandResult.project.overlays.length, 2);
  assert.equal(commandResult.project.overlays[0].fields.title, "Step 1");
  assert.equal(commandResult.results.length, 2);

  const staleResponse = await app.inject({
    method: "POST",
    url: `/projects/${created.id}/commands`,
    payload: {
      baseRevision: created.revision,
      commands: [{ type: "removeOverlay", id: commandResult.project.overlays[0].id }],
    },
  });
  assert.equal(staleResponse.statusCode, 409);
  assert.equal(staleResponse.json().project.revision, created.revision + 1);
});

test("OpenAPI document exposes automation and streaming contracts", async (t) => {
  const app = await createTestApp();
  t.after(async () => app.close());

  const response = await app.inject({ method: "GET", url: "/openapi.json" });
  assert.equal(response.statusCode, 200);
  const document = response.json();
  assert.equal(document.openapi, "3.0.3");
  assert.ok(document.components.schemas.Project);
  assert.ok(document.components.schemas.EditorCommand);
  assert.ok(document.paths["/projects/{id}/commands"]);
  assert.equal(
    document.paths["/projects/{id}/commands"].post.requestBody.content["application/json"].schema
      .$ref,
    "#/components/schemas/CommandBatchRequest"
  );
  assert.ok(document.paths["/automation/capabilities"]);
  assert.ok(
    document.paths["/projects/{id}/events"].get.responses["200"].content["text/event-stream"]
  );
  assert.ok(
    document.paths["/projects/{id}/exports/latest"].get.responses["200"].content["video/mp4"]
  );

  const templatesResponse = await app.inject({ method: "GET", url: "/templates" });
  assert.equal(templatesResponse.statusCode, 200);
  assert.equal(templatesResponse.json().templates[0].id, "card-lower-third-left");
});
