FROM node:22-alpine
# ffmpeg extracts the video poster frame the gallery previews are built from
# (packages/providers/src/core/thumbnail.ts). Alpine's musl-native package is
# deliberate: ffmpeg-static's npm binaries are glibc-linked and will not exec in
# this image. Without it the worker still runs — poster extraction is skipped and
# the frontend keeps decoding frame zero itself.
RUN apk add --no-cache ffmpeg
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web-next/package.json apps/web-next/package.json
COPY apps/api/package.json apps/api/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/providers/package.json packages/providers/package.json
RUN pnpm install --frozen-lockfile
COPY apps/worker apps/worker
COPY packages packages
CMD ["pnpm", "--filter", "@musecanvas/worker", "start"]
