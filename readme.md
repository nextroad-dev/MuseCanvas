<div align="center">

# MuseCanvas

**Self-hosted multi-model AI art studio**

English | [简体中文](README.zh-CN.md)

</div>

MuseCanvas is a self-hosted creative platform for multiple image generation models. It brings user creation, model configuration, provider credentials, prompt preprocessing, task queueing and artwork history into one workflow: the backend handles authentication, credential encryption, task persistence and asynchronous processing, while the frontend only consumes security-filtered API data.

## Why MuseCanvas?

- **Multi-provider by design** — image and video generation through pluggable provider plugins; provider API keys, base URLs and model protocols are all configured in the admin console, stored encrypted and write-only.
- **Team-ready out of the box** — email OTP, invite-based registration and GitHub / Google OAuth sign-in, with an admin console covering users, models, credentials and tasks.
- **Reliable async pipeline** — Redis Streams with a transactional outbox, idempotent SQL migrations, and S3-compatible object storage for generated results.
- **One-command self-hosting** — `pnpm compose:up` starts the full local stack; the first visit walks you through the guided `/setup` wizard instead of editing env files.

## Current Capabilities

- Email OTP, invite-based registration, GitHub / Google OAuth sign-in, and third-party account binding/unbinding.
- User workspace, generation task progress, history and result details.
- Admin console: user management, OAuth provider configuration, model management, provider credential management, and task inspection.
- Multi-provider image generation adapters; provider API keys, base URLs and model protocols are configured in the admin console, with sensitive fields write-only.
- LLM prompt preprocessing templates, read at runtime by the API / Worker from an external template index.
- PostgreSQL persists core data, Redis handles queue state, rate limiting and ephemeral caches, and S3-compatible object storage keeps generated results.
- Docker Compose full-stack local startup, GHCR image deployment, and a GitHub Actions image build pipeline.

## Tech Stack

- Frontend: Next.js 15 (App Router, React 19), Zustand, TanStack Query, Tailwind CSS; hybrid rendering with SSR guards + Client Islands.
- API: Next.js API Routes, TypeScript, PostgreSQL, Redis.
- Worker: a standalone TypeScript process that consumes the generation queue and background jobs.
- Infrastructure: Docker Compose, Nginx, GitHub Actions, GitHub Container Registry, S3-compatible object storage.

## Directory Structure

```text
apps/
  web/       Next.js 15 (React 19) frontend application
  api/       Next.js API application
  worker/    Background task worker
packages/
  config/    Server-side environment variable reading and validation
  contracts/ Browser-safe DTOs, shared types and error codes
  database/  Migrations, transactions and data access
  domain/    Framework-agnostic business rules and state machines
  providers/ Image/video generation plugins and credential encryption (object-storage client lives in apps/worker, SMTP in apps/api)
docs/        Feature designs, implementation records and design system
deploy/      Compose orchestration, Dockerfiles and Nginx configuration
scripts/     Local and deployment helper scripts
.github/     GitHub Actions workflows
```

## Plugin Development Guide

