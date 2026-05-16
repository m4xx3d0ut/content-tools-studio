import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Project } from "@content-tools/shared";

const execFile = promisify(execFileCallback);

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

const TIMESTAMP_RECIPE = `# timestamps
0s-20s (2x speed) = Shows the demo project and that there is no yaml/yml in the repo, with WorkerBee global dash on right
25s-30s (2x speed) = shows codex session run \`/mcp\` command showing connected WorkerBee MCP on left, with WorkerBee global dash on right
30s-5m0s (5s 1x speed, remaining slice speed up to fit in 5 seconds)= bring the project up in WorkerBee with a single prompt
5m0s-5m5s (1x speed) = codex response that project has been deployed in WorkerBee
5m25s-6m0s (speed up to fit slice in 10s) = focusing on global dash showing routes, then to demo app dash showing hover tips, events, vllm openai compatible API test
6m10s-6m35s (5s 1x speed, remaining slice speed up to fit in 5s) = Scale \`backend\` to 3 replicas
6m45s-7m26s (speed up to fit in 10s) = watch replicas come up
8m25s-10m54s (speed up to fit in 10s) = WorkerBee troubleshoots, rebuilds, redeploys \`frontend\` after scaling \`backend\` up
11m10s-12m01s (2x speed)= Response for full scale prompt with \`backend\` and \`frontend\` fix, immediately followed by a WorkerBee security check and report output finishing off the video`;

const MIXED_TIMELINE_RECIPE = `# timestamps
3s = 1-connect.png
54s-1m0s = codex session /mcp connect
3s = 2-launch.png
1m3s-7m54s (10s 2x speed - speed up to fit into 5s - 5s 1x speed) = workerbee up
3s = 3-observe.png
7m57s-8m18s (speed up to fit in 5s) = k1s dashboard for project
8m48s-9m24s (speed up to fit in 5s) = Demo app running in stack
10m12s-16m45s (5s 1x speed - speed up to fit into 5s - 5s 1x speed) = BE scale, FE fix
3s = 4-secure-and-deliver.png
16m48s-17m57s (5s 1x speed - speed up to fit into 5s - 5s 1x speed) = sec test
18m45s-21m0s (5s 1x speed - speed up to fit into 5s - 5s 1x speed) = write k1s manifests to repo
3s = 5-fin.png`;

