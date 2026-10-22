FROM node:22.23.4-alpine AS build
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
COPY packages packages
COPY apps/web apps/web
ENV STANDALONE=true
RUN pnpm --filter @musecanvas/web build

FROM node:22.23.4-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public

# Drop to an unprivileged user. The standalone server.js reads its own bundle
# but still writes the Next.js runtime cache under apps/web/.next, so the
# copied tree (root-owned by default from COPY) is handed to `app`.
RUN addgroup -S app && adduser -S -G app app \
 && chown -R app:app /app
USER app
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