Development specs for model provider plugins (image / video) are maintained separately in the [MuseCanvas-Connector](https://github.com/nextroad-dev/MuseCanvas-Connector) repository; the main repo no longer keeps a `wiki/` copy:

- [Media plugin specification](https://github.com/nextroad-dev/MuseCanvas-Connector/blob/main/wiki/video-plugin-spec.md): media provider core contract, plugin lifecycle and state machine, output contract, security boundaries, error model, parameter validation and test gates.
- [Spec index and scope](https://github.com/nextroad-dev/MuseCanvas-Connector/blob/main/wiki/README.md): repository notes and reference implementation pointers.

Read the spec in full before changing `packages/providers/src/core/` or `packages/providers/src/plugins/*`; changes that violate the contract gate (`tests/integration/media-provider-contract.test.ts`) will not be merged.

## Docker / Compose Files

| File | Purpose |
| --- | --- |
| `deploy/compose.yaml` | Default local full-stack environment: builds `api`, `worker`, `web` and `nginx` from source, and starts PostgreSQL, Redis, MinIO and Mailpit. On first start it writes the Mailpit / embedded-MinIO development defaults into the database (configured but unverified), so the setup wizard pre-fills them. |
| `deploy/compose.dev.yaml` | Compatibility entry for development, kept for explicit `docker compose --project-directory . --env-file .env -f deploy/compose.dev.yaml` usage; also targets local development. |
| `deploy/compose.prod.yaml` | Deployment template built from source: no MinIO / Mailpit, no preset SMTP / S3 defaults — all application configuration goes through the `/setup` wizard into the database. |
| `deploy/compose.images.yaml` | Deploys pre-built GHCR images: no MinIO / Mailpit, exposes Nginx on `18080:80` by default, and likewise presets no application configuration. |
| `deploy/docker/*.Dockerfile` | Image definitions for the four images: `api`, `worker`, `web`, `nginx`. |

> MinIO and Mailpit exist for local development only, to simulate object storage and email delivery. For public or production deployments do not use the embedded MinIO / Mailpit — connect real S3-compatible object storage and SMTP through the `/setup` wizard.

## Local Run

1. Install dependencies:

```bash
corepack enable
pnpm install
```

2. Start the full local environment (the first start auto-generates bootstrap keys and random passwords):

```bash
pnpm compose:up
```

Equivalent to auto-generating/completing `.env` (only `POSTGRES_PASSWORD`, `APP_MASTER_KEY`, `MINIO_ROOT_*`; existing values are never modified) → `docker compose --project-directory . --env-file .env -f deploy/compose.yaml up --build -d`.

3. Visit `http://localhost:8080`; the browser walks you into the **setup wizard**:

- Set the admin email (the OTP code is sent to Mailpit at `http://localhost:8025`)
- SMTP and object storage are pre-filled with the embedded Mailpit / MinIO values; click "Test connection" to verify
- Optionally configure provider credentials, models and OAuth sign-in
- Once setup completes, start creating

4. Other services:

| Service | Address | Purpose |
| --- | --- | --- |
| Web | `http://localhost:8080` | Frontend application |
| Mailpit | `http://localhost:8025` | Email capture (OTP codes) |
| MinIO API | `http://localhost:9000` | Object storage |
| MinIO Console | `http://localhost:9001` | Object storage admin console |

> `.env` only carries bootstrap keys and deployment toggles: `POSTGRES_PASSWORD`, `APP_MASTER_KEY`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, plus the `ALLOW_INSECURE_*` toggles (all `false` by default; the embedded Compose already allows plaintext SMTP for Mailpit). SMTP, application S3 settings, the public access URL, OAuth, upload limits and prompt templates are all database configuration, filled in and tested via the setup wizard — no environment variables needed. Legacy keys still in their transition period (`SESSION_SECRET`, `OAUTH_CREDENTIALS_ENCRYPTION_KEY`, `PROVIDER_CREDENTIALS_ENCRYPTION_KEY`) may still be passed to containers for read-only compatibility; fresh installs do not need them.

Stop the local environment:

```bash
pnpm compose:down
```

## Deployment Requirements

`deploy/compose.prod.yaml` and `deploy/compose.images.yaml` bundle no S3 or email services and preset no database defaults. Before deploying, only bootstrap keys and deployment toggles are needed:

```bash
POSTGRES_PASSWORD=
APP_MASTER_KEY=   # 32 bytes, 64-char hex or base64/base64url

# Default-deny security toggles (relax as needed; keep false by default)
ALLOW_INSECURE_SMTP=false
ALLOW_INSECURE_PROVIDER_BASE_URL=false
ALLOW_PRIVATE_PROVIDER_BASE_URL=false
# Admin uploads provider plugin code packages; when enabled, uploaded .mjs files
# execute with worker-process privileges (they can read all provider credentials
# derived from APP_MASTER_KEY) — intended only for mutually trusted admins.
ALLOW_PLUGIN_UPLOAD=false
# Local cache directory where the Worker materializes plugin artifacts; must be a
# writable temp directory, do not put it under /app (image layers are ephemeral).
PLUGIN_CACHE_DIR=/tmp/musecanvas-plugin-cache

# Transition-period read-only compatibility (optional, one version only): legacy
# keys are still accepted, previously encrypted data stays readable, and all new
# writes use keys derived from APP_MASTER_KEY. Leave empty for fresh installs.
# SESSION_SECRET=
# OAUTH_CREDENTIALS_ENCRYPTION_KEY=
# PROVIDER_CREDENTIALS_ENCRYPTION_KEY=
```

The remaining application configuration (SMTP sending, S3-compatible object storage, public access URL, OAuth sign-in, upload limits, prompt templates) is filled in on the first-visit `/setup` wizard and verified with "Test connection", then written encrypted into the database — no environment variables involved.

> Upgrade note: leftovers in old `.env` files such as `SESSION_SECRET`, `*_ENCRYPTION_KEY`, `SMTP_*`, `S3_*`, `ADMIN_EMAIL` and `PROMPT_TEMPLATE_*` are ignored by the new Compose files (no longer required, no longer errors); `generate-env` only fills in missing `APP_MASTER_KEY` / `MINIO_ROOT_*` and never modifies existing values. Admins and configurations already written to the database are unaffected.

All secrets may only live in server-side environment variables or the encrypted configuration of the admin console; never write them into frontend code.

### External S3 Bucket CORS Requirements

To let the frontend browser upload reference images directly via presigned POST, external S3 / Cloudflare R2 / MinIO buckets must configure a Cross-Origin Resource Sharing (CORS) rule:

- **AllowedOrigins**: the origin the frontend is served from, e.g. `https://studio.example.com` (use e.g. `http://localhost:8080` when integrating an external bucket during local development).
- **AllowedMethods**: `POST`, `GET`, `HEAD` (presigned form uploads require the `POST` method).
- **AllowedHeaders**: `*` (covers all headers carried by form uploads).
- **ExposeHeaders**: `ETag`, `Location`.
- **MaxAgeSeconds**: `3600`.

JSON example for AWS S3 / compatible buckets:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["POST", "GET", "HEAD"],
    "AllowedOrigins": ["https://studio.example.com"],
    "ExposeHeaders": ["ETag", "Location"],
    "MaxAgeSeconds": 3600
  }
]
```

MinIO / S3 XML example:

```xml
<CORSConfiguration>
  <CORSRule>
    <AllowedOrigin>https://studio.example.com</AllowedOrigin>
    <AllowedMethod>POST</AllowedMethod>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
    <ExposeHeader>Location</ExposeHeader>
    <MaxAgeSeconds>3600</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>
```

## Deploy with GHCR Images

Once `main` is pushed, `.github/workflows/docker-image.yml` builds and publishes four images:

```text
ghcr.io/nextroad-dev/musecanvas-api:latest
ghcr.io/nextroad-dev/musecanvas-worker:latest
ghcr.io/nextroad-dev/musecanvas-web:latest
ghcr.io/nextroad-dev/musecanvas-nginx:latest
```

Deployment machines can use `deploy/compose.images.yaml`:

```bash
docker compose --project-directory . --env-file .env -f deploy/compose.images.yaml pull
docker compose --project-directory . --env-file .env -f deploy/compose.images.yaml up -d
```

Optional variables:

```bash
MUSECANVAS_IMAGE_TAG=latest
MUSECANVAS_HTTP_PORT=18080
```
If the GHCR package is not public yet, log in on the server first:

```bash
echo GITHUB_TOKEN | docker login ghcr.io -u nextroad-dev --password-stdin
```

## Deploy from Source

If the deployment machine needs to build images directly from the repository source:

```bash
docker compose --project-directory . --env-file .env -f deploy/compose.prod.yaml up --build -d
```

This path likewise only requires the bootstrap keys (see above); the application's SMTP / S3 / domain / OAuth configuration is completed in the `/setup` wizard. `deploy/compose.prod.yaml` only orchestrates the applications, Nginx, PostgreSQL and Redis — it does not start MinIO or Mailpit.

## Common Commands
```bash
pnpm dev                  # Start dev services under apps in parallel
pnpm build                # Recursive build
pnpm lint                 # Recursive lint
pnpm typecheck            # Recursive type check
pnpm test                 # Recursive tests
pnpm test:e2e:admin       # Admin console end-to-end verification script
pnpm compose:up
pnpm compose:down
```

> `scripts/prepare-prompt-templates.mjs` (`pnpm prepare:prompt-templates`) is a manual compatibility entry kept only for legacy deployments that still mount an external template directory; it is no longer run by `compose:up` or any Compose file. The runtime source of templates is the versioned template set written into the database by the setup wizard.

You can also run a single application:

```bash
pnpm --filter @musecanvas/web dev
pnpm --filter @musecanvas/api dev
pnpm --filter @musecanvas/worker dev
```

## Pre-submit Validation

Depending on the change scope, run at least the relevant commands:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
docker compose --project-directory . --env-file .env -f deploy/compose.yaml ps
```

When touching frontend visuals, interactions or components, read `docs/design-system.md` first. For features covered by `docs/{NN}-{feature}/design.md`, the sibling `impl.md` and `result.md` are also part of the deliverables.
