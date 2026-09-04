# Deploy

仓库的所有部署产物都集中在此目录。所有命令都从仓库根目录运行，并通过 `--project-directory .` 固定仓库根目录为 Compose 路径基准；环境文件显式使用根目录 `.env`。

- `compose.yaml`：默认本地全栈环境，从源码构建 `api`、`worker`、`web`、`nginx`，并启动 PostgreSQL、Redis、MinIO、Mailpit。`db-migrate` 在 SQL 迁移后以 `BUNDLED_SERVICES=true` 运行 `scripts/seed-bundled-services.ts`，把 Mailpit / 内嵌 MinIO 的开发默认值写入数据库（已配置、未验证），引导页直接预填。
- `compose.dev.yaml`：开发环境兼容入口，保留给显式 `docker compose --project-directory . --env-file .env -f deploy/compose.dev.yaml` 使用，同样面向本地开发。
- `compose.prod.yaml`：从源码构建的部署模板，不包含 MinIO / Mailpit，不预置任何 SMTP / S3 默认值；应用配置全部走 `/setup` 引导页写入数据库。
- `compose.images.yaml`：使用 GHCR 已构建镜像部署，不包含 MinIO / Mailpit，默认通过 `18080:80` 暴露 Nginx，同样不预置应用配置。
- `docker/`：`api`、`worker`、`web`、`nginx` 四个镜像定义（Compose 构建上下文均为仓库根目录 `.`，Nginx 配置从 `deploy/nginx` 复制；`api` 镜像包含 `scripts/`，供 `db-migrate` 调用迁移与种子脚本）。
- `nginx/`：Web 静态资源及 `/api` 反向代理配置。

`.env` 只承载 bootstrap 与部署开关：`POSTGRES_PASSWORD`、`APP_MASTER_KEY`、`MINIO_ROOT_*`（内嵌栈）、`MUSECANVAS_IMAGE_TAG` / `MUSECANVAS_HTTP_PORT` / 可选 `VITE_API_BASE_URL`，以及默认全为 `false` 的 `ALLOW_INSECURE_*` 开关。SMTP、应用 S3 配置、公开访问地址、OAuth 客户端凭据、上传限制和提示词模板是数据库配置，不再经环境变量传递。旧 `prepare-prompt-templates` 脚本仍在 `scripts/` 供手动兼容使用，不再被任何 Compose 文件挂载或执行。

示例（仓库根目录）：

```bash
docker compose --project-directory . --env-file .env -f deploy/compose.yaml up --build -d
docker compose --project-directory . --env-file .env -f deploy/compose.images.yaml up -d
docker compose --project-directory . --env-file .env -f deploy/compose.prod.yaml up --build -d
```

真实密钥只能通过本地环境或部署平台注入，不要提交 `.env`。
