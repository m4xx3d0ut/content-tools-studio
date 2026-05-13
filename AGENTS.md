# Repository Guidelines

## Project Structure & Module Organization

This is a private npm workspace for a local-first video overlay editor and renderer. The React/Vite UI lives in `apps/web/src`, with static browser assets in `apps/web/public`. The Fastify API lives in `apps/server/src`, organized by `routes/`, `services/`, `utils/`, and `config.ts`. Shared Zod schemas and TypeScript types live in `packages/shared/src`.

Repo-level media and render assets are part of the app surface: `1920x1080/` contains card template source assets, `k1s-directional-arrows/` contains arrow assets, `slug/` contains intro/outro clips, and `filter_complex*.txt` files document FFmpeg filter variants. Generated local projects and exports belong in `workspace/`, which is ignored.

## Build, Test, and Development Commands

- `npm install`: install workspace dependencies.
- `npm run dev:all`: run shared package watch, API server, and web UI together.
- `npm run dev:web`: start only the Vite UI at `http://localhost:5173`.
- `npm run dev:server`: build shared types and run the Fastify server with `tsx watch`.
- `npm run build`: compile shared, server, and web packages.
- `npm run lint`: currently a placeholder; do not treat it as validation.

The app expects Node.js 20+ and `ffmpeg`/`ffprobe` on `PATH`. Optional runtime configuration includes `WORKSPACE_ROOT`, `FFMPEG_PATH`, `FFPROBE_PATH`, `HOST`, and `PORT`.

## Coding Style & Naming Conventions

Use TypeScript ES modules, two-space indentation, double quotes, and semicolons only where existing files use them. Prefer `const` and small helper functions near their call sites. Name React components and types in `PascalCase`; functions, variables, and route/service files use `camelCase` or lowercase descriptive names such as `template-assets.ts`. Keep schemas in `packages/shared` when server and client both depend on the contract.

## Testing Guidelines

No automated test runner is configured yet. For now, run `npm run build` before submitting changes; this is the primary type-check and production-build gate. When adding tests, colocate them with the relevant package and use explicit names such as `exporter.test.ts` or `App.test.tsx`. For render changes, manually verify a sample MP4 import, overlay placement, and final export.

## Commit & Pull Request Guidelines

Recent commits use short imperative subjects, for example `Add rough preview render mode` and `Fix thumbnail handling and scrubber seek behavior`. Follow that style: start with a verb, keep the subject specific, and avoid trailing punctuation.

Pull requests should include a concise summary, validation steps run, linked issue or task context when available, and screenshots or short screen recordings for UI/editor changes. Mention any FFmpeg behavior changes and new environment variables explicitly.
