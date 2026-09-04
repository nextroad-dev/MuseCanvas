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
deploy/      Compose 编排、Dockerfile 与 Nginx 配置
scripts/     本地和部署辅助脚本
.github/     GitHub Actions 工作流
```

## Docker / Compose 文件说明

| 文件 | 用途 |
| --- | --- |
| `deploy/compose.yaml` | 默认本地全栈环境，从源码构建 `api`、`worker`、`web`、`nginx`，并启动 PostgreSQL、Redis、MinIO、Mailpit；首次启动会自动把 Mailpit / 内嵌 MinIO 的开发默认值写入数据库（已配置未验证），引导页直接预填。|
| `deploy/compose.dev.yaml` | 开发环境兼容入口，保留给显式 `docker compose --project-directory . --env-file .env -f deploy/compose.dev.yaml` 使用，同样面向本地开发。|
| `deploy/compose.prod.yaml` | 从源码构建的部署模板，不包含 MinIO / Mailpit，不预置任何 SMTP / S3 默认值，应用配置全部走 `/setup` 引导页写入数据库。|
| `deploy/compose.images.yaml` | 使用 GHCR 已构建镜像部署，不包含 MinIO / Mailpit，默认通过 `18080:80` 暴露 Nginx，同样不预置应用配置。|
| `deploy/docker/*.Dockerfile` | `api`、`worker`、`web`、`nginx` 四个镜像定义。|

> MinIO 和 Mailpit 只用于本地开发，方便模拟对象存储和邮件投递。公开部署或生产环境不要使用内嵌 MinIO / Mailpit，请在 `/setup` 引导页接入真实的 S3 兼容对象存储与 SMTP 服务。

## 本地运行

1. 安装依赖：

```bash
corepack enable
pnpm install
```

2. 启动完整本地环境（首次会自动生成 bootstrap 密钥和随机密码）：

```bash
pnpm compose:up
```

等价于自动生成/补齐 `.env`（只含 `POSTGRES_PASSWORD`、`APP_MASTER_KEY`、`MINIO_ROOT_*`，已存在的值绝不改动）→ `docker compose --project-directory . --env-file .env -f deploy/compose.yaml up --build -d`。

3. 访问 `http://localhost:8080`，浏览器会自动进入**初始化引导页面**：

- 设置管理员邮箱（OTP 验证码发送到 Mailpit：`http://localhost:8025`）
- SMTP 与对象存储已预填内嵌 Mailpit / MinIO 的值，点“测试连接”验证即可
- 可选配置供应商凭据、模型和 OAuth 登录
- 完成引导后即可开始创作

4. 其他服务：

| 服务 | 地址 | 用途 |
| --- | --- | --- |
| Web | `http://localhost:8080` | 前端应用 |
| Mailpit | `http://localhost:8025` | 邮件捕获（验证码） |
| MinIO API | `http://localhost:9000` | 对象存储 |
| MinIO Console | `http://localhost:9001` | 对象存储管理后台 |

> `.env` 只承载 bootstrap 密钥与部署开关：`POSTGRES_PASSWORD`、`APP_MASTER_KEY`、`MINIO_ROOT_USER`、`MINIO_ROOT_PASSWORD`，以及默认全为 `false` 的 `ALLOW_INSECURE_*` 开关（内嵌 Compose 已为 Mailpit 放行明文 SMTP）。SMTP、应用 S3 配置、公开访问地址、OAuth、上传限制和提示词模板全部是数据库配置，在引导页里填写和测试，不再需要环境变量。仍在过渡期的旧密钥（`SESSION_SECRET`、`OAUTH_CREDENTIALS_ENCRYPTION_KEY`、`PROVIDER_CREDENTIALS_ENCRYPTION_KEY`）可继续传给容器做只读兼容，新安装无需设置。

停止本地环境：

```bash
pnpm compose:down
```

## 部署环境要求

`deploy/compose.prod.yaml` 和 `deploy/compose.images.yaml` 都不内置 S3 或邮件服务，也不在数据库里预置任何默认值。部署前只需要准备 bootstrap 密钥和部署开关：

```bash
POSTGRES_PASSWORD=
APP_MASTER_KEY=   # 32 字节，64 位 hex 或 base64/base64url

# 默认拒绝的安全开关（按需放宽，默认保持 false）
ALLOW_INSECURE_SMTP=false
ALLOW_INSECURE_PROVIDER_BASE_URL=false
ALLOW_PRIVATE_PROVIDER_BASE_URL=false

# 过渡期只读兼容（可选，仅一个版本）：仍可传入旧密钥，已有加密数据继续可读，
# 所有新写入都只用 APP_MASTER_KEY 派生的密钥。新安装留空即可。
# SESSION_SECRET=
# OAUTH_CREDENTIALS_ENCRYPTION_KEY=
# PROVIDER_CREDENTIALS_ENCRYPTION_KEY=
```

其余应用配置（SMTP 发件、S3 兼容对象存储、公开访问地址、OAuth 登录、上传限制、提示词模板）在首次打开的 `/setup` 引导页里填写并点“测试连接”验证，写入数据库加密保存，不再经过环境变量。

> 升级说明：旧 `.env` 里残留的 `SESSION_SECRET`、`*_ENCRYPTION_KEY`、`SMTP_*`、`S3_*`、`ADMIN_EMAIL`、`PROMPT_TEMPLATE_*` 等会被新 Compose 忽略（不再必填也不再报错），`generate-env` 只会补齐缺失的 `APP_MASTER_KEY` / `MINIO_ROOT_*`，绝不改动已有值。已写入数据库的管理员和配置不受影响。

所有密钥只允许放在服务端环境变量或管理员后台的加密配置中，禁止写入前端代码。

### 外部 S3 存储桶 CORS 要求

为支持前端浏览器直接通过预签名 POST（Presigned POST）上传参考图，外部 S3 / Cloudflare R2 / MinIO 存储桶必须配置跨域资源共享（CORS）规则：

- **AllowedOrigins**：前端应用部署的访问来源，例如 `https://studio.example.com`（本地开发联调外部桶时使用 `http://localhost:8080` 等）。
- **AllowedMethods**：`POST`、`GET`、`HEAD`（预签名表单直传必须允许 `POST` 方法）。
- **AllowedHeaders**：`*`（包含表单上传携带的各类标头）。
- **ExposeHeaders**：`ETag`, `Location`。
- **MaxAgeSeconds**：`3600`。

AWS S3 / 兼容存储桶 JSON 配置示例：

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

MinIO / S3 XML 配置示例：

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

## 使用 GHCR 镜像部署

`main` 分支推送后，`.github/workflows/docker-image.yml` 会构建并发布四个镜像：

```text
ghcr.io/nextroad-dev/musecanvas-api:latest
ghcr.io/nextroad-dev/musecanvas-worker:latest
ghcr.io/nextroad-dev/musecanvas-web:latest
ghcr.io/nextroad-dev/musecanvas-nginx:latest
```

部署机可以使用 `deploy/compose.images.yaml`：

```bash
docker compose --project-directory . --env-file .env -f deploy/compose.images.yaml pull
docker compose --project-directory . --env-file .env -f deploy/compose.images.yaml up -d
```

可选变量：

```bash
MUSECANVAS_IMAGE_TAG=latest
MUSECANVAS_HTTP_PORT=18080
```
如果 GHCR Package 还不是公开包，需要先在服务器登录：

```bash
echo GITHUB_TOKEN | docker login ghcr.io -u nextroad-dev --password-stdin
```

## 从源码构建部署

如果部署机需要直接从仓库源码构建镜像，可以使用：

```bash
docker compose --project-directory . --env-file .env -f deploy/compose.prod.yaml up --build -d
```

这一路径同样只要求 bootstrap 密钥（见上），应用的 SMTP / S3 / 域名 / OAuth 配置在 `/setup` 引导页完成。`deploy/compose.prod.yaml` 只负责应用、Nginx、PostgreSQL 与 Redis 的编排，不会启动 MinIO 或 Mailpit。

## 常用命令
```bash
pnpm dev                  # 并行启动 apps 下的开发服务
pnpm build                # 递归构建
pnpm lint                 # 递归运行 lint
pnpm typecheck            # 递归类型检查
pnpm test                 # 递归运行测试
pnpm test:e2e:admin       # 管理后台端到端验证脚本
pnpm compose:up
pnpm compose:down
```

> `scripts/prepare-prompt-templates.mjs`（`pnpm prepare:prompt-templates`）仅为仍在直接挂载外部模板目录的旧部署保留的手动兼容入口，不再被 `compose:up` 或任何 Compose 文件自动执行；模板的运行时来源是引导页写入数据库的版本化模板集。

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
docker compose --project-directory . --env-file .env -f deploy/compose.yaml ps
```

涉及前端视觉、交互或组件时，先参考 `docs/design-system.md`。涉及 `docs/{序号}-{功能名}/design.md` 对应功能时，同目录 `impl.md` 和 `result.md` 也是交付物的一部分。