function multipartPayload(
  name: string,
  filename: string,
  content: Buffer,
  contentType = "application/octet-stream"
): { boundary: string; payload: Buffer } {
  const boundary = `----content-tools-${Date.now()}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { boundary, payload: Buffer.concat([head, content, tail]) };
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
  assert.ok(document.components.schemas.SourceSegment);
  assert.ok(document.components.schemas.ProjectBundleImport);
  assert.ok(document.components.schemas.AudioAssetImport);
  assert.ok(document.components.schemas.AudioAssetFromUrl);
  assert.ok(document.components.schemas.AudioAssetResponse);
  assert.ok(document.components.schemas.SlugAsset);
  assert.ok(document.components.schemas.SlugListResponse);
  assert.ok(document.paths["/projects/{id}/commands"]);
  assert.ok(document.paths["/projects/import-bundle"]);
  assert.ok(document.paths["/projects/{id}/bundle"]);
  assert.ok(document.paths["/projects/{id}/timeline-assets"]);
  assert.ok(document.paths["/projects/{id}/audio-assets"]);
  assert.ok(document.paths["/projects/{id}/audio-assets/from-url"]);
  assert.ok(document.paths["/projects/{id}/patch/status"]);
  assert.ok(document.paths["/projects/{id}/patch/stream"]);
  assert.ok(document.paths["/slugs"]);
  assert.ok(document.paths["/slugs/{id}/media"]);
  assert.equal(
    document.paths["/projects/{id}/commands"].post.requestBody.content["application/json"].schema
      .$ref,
    "#/components/schemas/CommandBatchRequest"
  );
  assert.ok(document.paths["/automation/capabilities"]);
  assert.ok(document.paths["/projects/{id}/timeline/parse"]);
  assert.ok(
    document.paths["/projects/{id}/events"].get.responses["200"].content["text/event-stream"]
  );
  assert.ok(
    document.paths["/projects/{id}/patch/status"].get.responses["200"].content[
      "application/json"
    ]
  );
  assert.ok(
    document.paths["/projects/{id}/patch/stream"].get.responses["200"].content[
      "text/event-stream"
    ]
  );
  assert.ok(
    document.paths["/projects/{id}/exports/latest"].get.responses["200"].content["video/mp4"]
  );
  assert.ok(
    document.paths["/projects/{id}/bundle"].get.responses["200"].content["application/zip"]
  );
  assert.ok(
    document.paths["/projects/{id}/audio-assets"].post.responses["200"].content[
      "application/json"
    ]
  );
  assert.ok(
    document.paths["/projects/{id}/audio-assets/from-url"].post.responses["200"].content[
      "application/json"
    ]
  );
  assert.ok(document.paths["/slugs"].get.responses["200"].content["application/json"]);
  assert.ok(document.paths["/slugs"].post.responses["201"].content["application/json"]);
  assert.ok(document.paths["/slugs/{id}/media"].get.responses["200"].content["video/mp4"]);

  const templatesResponse = await app.inject({ method: "GET", url: "/templates" });
  assert.equal(templatesResponse.statusCode, 200);
  assert.equal(templatesResponse.json().templates[0].id, "card-lower-third-left");
});

test("surgical patch status allows only existing overlay visual changes", async () => {
  const { getSurgicalPatchStatus, writeExportBundle } = await import("./services/exporter.js");
  const projectId = "patch-status-test";
  const projectRoot = path.join(workspaceRoot, projectId);
  await mkdir(path.join(projectRoot, "media"), { recursive: true });
  await writeFile(path.join(projectRoot, "media", "source.mp4"), "placeholder");

  const overlay = {
    id: "card-1",
    templateId: "card-lower-third-left",
    templateVersion: "1",
    startFrame: 30,
    endFrame: 90,
    rect: { x: 80, y: 80, w: 640, h: 160 },
    zIndex: 0,
    fields: { title: "Original", text: "Body" },
  };
  const project: Project = {
    schemaVersion: 1,
    revision: 1,
    id: projectId,
    name: "Patch Status Test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: { filename: "source.mp4" },
    video: {
      width: 1280,
      height: 720,
      fpsNum: 30,
      fpsDen: 1,
      durationMs: 5000,
      audio: { hasAudio: false },
    },
    proxy: { enabled: false },
    overlays: [overlay],
    exportOptions: {
      speed: 1,
      includeAudio: false,
      includeSlug: false,
      includeSlugStart: false,
      includeSlugEnd: false,
    },
    renderCache: { overlayAssetHash: {} },
  };

  const exportResult = await writeExportBundle(project, {
    includeAudio: false,
    presetId: "balanced",
  });
  assert.ok(exportResult.manifest.mainOutput);
  await writeFile(exportResult.manifest.mainOutput, "main");
  await writeFile(path.join(exportResult.exportDir, "final.mp4"), "final");

  const visualEditStatus = await getSurgicalPatchStatus(
    {
      ...project,
      overlays: [
        {
          ...overlay,
          fields: { title: "Updated", text: "Body" },
        },
      ],
    },
    { includeAudio: false, presetId: "balanced" }
  );
  assert.equal(visualEditStatus.patchable, true);
  assert.deepEqual(visualEditStatus.changedOverlayIds, ["card-1"]);
  assert.equal(visualEditStatus.affectedWindows.length, 1);

  const movedStatus = await getSurgicalPatchStatus(
    {
      ...project,
      overlays: [
        {
          ...overlay,
          rect: { ...overlay.rect, x: 120 },
        },
      ],
    },
    { includeAudio: false, presetId: "balanced" }
  );
  assert.equal(movedStatus.patchable, false);
  assert.match(movedStatus.reason ?? "", /placement|motion|layer/);
});

test("command endpoint sets and clears external audio tracks", async (t) => {
  const app = await createTestApp();
  t.after(async () => app.close());

  const createdResponse = await app.inject({
    method: "POST",
    url: "/projects",
    payload: {
      name: "Audio Command Test",
      video: { durationMs: 60000, audio: { hasAudio: false } },
    },
  });
  assert.equal(createdResponse.statusCode, 201);
  const created = createdResponse.json();

  const setResponse = await app.inject({
    method: "POST",
    url: `/projects/${created.id}/commands`,
    payload: {
      baseRevision: created.revision,
      commands: [
        {
          type: "setAudioTrack",
          audioTrack: {
            assetPath: "media/audio/bumblebee.oga",
            mode: "replace",
            startSec: 3,
            source: "url",
            filename: "bumblebee.oga",
            originalUrl:
              "https://commons.wikimedia.org/wiki/File:Rimsky-Korsakov_-_flight_of_the_bumblebee.oga",
            fadeOut: {
              enabled: true,
              target: "tailSlug",
              durationSec: 2,
            },
          },
        },
      ],
    },
  });
  assert.equal(setResponse.statusCode, 200);
  const setResult = setResponse.json();
  assert.equal(setResult.project.audioTrack.mode, "replace");
  assert.equal(setResult.project.audioTrack.startSec, 3);
  assert.equal(setResult.project.audioTrack.assetPath, "media/audio/bumblebee.oga");
  assert.equal(setResult.project.audioTrack.fadeOut.enabled, true);
  assert.equal(setResult.project.audioTrack.fadeOut.target, "tailSlug");

  const clearResponse = await app.inject({
    method: "POST",
    url: `/projects/${created.id}/commands`,
    payload: {
      baseRevision: setResult.project.revision,
      commands: [{ type: "setAudioTrack", audioTrack: null }],
    },
  });
  assert.equal(clearResponse.statusCode, 200);
  assert.equal(clearResponse.json().project.audioTrack, undefined);
});

test("timestamp shorthand supports PNG stills and three-part speed directives", async (t) => {
  const app = await createTestApp();
  t.after(async () => app.close());

  const createdResponse = await app.inject({
    method: "POST",
    url: "/projects",
    payload: {
      name: "Mixed Timeline Test",
      video: {
        width: 1920,
        height: 1080,
        fpsNum: 60,
        fpsDen: 1,
        durationMs: 1330067,
        audio: { hasAudio: true, sampleRate: 48000, channels: 2 },
      },
    },
  });
  assert.equal(createdResponse.statusCode, 201);
  const created = createdResponse.json();

  const previewResponse = await app.inject({
    method: "POST",
    url: `/projects/${created.id}/timeline/parse`,
    payload: {
      text: MIXED_TIMELINE_RECIPE,
      defaultAudio: "preserve",
      fastAudio: "mute",
    },
  });
  assert.equal(previewResponse.statusCode, 200);
  const preview = previewResponse.json();
  assert.deepEqual(preview.warnings, []);
  assert.equal(preview.segments.length, 20);
  assert.equal(preview.outputFrames, 5460);
  assert.equal(preview.outputDurationSeconds, 91);

  assert.equal(preview.segments[0].kind, "image");
  assert.equal(preview.segments[0].assetPath, "media/stills/1-connect.png");
  assert.equal(preview.segments[0].durationFrames, 180);
  assert.equal(preview.segments[0].audio, "mute");
  assert.equal(preview.segments[1].audio, "preserve");
  assert.equal(preview.segments[3].playbackRate, 2);
  assert.equal(preview.segments[3].audio, "mute");
  assert.equal(preview.segments[4].playbackRate, 79.2);
  assert.equal(preview.segments[4].audio, "mute");
  assert.equal(preview.segments[5].playbackRate, 1);
  assert.equal(preview.segments[5].audio, "preserve");
  assert.equal(preview.segments[7].playbackRate, 4.2);
  assert.equal(preview.segments[8].playbackRate, 7.2);
  assert.equal(preview.segments[9].playbackRate, 1);
  assert.equal(preview.segments[10].playbackRate, 76.6);
  assert.equal(preview.segments[11].playbackRate, 1);
  assert.equal(preview.segments[13].playbackRate, 1);
  assert.equal(preview.segments[14].playbackRate, 11.8);
  assert.equal(preview.segments[17].playbackRate, 25);
});

test("timestamp shorthand creates variable-speed source segments", async (t) => {
  const app = await createTestApp();
  t.after(async () => app.close());

  const createdResponse = await app.inject({
    method: "POST",
    url: "/projects",
    payload: {
      name: "Timeline Test",
      video: {
        width: 1280,
        height: 720,
        fpsNum: 30,
        fpsDen: 1,
        durationMs: 772166,
        audio: { hasAudio: true, sampleRate: 48000, channels: 2 },
      },
    },
  });
  assert.equal(createdResponse.statusCode, 201);
  const created = createdResponse.json();

  const previewResponse = await app.inject({
    method: "POST",
    url: `/projects/${created.id}/timeline/parse`,
    payload: { text: TIMESTAMP_RECIPE },
  });
  assert.equal(previewResponse.statusCode, 200);
  const preview = previewResponse.json();
  assert.equal(preview.segments.length, 11);
  assert.equal(preview.outputFrames, 2790);
  assert.equal(preview.outputDurationSeconds, 93);
  assert.equal(preview.segments[2].playbackRate, 1);
  assert.equal(preview.segments[3].playbackRate, 53);

  const mutedPreviewResponse = await app.inject({
    method: "POST",
    url: `/projects/${created.id}/timeline/parse`,
    payload: { text: TIMESTAMP_RECIPE, fastAudio: "mute" },
  });
  assert.equal(mutedPreviewResponse.statusCode, 200);
  const mutedPreview = mutedPreviewResponse.json();
  assert.equal(mutedPreview.segments[0].audio, "mute");
  assert.equal(mutedPreview.segments[2].audio, "preserve");

  const commandResponse = await app.inject({
    method: "POST",
    url: `/projects/${created.id}/commands`,
    payload: {
      baseRevision: created.revision,
      commands: [{ type: "setSourceSegmentsFromText", text: TIMESTAMP_RECIPE }],
    },
  });
  assert.equal(commandResponse.statusCode, 200);
  const commandResult = commandResponse.json();
  assert.equal(commandResult.project.edits.sourceSegments.length, 11);
  assert.equal(commandResult.project.exportOptions.speed, 1);

  const bundleResponse = await app.inject({
    method: "GET",
    url: `/projects/${created.id}/bundle?mode=project`,
  });
  assert.equal(bundleResponse.statusCode, 200);
  assert.match(bundleResponse.headers["content-type"] as string, /application\/zip/);

  const bundleMultipart = multipartPayload(
    "file",
    "timeline-project.zip",
    Buffer.from(bundleResponse.rawPayload),
    "application/zip"
  );
  const importBundleResponse = await app.inject({
    method: "POST",
    url: "/projects/import-bundle",
    headers: {
      "content-type": `multipart/form-data; boundary=${bundleMultipart.boundary}`,
      "content-length": String(bundleMultipart.payload.length),
    },
    payload: bundleMultipart.payload,
  });
  assert.equal(importBundleResponse.statusCode, 201);
  const imported = importBundleResponse.json();
  assert.notEqual(imported.id, created.id);
  assert.equal(imported.edits.sourceSegments.length, 11);
  assert.equal(imported.revision, 1);

  const exportResponse = await app.inject({
    method: "POST",
    url: `/projects/${created.id}/export`,
    payload: { includeAudio: true },
  });
  assert.equal(exportResponse.statusCode, 200);
  const exportResult = exportResponse.json();
  const filter = await readFile(
    path.join(exportResult.exportDir, exportResult.manifest.filterCards),
    "utf-8"
  );
  assert.equal(exportResult.manifest.timelineInputs.length, 0);
  assert.match(exportResult.manifest.source, /timeline_source\.mp4$/);
  assert.match(exportResult.manifest.timelineSource, /media\/source\.mp4$/);
  assert.match(filter, /\[0:v\]setpts=PTS-STARTPTS,trim=duration=93/);
  assert.equal(exportResult.manifest.sourceSegmentOutputFrames, 2790);
  assert.equal(exportResult.manifest.sourceSegmentOutputDurationSec, 93);
});

test("slug library upload, delete conflicts, and bundle restore", async (t) => {
  const { FFMPEG_PATH, FFPROBE_PATH } = await import("./config.js");
  try {
    await execFile(FFMPEG_PATH, ["-version"]);
    await execFile(FFPROBE_PATH, ["-version"]);
  } catch {
    t.skip("ffmpeg/ffprobe unavailable");
    return;
  }

  const app = await createTestApp();
  t.after(async () => app.close());

  const slugSource = path.join(workspaceRoot, "uploaded-slug.mp4");
  await execFile(FFMPEG_PATH, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=30:duration=1",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "28",
    "-pix_fmt",
    "yuv420p",
    slugSource,
  ]);
  const slugUpload = multipartPayload(
    "file",
    "uploaded-slug.mp4",
    await readFile(slugSource),
    "video/mp4"
  );
  const uploadResponse = await app.inject({
    method: "POST",
    url: "/slugs",
    headers: {
      "content-type": `multipart/form-data; boundary=${slugUpload.boundary}`,
      "content-length": String(slugUpload.payload.length),
    },
    payload: slugUpload.payload,
  });
  assert.equal(uploadResponse.statusCode, 201);
  const slug = uploadResponse.json();
  assert.match(slug.path, /^slugs\/media\//);
  assert.equal(slug.video.durationMs, 1000);

  const listResponse = await app.inject({ method: "GET", url: "/slugs" });
  assert.equal(listResponse.statusCode, 200);
  assert.ok(listResponse.json().slugs.some((item: { id: string }) => item.id === slug.id));

  const mediaResponse = await app.inject({ method: "GET", url: `/slugs/${slug.id}/media` });
  assert.equal(mediaResponse.statusCode, 200);
  assert.match(mediaResponse.headers["content-type"] as string, /video\/mp4/);

  const createdResponse = await app.inject({
    method: "POST",
    url: "/projects",
    payload: { name: "Slug Bundle Test" },
  });
  assert.equal(createdResponse.statusCode, 201);
  const created = createdResponse.json();

  const setSlugResponse = await app.inject({
    method: "POST",
    url: `/projects/${created.id}/commands`,
    payload: {
      baseRevision: created.revision,
      commands: [
        {
          type: "setSlug",
          slug: {
            introPath: slug.path,
            outroPath: slug.path,
            fps: 30,
            transition: { type: "cut", durationFrames: 0 },
          },
        },
      ],
    },
  });
  assert.equal(setSlugResponse.statusCode, 200);
  const projectWithSlug = setSlugResponse.json().project;

  const bundleResponse = await app.inject({
    method: "GET",
    url: `/projects/${created.id}/bundle?mode=project-media`,
  });
  assert.equal(bundleResponse.statusCode, 200);

  const blockedDeleteResponse = await app.inject({
    method: "DELETE",
    url: `/slugs/${slug.id}`,
  });
  assert.equal(blockedDeleteResponse.statusCode, 409);
  assert.equal(blockedDeleteResponse.json().projects[0].id, created.id);

  const clearSlugResponse = await app.inject({
    method: "POST",
    url: `/projects/${created.id}/commands`,
    payload: {
      baseRevision: projectWithSlug.revision,
      commands: [{ type: "setSlug", slug: null }],
    },
  });
  assert.equal(clearSlugResponse.statusCode, 200);

  const deleteResponse = await app.inject({ method: "DELETE", url: `/slugs/${slug.id}` });
  assert.equal(deleteResponse.statusCode, 200);

  const bundleMultipart = multipartPayload(
    "file",
    "slug-project.zip",
    Buffer.from(bundleResponse.rawPayload),
    "application/zip"
  );
  const importBundleResponse = await app.inject({
    method: "POST",
    url: "/projects/import-bundle",
    headers: {
      "content-type": `multipart/form-data; boundary=${bundleMultipart.boundary}`,
      "content-length": String(bundleMultipart.payload.length),
    },
    payload: bundleMultipart.payload,
  });
  assert.equal(importBundleResponse.statusCode, 201);
  const imported = importBundleResponse.json();
  assert.equal(imported.slug.introPath, slug.path);

  const restoredListResponse = await app.inject({ method: "GET", url: "/slugs" });
  assert.equal(restoredListResponse.statusCode, 200);
  const restoredSlug = restoredListResponse
    .json()
    .slugs.find((item: { id: string }) => item.id === slug.id);
  assert.ok(restoredSlug);
  assert.equal(restoredSlug.usageCount, 1);
});

test("external audio URL import can replace final render audio", async (t) => {
  const { FFMPEG_PATH, FFPROBE_PATH } = await import("./config.js");
  try {
    await execFile(FFMPEG_PATH, ["-version"]);
    await execFile(FFPROBE_PATH, ["-version"]);
  } catch {
    t.skip("ffmpeg/ffprobe unavailable");
    return;
  }

  const app = await createTestApp();
  t.after(async () => app.close());

  const createdResponse = await app.inject({
    method: "POST",
    url: "/projects",
    payload: {
      name: "External Audio Render Test",
      video: {
        width: 160,
        height: 90,
        fpsNum: 30,
        fpsDen: 1,
        durationMs: 2000,
        audio: { hasAudio: false },
      },
    },
  });
  assert.equal(createdResponse.statusCode, 201);
  const created = createdResponse.json();

  const mediaDir = path.join(workspaceRoot, created.id, "media");
  await mkdir(mediaDir, { recursive: true });
  const sourcePath = path.join(mediaDir, "source.mp4");
  await execFile(FFMPEG_PATH, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=30:duration=2",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "28",
    "-pix_fmt",
    "yuv420p",
    sourcePath,
  ]);
  const slugPath = path.join(mediaDir, "slug.mp4");
  await execFile(FFMPEG_PATH, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x111111:size=160x90:rate=30:duration=1",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "28",
    "-pix_fmt",
    "yuv420p",
    slugPath,
  ]);

  const tonePath = path.join(workspaceRoot, "tone.wav");
  await execFile(FFMPEG_PATH, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=660:sample_rate=48000:duration=5",
    "-c:a",
    "pcm_s16le",
    tonePath,
  ]);
  const toneBuffer = await readFile(tonePath);
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "audio/wav",
      "content-disposition": "attachment; filename=\"tone.wav\"",
      "content-length": toneBuffer.length,
    });
    response.end(toneBuffer);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.close();
  });
  const address = server.address() as AddressInfo;

  const audioImportResponse = await app.inject({
    method: "POST",
    url: `/projects/${created.id}/audio-assets/from-url`,
    payload: { url: `http://127.0.0.1:${address.port}/tone.wav` },
  });
  assert.equal(audioImportResponse.statusCode, 200);
  const audioAsset = audioImportResponse.json();
  assert.equal(audioAsset.source, "url");
  assert.equal(audioAsset.filename, "tone.wav");
  assert.equal(audioAsset.audio.sampleRate, 48000);

  const commandResponse = await app.inject({
    method: "POST",
    url: `/projects/${created.id}/commands`,
    payload: {
      baseRevision: created.revision,
      commands: [
        {
          type: "setSlug",
          slug: {
            introPath: "media/slug.mp4",
            outroPath: "media/slug.mp4",
            fps: 30,
            transition: { type: "cut", durationFrames: 0 },
          },
        },
        {
          type: "setAudioTrack",
          audioTrack: {
            assetPath: audioAsset.path,
            mode: "replace",
            startSec: 0.25,
            source: "url",
            filename: audioAsset.filename,
            originalUrl: audioAsset.originalUrl,
            fadeOut: {
              enabled: true,
              target: "tailSlug",
              durationSec: 0.5,
            },
          },
        },
      ],
    },
  });
  assert.equal(commandResponse.statusCode, 200);
  const projectWithAudio = commandResponse.json().project;
  assert.equal(projectWithAudio.audioTrack.mode, "replace");
  assert.equal(projectWithAudio.audioTrack.fadeOut.durationSec, 0.5);

  const bundleResponse = await app.inject({
    method: "GET",
    url: `/projects/${created.id}/bundle?mode=project-media`,
  });
  assert.equal(bundleResponse.statusCode, 200);
  const { unzipSync } = await import("fflate");
  const projectMediaBundle = unzipSync(new Uint8Array(bundleResponse.rawPayload));
  assert.ok(projectMediaBundle["media/audio/tone.wav"]);

  const { renderFinal } = await import("./services/exporter.js");
  const renderResult = await renderFinal(projectWithAudio, {
    includeAudio: false,
    includeSlugStart: true,
    includeSlugEnd: true,
    presetId: "roughPreview",
  });
  assert.equal(renderResult.manifest.audioTrack?.mode, "replace");
  assert.equal(renderResult.manifest.tailSlugStartSec, 3);
  assert.equal(renderResult.manifest.externalAudioFadeOutStartSec, 2.5);
  assert.equal(renderResult.manifest.externalAudioFadeOutEndSec, 3);

  const { stdout } = await execFile(FFPROBE_PATH, [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=sample_rate,channels,duration",
    "-of",
    "json",
    renderResult.finalPath,
  ]);
  const stream = JSON.parse(stdout).streams[0] as {
    sample_rate?: string;
    channels?: number;
    duration?: string;
  };
  assert.equal(stream.sample_rate, "48000");
  assert.equal(stream.channels, 2);
  const duration = Number(stream.duration);
  assert.ok(duration >= 3.9 && duration <= 4.1, `audio duration was ${duration}`);

  const volumeProbe = await execFile(FFMPEG_PATH, [
    "-hide_banner",
    "-nostats",
    "-i",
    renderResult.finalPath,
    "-vn",
    "-af",
    "atrim=start=3.1:end=3.8,volumedetect",
    "-f",
    "null",
    "-",
  ]);
  const meanVolume = volumeProbe.stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/);
  assert.ok(meanVolume, volumeProbe.stderr);
  assert.ok(Number(meanVolume[1]) < -50, `tail mean volume was ${meanVolume[1]} dB`);
});

