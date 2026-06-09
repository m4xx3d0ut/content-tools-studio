import test, { after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";

type RawFormHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

const startingCwd = process.cwd();
const repoRoot = startingCwd.endsWith(path.join("apps", "server"))
  ? path.resolve(startingCwd, "../..")
  : startingCwd;
const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "content-tools-rawform-"));

process.env.WORKSPACE_ROOT = workspaceRoot;
process.env.REPO_ROOT = repoRoot;
process.env.UPLOAD_MAX_BYTES = "64";
process.env.RAWFORM_FETCH_TIMEOUT_MS = "100";
process.env.RAWFORM_MEDIA_TIMEOUT_MS = "100";
process.chdir(path.join(repoRoot, "apps", "server"));

let rawFormCallCount = 0;
let rawFormHandler: RawFormHandler = (_request, response) => {
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not found" }));
};

function setRawFormHandler(handler: RawFormHandler): void {
  rawFormCallCount = 0;
  rawFormHandler = async (request, response) => {
    rawFormCallCount += 1;
    await handler(request, response);
  };
}

const rawFormServer = createServer((request, response) => {
  void rawFormHandler(request, response);
});
await new Promise<void>((resolve) => rawFormServer.listen(0, "127.0.0.1", resolve));
const rawFormAddress = rawFormServer.address() as AddressInfo;
process.env.RAWFORM_API_BASE = `http://127.0.0.1:${rawFormAddress.port}`;

after(async () => {
  await new Promise<void>((resolve, reject) => {
    rawFormServer.close((error) => (error ? reject(error) : resolve()));
  });
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

const { buildApp } = await import("./app.js");
const { createProject, listProjects, writeProject } = await import("./services/workspace.js");
const { importSourceVideo } = await import("./routes/projects.js");

const RAWFORM_SESSION_ID = "11111111-2222-3333-4444-555555555555";

async function createTestApp() {
  const app = await buildApp();
  await app.ready();
  return app;
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer<ArrayBufferLike>> {
  const chunks: Buffer<ArrayBufferLike>[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

test("RawForm session import rejects invalid session IDs before upstream fetch", async (t) => {
  const app = await createTestApp();
  t.after(async () => app.close());
  setRawFormHandler((_request, response) => {
    response.writeHead(500);
    response.end("unexpected upstream call");
  });

  const response = await app.inject({
    method: "POST",
    url: "/rawform/session-imports",
    payload: { sessionId: "not-a-session-id" },
  });

  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /full RawForm session UUID/);
  assert.equal(rawFormCallCount, 0);
});

test("RawForm session import validates project before upstream fetch", async (t) => {
  const app = await createTestApp();
  t.after(async () => app.close());
  setRawFormHandler((_request, response) => {
    response.writeHead(500);
    response.end("unexpected upstream call");
  });

  const response = await app.inject({
    method: "POST",
    url: "/rawform/session-imports",
    payload: { sessionId: RAWFORM_SESSION_ID, projectId: "missing-project" },
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error, "project not found");
  assert.equal(rawFormCallCount, 0);
});

test("RawForm session import rejects oversized media before creating a project", async (t) => {
  const app = await createTestApp();
  t.after(async () => app.close());
  const beforeCount = (await listProjects()).length;
  setRawFormHandler((_request, response) => {
    response.writeHead(200, {
      "content-type": "video/mp4",
      "content-length": "65",
    });
    response.end(Buffer.alloc(1));
  });

  const response = await app.inject({
    method: "POST",
    url: "/rawform/session-imports",
    payload: { sessionId: RAWFORM_SESSION_ID },
  });

  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /RawForm media exceeds 64 bytes/);
  assert.equal(rawFormCallCount, 1);
  assert.equal((await listProjects()).length, beforeCount);
});

test("importSourceVideo rejects streams over the configured upload limit", async () => {
  const project = await createProject("Oversized Import Test");
  await assert.rejects(
    importSourceVideo(project, {
      stream: Readable.from([Buffer.alloc(65)]),
      filename: "oversized.mp4",
    }),
    /download exceeds 64 bytes/
  );

  await assert.rejects(
    fs.stat(path.join(workspaceRoot, project.id, "media", "oversized.mp4")),
    { code: "ENOENT" }
  );
});

test("RawForm upstream fetches time out with a controlled response", async (t) => {
  const app = await createTestApp();
  t.after(async () => app.close());
  setRawFormHandler(() => undefined);

  const response = await app.inject({ method: "GET", url: "/rawform/sessions" });

  assert.equal(response.statusCode, 504);
  assert.match(response.json().error, /timed out after 100ms/);
  assert.equal(rawFormCallCount, 1);
});

test("RawForm edit submission streams final export instead of reading it into memory", async (t: TestContext) => {
  const app = await createTestApp();
  t.after(async () => app.close());
  const project = await createProject("RawForm Edit Test");
  await writeProject({
    ...project,
    source: {
      ...project.source,
      filename: `rawform-${RAWFORM_SESSION_ID}.mp4`,
      rawFormSessionId: RAWFORM_SESSION_ID,
    },
  });

  const finalBody = Buffer.from("streamed-final-mp4");
  const exportDir = path.join(workspaceRoot, project.id, "exports", "2026-06-09T000000");
  await fs.mkdir(exportDir, { recursive: true });
  await fs.writeFile(path.join(exportDir, "final.mp4"), finalBody);
  await fs.writeFile(path.join(exportDir, "manifest.json"), JSON.stringify({ ok: true }));

  let uploadedBody: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let manifestBody: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  setRawFormHandler(async (request, response) => {
    if (request.url?.startsWith(`/api/edited_clip/${RAWFORM_SESSION_ID}/upload`)) {
      uploadedBody = await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ edited_media_key: "edited/key.mp4" }));
      return;
    }
    if (request.url === "/api/edit_manifest") {
      manifestBody = await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });

  const originalReadFile = fs.readFile.bind(fs);
  t.mock.method(fs, "readFile", (async (...args: unknown[]) => {
    if (String(args[0]).endsWith("final.mp4")) {
      throw new Error("final mp4 readFile should not be used");
    }
    return originalReadFile(args[0] as Parameters<typeof fs.readFile>[0], args[1] as Parameters<typeof fs.readFile>[1]);
  }) as typeof fs.readFile);

  const response = await app.inject({
    method: "POST",
    url: "/rawform/edit-submissions",
    payload: {
      projectId: project.id,
      sessionId: RAWFORM_SESSION_ID,
      editType: "unsigned",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(uploadedBody, finalBody);
  const manifest = JSON.parse(manifestBody.toString()) as {
    edited_media_bytes: number;
    edited_media_sha256: string;
    content_tools: { project_id: string };
  };
  assert.equal(manifest.edited_media_bytes, finalBody.length);
  assert.equal(manifest.edited_media_sha256, createHash("sha256").update(finalBody).digest("hex"));
  assert.equal(manifest.content_tools.project_id, project.id);
});
