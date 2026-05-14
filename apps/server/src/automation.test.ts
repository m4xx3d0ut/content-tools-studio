import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

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
  assert.ok(document.components.schemas.SlugAsset);
  assert.ok(document.components.schemas.SlugListResponse);
  assert.ok(document.paths["/projects/{id}/commands"]);
  assert.ok(document.paths["/projects/import-bundle"]);
  assert.ok(document.paths["/projects/{id}/bundle"]);
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
    document.paths["/projects/{id}/exports/latest"].get.responses["200"].content["video/mp4"]
  );
  assert.ok(
    document.paths["/projects/{id}/bundle"].get.responses["200"].content["application/zip"]
  );
  assert.ok(document.paths["/slugs"].get.responses["200"].content["application/json"]);
  assert.ok(document.paths["/slugs"].post.responses["201"].content["application/json"]);
  assert.ok(document.paths["/slugs/{id}/media"].get.responses["200"].content["video/mp4"]);

  const templatesResponse = await app.inject({ method: "GET", url: "/templates" });
  assert.equal(templatesResponse.statusCode, 200);
  assert.equal(templatesResponse.json().templates[0].id, "card-lower-third-left");
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
  assert.match(filter, /trim=start_frame=1050:end_frame=9000,setpts=\(PTS-STARTPTS\)\/53/);
  assert.match(filter, /atempo=2/);
  assert.match(filter, /concat=n=2:v=1:a=0,setpts=PTS-STARTPTS/);
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
              startFrame: 0,
              endFrameExclusive: 60,
              playbackRate: 2,
              audio: "preserve",
            },
            {
              id: "seg-2",
              startFrame: 60,
              endFrameExclusive: 90,
              playbackRate: 1,
              audio: "preserve",
            },
            {
              id: "seg-3",
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

  const { renderFinal } = await import("./services/exporter.js");
  const renderResult = await renderFinal(updatedProject, {
    includeAudio: true,
    presetId: "roughPreview",
  });
  assert.equal(renderResult.manifest.sourceSegmentOutputFrames, 75);
  assert.equal(renderResult.manifest.sourceSegmentOutputDurationSec, 2.5);

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
  assert.ok(duration >= 2.4 && duration <= 2.65, `duration was ${duration}`);
  assert.ok(frames >= 72 && frames <= 78, `frame count was ${frames}`);

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
  assert.ok(slugDuration >= 3.4 && slugDuration <= 3.65, `slug duration was ${slugDuration}`);
  assert.ok(slugFrames >= 102 && slugFrames <= 108, `slug frame count was ${slugFrames}`);
});
