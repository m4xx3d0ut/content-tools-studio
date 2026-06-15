import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const serverRoot = path.join(repoRoot, "apps", "server");
const webRoot = path.join(repoRoot, "apps", "web", "dist");
const indexPath = path.join(webRoot, "index.html");
const backendPort = Number(process.env.PORT || 3033);
const frontendPort = Number(process.env.WORKERBEE_PORT || 8080);

await mkdir(process.env.WORKSPACE_ROOT || "/data/workspace", { recursive: true });

const backend = spawn(process.execPath, ["dist/index.js"], {
  cwd: serverRoot,
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(backendPort),
  },
  stdio: "inherit",
});

backend.on("exit", (code, signal) => {
  console.error(`backend exited with code=${code} signal=${signal}`);
  process.exit(code ?? 1);
});

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
]);

function proxyToBackend(req, res) {
  const upstream = httpRequest(
    {
      hostname: "127.0.0.1",
      port: backendPort,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${backendPort}` },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );

  upstream.on("error", (error) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: error.message }));
  });

  req.pipe(upstream);
}

function proxyHealth(res) {
  const req = httpRequest(
    { hostname: "127.0.0.1", port: backendPort, path: "/health", method: "GET" },
    (upstreamRes) => {
      const ok = upstreamRes.statusCode && upstreamRes.statusCode >= 200 && upstreamRes.statusCode < 300;
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok }));
      upstreamRes.resume();
    },
  );

  req.on("error", (error) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: error.message }));
  });
  req.end();
}

async function serveStatic(req, res) {
  const rawPath = new URL(req.url || "/", `http://127.0.0.1:${frontendPort}`).pathname;
  const decodedPath = decodeURIComponent(rawPath);
  const normalizedPath = path
    .normalize(decodedPath)
    .replace(/^(\.\.[/\\])+/, "")
    .replace(/^[/\\]+/, "");
  let filePath = path.join(webRoot, normalizedPath);

  if (!filePath.startsWith(webRoot)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (fileStat.isDirectory()) filePath = path.join(filePath, "index.html");
  } catch {
    filePath = indexPath;
  }

  const ext = path.extname(filePath);
  res.writeHead(200, { "content-type": mimeTypes.get(ext) || "application/octet-stream" });
  createReadStream(filePath).pipe(res);
}

const server = createServer((req, res) => {
  const pathname = new URL(req.url || "/", `http://127.0.0.1:${frontendPort}`).pathname;
  if (pathname === "/healthz") {
    proxyHealth(res);
    return;
  }
  if (
    pathname === "/health" ||
    pathname === "/openapi.json" ||
    pathname.startsWith("/docs") ||
    pathname.startsWith("/automation") ||
    pathname.startsWith("/rawform") ||
    pathname.startsWith("/render") ||
    pathname.startsWith("/projects") ||
    pathname.startsWith("/slugs") ||
    pathname.startsWith("/templates")
  ) {
    proxyToBackend(req, res);
    return;
  }
  serveStatic(req, res).catch((error) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: error.message }));
  });
});

server.listen(frontendPort, "0.0.0.0", () => {
  console.log(`workerbee frontend listening on ${frontendPort}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    backend.kill(signal);
    server.close(() => process.exit(0));
  });
}