test("source segment render duration matches computed output frames", async (t) => {
  const { FFMPEG_PATH, FFPROBE_PATH } = await import("./config.js");
  try {
    await execFile(FFMPEG_PATH, ["-version"]);
    await execFile(FFPROBE_PATH, ["-version"]);
  } catch {
    t.skip("ffmpeg/ffprobe unavailable");
    return;
  }

  const app = await createTestApp();
  t.after(async () => app.close());

  const createdResponse = await app.inject({
    method: "POST",
    url: "/projects",
    payload: {
      name: "Duration Render Test",
      video: {
        width: 160,
        height: 90,
        fpsNum: 30,
        fpsDen: 1,
        durationMs: 5000,
        audio: { hasAudio: true, sampleRate: 48000, channels: 1 },
      },
    },
  });
  assert.equal(createdResponse.statusCode, 201);
  const created = createdResponse.json();

  const mediaDir = path.join(workspaceRoot, created.id, "media");
  await mkdir(mediaDir, { recursive: true });
  const sourcePath = path.join(mediaDir, "source.mp4");
  await execFile(FFMPEG_PATH, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=30:duration=5",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=880:sample_rate=48000:duration=5",
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "28",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    sourcePath,
  ]);
  const stillDir = path.join(mediaDir, "stills");
  await mkdir(stillDir, { recursive: true });
  const stillPath = path.join(stillDir, "still.png");
  await execFile(FFMPEG_PATH, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x224466:size=160x90:rate=30",
    "-frames:v",
    "1",
    stillPath,
  ]);

  const commandResponse = await app.inject({
    method: "POST",
    url: `/projects/${created.id}/commands`,
    payload: {
      baseRevision: created.revision,
      commands: [
        {
          type: "setSourceSegments",
          segments: [
            {
              id: "seg-1",
              kind: "source",
              startFrame: 0,
              endFrameExclusive: 60,
              playbackRate: 2,
              audio: "preserve",
            },
            {
              id: "still-1",
              kind: "image",
              label: "Still",
              startFrame: 0,
              endFrameExclusive: 1,
              playbackRate: 1,
              assetPath: "media/stills/still.png",
              durationFrames: 30,
              audio: "mute",
            },
            {
              id: "seg-2",
              kind: "source",
              startFrame: 60,
              endFrameExclusive: 90,
              playbackRate: 1,
              audio: "preserve",
            },
            {
              id: "seg-3",
              kind: "source",
              startFrame: 90,
              endFrameExclusive: 150,
              playbackRate: 4,
              audio: "mute",
            },
          ],
        },
      ],
    },
  });
  assert.equal(commandResponse.statusCode, 200);
  const updatedProject = commandResponse.json().project;

  const projectMediaBundleResponse = await app.inject({
    method: "GET",
    url: `/projects/${created.id}/bundle?mode=project-media`,
  });
  assert.equal(projectMediaBundleResponse.statusCode, 200);
  const { unzipSync } = await import("fflate");
  const projectMediaBundle = unzipSync(new Uint8Array(projectMediaBundleResponse.rawPayload));
  assert.ok(projectMediaBundle["media/stills/still.png"]);

  const { renderFinal } = await import("./services/exporter.js");
  const renderResult = await renderFinal(updatedProject, {
    includeAudio: true,
    presetId: "roughPreview",
  });
  assert.equal(renderResult.manifest.timelineInputs.length, 0);
  assert.equal(renderResult.manifest.timelineAssetInputs?.length, 1);
  assert.equal(renderResult.manifest.sourceSegmentOutputFrames, 105);
  assert.equal(renderResult.manifest.sourceSegmentOutputDurationSec, 3.5);

  const { stdout } = await execFile(FFPROBE_PATH, [
    "-v",
    "error",
    "-count_frames",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=nb_read_frames,duration",
    "-of",
    "json",
    renderResult.finalPath,
  ]);
  const stream = JSON.parse(stdout).streams[0] as { nb_read_frames?: string; duration?: string };
  const duration = Number(stream.duration);
  const frames = Number(stream.nb_read_frames);
  assert.ok(duration >= 3.4 && duration <= 3.65, `duration was ${duration}`);
  assert.ok(frames >= 102 && frames <= 108, `frame count was ${frames}`);

  const slugSource = path.join(workspaceRoot, "duration-slug.mp4");
  await execFile(FFMPEG_PATH, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=30:duration=1",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "28",
    "-pix_fmt",
    "yuv420p",
    slugSource,
  ]);
  const slugUpload = multipartPayload(
    "file",
    "duration-slug.mp4",
    await readFile(slugSource),
    "video/mp4"
  );
  const uploadResponse = await app.inject({
    method: "POST",
    url: "/slugs",
    headers: {
      "content-type": `multipart/form-data; boundary=${slugUpload.boundary}`,
      "content-length": String(slugUpload.payload.length),
    },
    payload: slugUpload.payload,
  });
  assert.equal(uploadResponse.statusCode, 201);
  const slug = uploadResponse.json();

  const renderWithSlug = await renderFinal(
    {
      ...updatedProject,
      slug: {
        introPath: slug.path,
        outroPath: slug.path,
        fps: 30,
        transition: { type: "cut", durationFrames: 0 },
      },
    },
    {
      includeAudio: false,
      includeSlugStart: true,
      includeSlugEnd: false,
      presetId: "roughPreview",
    }
  );
  const slugProbe = await execFile(FFPROBE_PATH, [
    "-v",
    "error",
    "-count_frames",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=nb_read_frames,duration",
    "-of",
    "json",
    renderWithSlug.finalPath,
  ]);
  const slugStream = JSON.parse(slugProbe.stdout).streams[0] as {
    nb_read_frames?: string;
    duration?: string;
  };
  const slugDuration = Number(slugStream.duration);
  const slugFrames = Number(slugStream.nb_read_frames);
  assert.ok(slugDuration >= 4.4 && slugDuration <= 4.65, `slug duration was ${slugDuration}`);
  assert.ok(slugFrames >= 132 && slugFrames <= 138, `slug frame count was ${slugFrames}`);
});
