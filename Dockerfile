FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci

COPY . .

RUN VITE_API_BASE="" npm run build

ENV NODE_ENV=production \
  HOST=127.0.0.1 \
  PORT=3033 \
  WORKSPACE_ROOT=/data/workspace \
  REPO_ROOT=/app \
  FFMPEG_PATH=/usr/bin/ffmpeg \
  FFPROBE_PATH=/usr/bin/ffprobe

EXPOSE 8080

CMD ["node", "/app/scripts/workerbee-start.mjs"]
