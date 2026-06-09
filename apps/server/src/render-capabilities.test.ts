import test, { after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const startingCwd = process.cwd();
const repoRoot = startingCwd.endsWith(path.join("apps", "server"))
  ? path.resolve(startingCwd, "../..")
  : startingCwd;
const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "content-tools-render-capabilities-"));
process.env.WORKSPACE_ROOT = workspaceRoot;
process.env.REPO_ROOT = repoRoot;
process.chdir(path.join(repoRoot, "apps", "server"));

after(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

const { buildApp } = await import("./app.js");
const { probeRenderCapabilitiesForTests } = await import("./services/render-capabilities.js");

async function writeFakeFfmpeg(
  t: TestContext,
  options: { listNvenc: boolean; encodeSucceeds: boolean; encodeError?: string }
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "content-tools-fake-ffmpeg-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const ffmpegPath = path.join(dir, "ffmpeg");
  const script = `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("-encoders")) {
  console.log(${JSON.stringify(
    options.listNvenc
      ? " V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)"
      : " V....D libx264              libx264 H.264 encoder (codec h264)"
  )});
  process.exit(0);
}
if (${JSON.stringify(options.encodeSucceeds)}) {
  writeFileSync(args[args.length - 1], "ok");
  process.exit(0);
}
console.error(${JSON.stringify(options.encodeError ?? "Cannot load libnvidia-encode.so.1")});
process.exit(1);
`;
  await fs.writeFile(ffmpegPath, script, { mode: 0o755 });
  return ffmpegPath;
}

test("render capabilities report NVENC unavailable when encoder is missing", async (t) => {
  const fakeFfmpeg = await writeFakeFfmpeg(t, { listNvenc: false, encodeSucceeds: false });
  const capabilities = await probeRenderCapabilitiesForTests(fakeFfmpeg);

  assert.equal(capabilities.capabilities.nvenc.available, false);
  assert.match(capabilities.capabilities.nvenc.reason ?? "", /h264_nvenc is not listed/);
  assert.equal(
    capabilities.presets.find((preset) => preset.id === "nvencP5Cq20")?.available,
    false
  );
});

test("render capabilities require a successful real NVENC encode probe", async (t) => {
  const fakeFfmpeg = await writeFakeFfmpeg(t, {
    listNvenc: true,
    encodeSucceeds: false,
    encodeError: "Cannot load libnvidia-encode.so.1",
  });
  const capabilities = await probeRenderCapabilitiesForTests(fakeFfmpeg);

  assert.equal(capabilities.capabilities.nvenc.available, false);
  assert.match(capabilities.capabilities.nvenc.reason ?? "", /Cannot load libnvidia-encode/);
});

test("render capabilities expose NVENC preset availability when probe succeeds", async (t) => {
  const fakeFfmpeg = await writeFakeFfmpeg(t, { listNvenc: true, encodeSucceeds: true });
  const capabilities = await probeRenderCapabilitiesForTests(fakeFfmpeg);

  assert.equal(capabilities.capabilities.nvenc.available, true);
  assert.equal(
    capabilities.presets.find((preset) => preset.id === "nvencP5Cq20")?.available,
    true
  );
});

test("render capabilities endpoint returns preset status", async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/render/capabilities?refresh=true",
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(typeof body.checkedAt, "string");
    assert.equal(typeof body.ffmpegPath, "string");
    assert.equal(typeof body.capabilities.nvenc.available, "boolean");
    assert.ok(
      body.presets.some((preset: { id: string; available: boolean }) => preset.id === "nvencP5Cq20")
    );
  } finally {
    await app.close();
  }
});
