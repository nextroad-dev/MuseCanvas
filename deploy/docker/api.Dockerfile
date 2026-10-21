FROM node:22-alpine AS build
# Pin the corepack cache outside /root: the image ships pnpm only as a corepack
# shim, and /root is mode 0700, so the non-root runtime user below could not
# reach the build-time cache and would re-download pnpm on every container start.
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/providers/package.json packages/providers/package.json
RUN pnpm install --frozen-lockfile
COPY apps/api apps/api
COPY packages packages
COPY scripts scripts
RUN pnpm --filter @musecanvas/api build

# Drop to an unprivileged user. `next start` writes its image/ISR cache under
# apps/api/.next at runtime, so the whole app tree (plus the corepack cache) is
# handed to `app`; /app is otherwise root-owned and would fail on first write.
# /data/media is the mount point of the shared local-storage volume (media_data). It is
# created and owned by `app` here so a fresh named volume inherits that ownership.
RUN addgroup -S app && adduser -S -G app app \
 && mkdir -p /data/media \
 && chown -R app:app /app /opt/corepack /data/media
USER app
CMD ["pnpm", "--filter", "@musecanvas/api", "start"]
