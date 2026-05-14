import { SERVER_HOST, SERVER_PORT } from "./config.js";
import { buildApp } from "./app.js";

const app = await buildApp();
await app.listen({ host: SERVER_HOST, port: SERVER_PORT });
