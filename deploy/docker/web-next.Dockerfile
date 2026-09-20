FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web-next/package.json apps/web-next/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/providers/package.json packages/providers/package.json
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps/web-next apps/web-next
ENV STANDALONE=true
RUN pnpm --filter @musecanvas/web-next build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
COPY --from=build /app/apps/web-next/.next/standalone ./
COPY --from=build /app/apps/web-next/.next/static ./apps/web-next/.next/static
COPY --from=build /app/apps/web-next/public ./apps/web-next/public
EXPOSE 3000
CMD ["node", "apps/web-next/server.js"]
