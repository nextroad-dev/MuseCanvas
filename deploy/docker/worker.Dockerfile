FROM node:22-alpine
# Pin the corepack cache outside /root: the image ships pnpm only as a corepack
# shim, and /root is mode 0700, so the non-root runtime user below could not
# reach the build-time cache and would re-download pnpm on every container start.
ENV COREPACK_HOME=/opt/corepack
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
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/providers/package.json packages/providers/package.json
RUN pnpm install --frozen-lockfile
COPY apps/worker apps/worker
COPY packages packages

# Drop to an unprivileged user. The worker writes only outside /app: poster
# extraction mkdtemps under os.tmpdir() and the plugin loader materializes
# verified artifacts into PLUGIN_CACHE_DIR (/tmp/musecanvas-plugin-cache by
# default), both of which live on the world-writable /tmp. The cache dir is
# pre-created here so the default path exists even when /tmp is a tmpfs mount.
RUN addgroup -S app && adduser -S -G app app \
 && mkdir -p /tmp/musecanvas-plugin-cache \
 && chown -R app:app /app /opt/corepack /tmp/musecanvas-plugin-cache
USER app
CMD ["pnpm", "--filter", "@musecanvas/worker", "start"]
