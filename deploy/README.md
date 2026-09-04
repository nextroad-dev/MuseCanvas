# Deploy

仓库的所有部署产物都集中在此目录。所有命令都从仓库根目录运行，并通过 `--project-directory .` 固定仓库根目录为 Compose 路径基准；环境文件显式使用根目录 `.env`。

- `compose.yaml`：默认本地全栈环境，从源码构建 `api`、`worker`、`web`、`nginx`，并启动 PostgreSQL、Redis、MinIO、Mailpit。
- `compose.dev.yaml`：开发环境兼容入口，保留给显式 `docker compose --project-directory . --env-file .env -f deploy/compose.dev.yaml` 使用，同样面向本地开发。
- `compose.prod.yaml`：从源码构建的部署模板，不包含 MinIO / Mailpit，必须接入外部 S3 兼容对象存储和 SMTP 邮件服务。
- `compose.images.yaml`：使用 GHCR 已构建镜像部署，不包含 MinIO / Mailpit，默认通过 `18080:80` 暴露 Nginx。
- `docker/`：`api`、`worker`、`web`、`nginx` 四个镜像定义（Compose 构建上下文均为仓库根目录 `.`，Nginx 配置从 `deploy/nginx` 复制）。
- `nginx/`：Web 静态资源及 `/api` 反向代理配置。

示例（仓库根目录）：

```bash
docker compose --project-directory . --env-file .env -f deploy/compose.yaml up --build -d
docker compose --project-directory . --env-file .env -f deploy/compose.images.yaml up -d
docker compose --project-directory . --env-file .env -f deploy/compose.prod.yaml up --build -d
```

真实密钥只能通过本地环境或部署平台注入，不要提交 `.env`。
