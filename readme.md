# MuseCanvas

**多生图模型接入与创作平台**

MuseCanvas 是一个面向多图像生成模型的创作平台。它把用户创作、模型配置、供应商凭据、提示词预处理、任务队列和作品历史放在同一个工作流里，后端负责鉴权、凭据加密、任务持久化与异步处理，前端只消费安全过滤后的接口数据。

## 当前能力

- 邮箱 OTP、邀请注册、GitHub / Google OAuth 登录，以及第三方账户绑定与解绑。
- 用户创作台、生成任务进度、历史记录和结果详情。
- 管理员后台：用户管理、OAuth Provider 配置、模型管理、供应商凭据管理和任务查看。
- 多供应商图像生成适配，供应商 API Key、Base URL、模型协议等通过管理员后台配置，敏感字段只写不读。
- LLM 提示词预处理模板，运行时由 API / Worker 读取外部模板索引。
- PostgreSQL 持久化核心数据，Redis 处理队列状态、限流和临时缓存，S3 兼容对象存储保存生成结果。
- Docker Compose 本地全栈启动、GHCR 镜像部署，以及 GitHub Actions 镜像构建流水线。

## 技术栈

- 前端：Vue 3、TypeScript、Vite、Pinia、Vue Router、Tailwind CSS。
- API：Next.js API Routes、TypeScript、PostgreSQL、Redis。
- Worker：独立 TypeScript 进程，消费生成队列和后台任务。
- 基础设施：Docker Compose、Nginx、GitHub Actions、GitHub Container Registry、S3 兼容对象存储。

## 目录结构

```text
apps/
  web/       Vue 3 前端应用
  api/       Next.js API 应用
  worker/    后台任务 Worker
packages/
  config/    服务端环境变量读取与校验
  contracts/ 浏览器可安全使用的 DTO、共享类型和错误码
  database/  migration、事务和数据访问
  domain/    框架无关的业务规则和状态机
  providers/ 图像生成、对象存储和邮件服务适配器
docs/        功能设计、实现记录和设计系统
infra/       Dockerfile 与 Nginx 配置
scripts/     本地和部署辅助脚本
.github/     GitHub Actions 工作流
```

## Docker / Compose 文件说明

| 文件 | 用途 |
| --- | --- |
| `compose.yaml` | 默认本地全栈环境，从源码构建 `api`、`worker`、`web`、`nginx`，并启动 PostgreSQL、Redis、MinIO、Mailpit。|
| `compose.dev.yaml` | 开发环境兼容入口，保留给显式 `docker compose -f compose.dev.yaml` 使用，同样面向本地开发。|
| `compose.prod.yaml` | 从源码构建的部署模板，不包含 MinIO / Mailpit，必须接入外部 S3 兼容对象存储和 SMTP 邮件服务。|
| `compose.images.yaml` | 使用 GHCR 已构建镜像部署，不包含 MinIO / Mailpit，默认通过 `18080:80` 暴露 Nginx。|
| `infra/docker/*.Dockerfile` | `api`、`worker`、`web`、`nginx` 四个镜像定义。|

> MinIO 和 Mailpit 只用于本地开发，方便模拟对象存储和邮件投递。公开部署或生产环境不要使用内嵌 MinIO / Mailpit，请接入真实的 S3 兼容对象存储与 SMTP 服务。

## 本地运行

1. 安装依赖：

```bash
corepack enable
pnpm install
```

2. 从 `.env.example` 创建 `.env`，本地至少填写：

```bash
POSTGRES_PASSWORD=
SESSION_SECRET=
SMTP_ENCRYPTION_KEY=
ADMIN_EMAIL=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
OAUTH_CREDENTIALS_ENCRYPTION_KEY=
PROVIDER_CREDENTIALS_ENCRYPTION_KEY=
```

3. 启动完整本地环境：

```bash
pnpm compose:up
```

等价于先准备提示词模板，再执行默认的 `docker compose up --build -d`。

4. 访问服务：

- Web：`http://localhost:8080`
- Mailpit：`http://localhost:8025`
- MinIO API：`http://localhost:9000`
- MinIO Console：`http://localhost:9001`

