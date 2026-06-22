# MuseCanvas
**多生图模型接入&创作平台**

MuseCanvas是一个用于接入多生图模型API，在一个地方创作，同时使用LLM进行提示词优化+前置思考的生图平台。

## 当前进度

- 已完成邮箱 OTP、邀请注册、GitHub / Google OAuth 登录、第三方账户绑定与解绑。
- 已完成管理员后台的供应商凭据管理页与 OAuth 配置页，生图凭据与 OAuth Client Secret 都只写不读。
- 已将模型管理与供应商凭据职责拆分，模型页只保留模型参数和凭据关联。
- 已通过 `pnpm typecheck`、`pnpm test`、`pnpm build` 和 `docker compose up --build -d`。
- 真实 GitHub / Google 第三方登录验收仍待接入可用的外部应用凭据。

## 本地运行

1. 从 `.env.example` 创建本地 `.env`，生成数据库、会话、SMTP 加密和 MinIO 凭据。
2. 设置 `ADMIN_EMAIL`。如需真实生图，再设置 `OPENAI_API_KEY` 或 `ARK_API_KEY`。
3. 执行 `docker compose up --build -d`。
4. 打开 `http://localhost:8080`；本地 OTP 邮件在 `http://localhost:8025` 查看，MinIO 控制台位于 `http://localhost:9001`。

API 容器启动时会执行幂等 migration，并通过 `ADMIN_EMAIL` 创建或恢复首个管理员。管理员登录后可在 `/admin/providers` 配置生图供应商凭据，在 `/admin/oauth` 配置 GitHub / Google OAuth 应用，再在模型管理中把模型关联到对应凭据。未配置供应商密钥时，任务会安全地失败为 `PROVIDER_NOT_CONFIGURED`，不会用占位图片伪装成功。

常用验证命令：

```bash
pnpm typecheck
pnpm test
pnpm build
docker compose ps
```
