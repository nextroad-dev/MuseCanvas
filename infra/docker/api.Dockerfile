FROM node:22-alpine AS build
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
RUN pnpm --filter @musecanvas/api build
CMD ["sh", "-c", "pnpm --filter @musecanvas/database exec tsx src/migrate.ts && pnpm --filter @musecanvas/database exec tsx src/seed.ts && pnpm --filter @musecanvas/api start"]