API 容器启动时会执行幂等 migration，并根据 `ADMIN_EMAIL` 创建或恢复首个管理员。管理员登录后，可在后台配置 OAuth 应用、供应商凭据和模型参数。未配置可用供应商凭据时，生成任务会失败为明确错误，不会用占位图片伪装成功。

停止本地环境：

```bash
pnpm compose:down
```

## 部署环境要求

`compose.prod.yaml` 和 `compose.images.yaml` 都不内置 S3 或邮件服务。部署前需要准备：

- 一个可访问的 S3 兼容对象存储，例如 AWS S3、Cloudflare R2、MinIO 独立实例、阿里云 OSS S3 兼容层等。
- 一个真实 SMTP 邮件服务，用于 OTP 登录、邀请注册和系统邮件。
- 生产级随机密钥：`SESSION_SECRET`、`SMTP_ENCRYPTION_KEY`、`OAUTH_CREDENTIALS_ENCRYPTION_KEY`、`PROVIDER_CREDENTIALS_ENCRYPTION_KEY`。
- 正确的公开访问地址：`OAUTH_REDIRECT_BASE_URL`，例如 `https://studio.example.com`。

部署环境至少需要配置：

```bash
POSTGRES_PASSWORD=
SESSION_SECRET=
SMTP_ENCRYPTION_KEY=
ADMIN_EMAIL=
COOKIE_SECURE=true

SMTP_HOST=
SMTP_PORT=465
SMTP_TLS_MODE=implicit_tls
SMTP_FROM=
SMTP_USER=
SMTP_PASSWORD=

S3_ENDPOINT=
S3_PUBLIC_ENDPOINT=
S3_REGION=us-east-1
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=

OAUTH_REDIRECT_BASE_URL=
OAUTH_CREDENTIALS_ENCRYPTION_KEY=
PROVIDER_CREDENTIALS_ENCRYPTION_KEY=
```

所有密钥只允许放在服务端环境变量或管理员后台的加密配置中，禁止写入前端代码。

## 使用 GHCR 镜像部署

`main` 分支推送后，`.github/workflows/docker-image.yml` 会构建并发布四个镜像：

```text
ghcr.io/nextroad-dev/musecanvas-api:latest
ghcr.io/nextroad-dev/musecanvas-worker:latest
ghcr.io/nextroad-dev/musecanvas-web:latest
ghcr.io/nextroad-dev/musecanvas-nginx:latest
```

部署机可以使用 `compose.images.yaml`：

```bash
docker compose -f compose.images.yaml pull
docker compose -f compose.images.yaml up -d
```

可选变量：

```bash
MUSECANVAS_IMAGE_TAG=latest
MUSECANVAS_HTTP_PORT=18080
PROMPT_TEMPLATE_HOST_DIR=./prompt-templates
PROMPT_TEMPLATE_CONTAINER_INDEX_PATH=/opt/musecanvas/prompt-templates/index.json
```

如果 GHCR Package 还不是公开包，需要先在服务器登录：

```bash
echo GITHUB_TOKEN | docker login ghcr.io -u nextroad-dev --password-stdin
```

## 从源码构建部署

如果部署机需要直接从仓库源码构建镜像，可以使用：

```bash
docker compose -f compose.prod.yaml up --build -d
```

这一路径同样要求外部 S3 和 SMTP。`compose.prod.yaml` 只负责应用、Nginx、PostgreSQL 与 Redis 的编排，不会启动 MinIO 或 Mailpit。

## 常用命令

```bash
pnpm dev                  # 并行启动 apps 下的开发服务
pnpm build                # 递归构建
pnpm lint                 # 递归运行 lint
pnpm typecheck            # 递归类型检查
pnpm test                 # 递归运行测试
pnpm test:e2e:admin       # 管理后台端到端验证脚本
pnpm prepare:prompt-templates
pnpm compose:up
pnpm compose:down
```

也可以只运行单个应用：

```bash
pnpm --filter @musecanvas/web dev
pnpm --filter @musecanvas/api dev
pnpm --filter @musecanvas/worker dev
```

## 提交前验证

根据改动范围至少运行相关命令：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
docker compose ps
```

涉及前端视觉、交互或组件时，先参考 `docs/design-system.md`。涉及 `docs/{序号}-{功能名}/design.md` 对应功能时，同目录 `impl.md` 和 `result.md` 也是交付物的一部分。
