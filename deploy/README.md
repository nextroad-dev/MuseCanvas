# Deploy

仓库的所有部署产物都集中在此目录。所有命令都从仓库根目录运行，并通过 `--project-directory .` 固定仓库根目录为 Compose 路径基准；环境文件显式使用根目录 `.env`。

- `compose.yaml`：默认本地全栈环境，从源码构建 `api`、`worker`、`web-next`、`nginx`，并启动 PostgreSQL、Redis、MinIO、Mailpit。`db-migrate` 在 SQL 迁移后以 `BUNDLED_SERVICES=true` 运行 `scripts/seed-bundled-services.ts`，把 Mailpit / 内嵌 MinIO 的开发默认值写入数据库（已配置、未验证），引导页直接预填。
- `compose.dev.yaml`：开发环境兼容入口，保留给显式 `docker compose --project-directory . --env-file .env -f deploy/compose.dev.yaml` 使用，同样面向本地开发。
- `compose.prod.yaml`：从源码构建的部署模板，不包含 MinIO / Mailpit，不预置任何 SMTP / S3 默认值；应用配置全部走 `/setup` 引导页写入数据库。
- `compose.images.yaml`：使用 GHCR 已构建镜像部署，不包含 MinIO / Mailpit，默认通过 `18080:80` 暴露 Nginx，同样不预置应用配置。
- `docker/`：`api`、`worker`、`web-next`、`nginx` 四个镜像定义（Compose 构建上下文均为仓库根目录 `.`，Nginx 配置从 `deploy/nginx` 复制；`api` 镜像包含 `scripts/`，供 `db-migrate` 调用迁移与种子脚本）。
- `nginx/`：Web 静态资源及 `/api` 反向代理配置。

图库缩略图（派生预览对象）：`apps/worker` 在产物上传成功后生成一张 512px 长边的预览图（图像用 sharp 转 WebP，视频用 ffmpeg 抽一帧转 JPEG），对象键由源键纯函数派生（`<source>.thumb-512.webp|.jpg`，同目录同前缀），视频那一帧同时写入 `assets.poster_object_key` 与 `thumbnail_object_key`。ffmpeg 由 `deploy/docker/worker.Dockerfile` 的 `apk add --no-cache ffmpeg` 提供（Alpine musl 原生包；`ffmpeg-static` 的 glibc 二进制在本镜像内无法执行）。任何预览生成失败都只把 `thumbnail_state` 记为 `failed`，绝不影响任务结果，图库格子自动回退到原图。

升级到带此功能的版本后请跑一次回填，否则新资产有预览、历史资产仍下载原图，网格表现不一致（`api` 镜像不含 ffmpeg，视频行会记为 `failed`，因此完整回填在 `worker` 容器内执行）：

```bash
docker compose --project-directory . --env-file .env -f deploy/compose.yaml \
  exec worker sh -c "pnpm --filter @musecanvas/database exec tsx ../../scripts/backfill-asset-thumbnails.ts"
```

脚本幂等可重跑，支持 `--dry-run`、`--limit=<n>`、`--kind=image|video|all`；`deploy/compose.prod.yaml` / `compose.images.yaml` 把 `compose.yaml` 换掉即可。

`.env` 只承载 bootstrap 与部署开关：`POSTGRES_PASSWORD`、`APP_MASTER_KEY`、`MINIO_ROOT_*`（内嵌栈）、`MUSECANVAS_IMAGE_TAG` / `MUSECANVAS_HTTP_PORT`，`COOKIE_SECURE`，以及默认全为 `false` 的 `ALLOW_INSECURE_*` / `ALLOW_PLUGIN_UPLOAD` 开关。SMTP、应用 S3 配置、公开访问地址、OAuth 客户端凭据、上传限制和提示词模板是数据库配置，不再经环境变量传递。旧 `prepare-prompt-templates` 脚本仍在 `scripts/` 供手动兼容使用，不再被任何 Compose 文件挂载或执行。

Cookie 策略：本地 `compose.yaml` / `compose.dev.yaml` 直接通过 HTTP 提供服务，因此 `COOKIE_SECURE` 默认 `false`；在 TLS 反向代理后使用这两个入口时应设为 `true`。`compose.prod.yaml` / `compose.images.yaml` 按生产 TLS 部署默认 `true`；若明确要把它们的 Nginx 端口直接暴露为纯 HTTP，必须在 `.env` 设置 `COOKIE_SECURE=false`，否则浏览器不会回传 setup/session cookie。

插件代码包上传（默认关闭，需 `ALLOW_PLUGIN_UPLOAD=true`）：管理员上传的 provider 插件包（`plugin_id@version` + 自包含 `.mjs`）经对象存储中转——`api` 校验后写入 `provider_plugins` 表并把制品放进 bucket，`worker` 拉取后动态 `import()`。`api` 与 `worker` 是彼此独立镜像、不共享任何卷，所以 `worker` 只能把本地缓存写在 `PLUGIN_CACHE_DIR`（`backend-env` 默认 `/tmp/musecanvas-plugin-cache`，不得放在镜像层 `/app` 下）。`nginx/default.conf` 为两个大体积上传入口各单独立了一个 location：`/api/admin/plugins/upload` 把 `client_max_body_size` 放宽到 `8m`，`/api/images/edit`（局部修改：浏览器在一次 multipart 请求里同时提交完整源图与不超过 4MB 的 alpha 遮罩）放宽到 `24m`；两处都刻意完整重复 `/api/` 的 `proxy_pass` + `proxy_set_header`：上游是经 `resolver` 解析的变量，只覆盖体积限制的“半截” location 会静默错误代理。`object_key` 为私有 bucket 对象键，任何接口响应都不得返回给客户端。

升级兼容（仅保留一个版本，可选）：升级前用旧密钥加密的会话/OTP（`SESSION_SECRET`）、OAuth 客户端凭据（`OAUTH_CREDENTIALS_ENCRYPTION_KEY`）、供应商凭据（`PROVIDER_CREDENTIALS_ENCRYPTION_KEY`）仍可通过只读回退继续读取，所有新写入只使用 `APP_MASTER_KEY` 派生的密钥。四个 Compose 文件的 API/worker 共享 `backend-env` 已透传这三个变量（均可选，缺省为空），新安装留空即可，下个版本移除。`scripts/generate-env.mjs` 只生成/补齐 bootstrap 密钥（`POSTGRES_PASSWORD`、`APP_MASTER_KEY`、`MINIO_ROOT_*`），从不生成旧密钥，已存在的值绝不改动。

示例（仓库根目录）：

```bash
docker compose --project-directory . --env-file .env -f deploy/compose.yaml up --build -d
docker compose --project-directory . --env-file .env -f deploy/compose.images.yaml up -d
docker compose --project-directory . --env-file .env -f deploy/compose.prod.yaml up --build -d
```

真实密钥只能通过本地环境或部署平台注入，不要提交 `.env`。
