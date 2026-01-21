import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { SERVER_HOST, SERVER_PORT } from "./config.js";
import { projectsRoutes } from "./routes/projects.js";
import { ensureWorkspaceRoot } from "./services/workspace.js";

const app = Fastify({ logger: true });

await ensureWorkspaceRoot();

await app.register(cors, { origin: true });
await app.register(multipart);

app.get("/health", async () => ({ ok: true, at: new Date().toISOString() }));

await app.register(projectsRoutes, { prefix: "/projects" });

app.listen({ host: SERVER_HOST, port: SERVER_PORT });
