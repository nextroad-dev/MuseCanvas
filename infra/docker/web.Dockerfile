FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/providers/package.json packages/providers/package.json
RUN pnpm install --frozen-lockfile
COPY apps/web apps/web
COPY infra/nginx/web.conf infra/nginx/web.conf
ARG VITE_API_BASE_URL=
ARG VITE_USE_MOCK=false
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL VITE_USE_MOCK=$VITE_USE_MOCK
RUN pnpm --filter @musecanvas/web build
FROM nginx:1.27-alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY infra/nginx/web.conf /etc/nginx/conf.d/default.conf
