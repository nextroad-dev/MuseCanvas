# 前端体验、OAuth 与供应商凭据配置实现结果

## 设计文档

引用：`design.md`

## 结果状态

- 状态：已完成
- 完成日期：2026-06-21

## 完成情况

- [x] 供应商凭据管理 UI 已补齐，包括列表、创建、编辑、只写 API Key、测试连接、启停和删除确认。
- [x] 管理员模型管理页已支持关联供应商凭据，并移除过时的“从环境变量读取 API Key”说明。
- [x] 模型管理与供应商凭据职责已拆分：模型页只维护模型参数和凭据关联，不再重复编辑 API Base URL。
- [x] OAuth Provider 已支持管理员后台配置，GitHub / Google Client ID 与 Client Secret 可在 `/admin/oauth` 维护，Secret 加密保存且不可回读。
- [x] OAuth 适配层已实现 GitHub / Google 的授权 URL、PKCE、state、nonce、token 交换与资料校验。
- [x] 后端已补齐 OAuth 登录、邀请注册、账户绑定与解绑相关路由，并统一返回平台错误码。
- [x] 登录页与账户页已增加 OAuth 登录与绑定入口，并对未启用的 Provider 做了隐藏或置灰处理。
- [x] 前端基础视觉与状态反馈已补强，包含登录页双栏布局、账户页 OAuth 状态、管理页空态/加载态和 inline alert。
- [x] 本地类型检查、单元测试和生产构建已通过。
- [ ] 真实 GitHub / Google 第三方登录验收：本地环境未接通真实 OAuth 应用凭据，未做线上 Provider 实测。
- [x] `docker compose` 全链路冒烟：已在 Compose 网络内完成管理员后台 smoke，验证 OTP 登录、管理接口访问和敏感字段过滤。

## 变更摘要

- `apps/web/src/types/index.ts`、`stores/admin.ts`、`stores/auth.ts`、`stores/account.ts`：补充供应商凭据与 OAuth 相关类型和状态操作。
- `apps/web/src/router/index.ts`、`layouts/AdminLayout.vue`：新增管理员供应商凭据路由与导航入口。
- `apps/web/src/views/admin/AdminProviderCredentials.vue`、`views/admin/AdminModels.vue`：实现供应商凭据管理 UI，并支持模型关联凭据；模型页移除重复的 Base URL 配置。
- `apps/web/src/views/admin/AdminOAuthProviders.vue`、`router/index.ts`、`layouts/AdminLayout.vue`：新增 OAuth 配置页和后台导航入口。
- `packages/database/src/migrate.ts`：新增 `oauth_provider_settings` 表，保存 OAuth Provider 的启用状态、Client ID 和加密 Secret。
- `apps/web/src/views/auth/LoginPage.vue`、`views/user/AccountPage.vue`：补齐 OAuth 登录、邀请注册和绑定/解绑体验。
- `apps/web/src/assets/index.css`：扩展主题变量，统一基础视觉。
- `apps/api/src/oauth.ts`、`apps/api/src/oauth.test.ts`、`apps/api/app/api/[...path]/route.ts`：实现 OAuth 适配、单测和对应 API 路由；OAuth 登录优先读取数据库配置，环境变量作为兼容兜底。
- `apps/api/src/security.ts`、`.env.example`：新增 OAuth Secret 专用加密能力与 `OAUTH_CREDENTIALS_ENCRYPTION_KEY` 模板项。
- `apps/api/package.json`：已包含 `jose` 依赖，用于 Google ID Token 校验。

## 验证记录

- `pnpm typecheck`：通过。
- `pnpm test`：通过，API 单元测试 17 项全部通过。
- `pnpm build`：通过，Web 与 API 生产构建成功。
- `docker compose up --build -d`：通过，API、Worker、Web、Nginx、Postgres、Redis、MinIO、Mailpit 成功启动并健康。
- Compose 内冒烟：通过，使用容器内 `BASE_URL=http://api:3001`、`MAILPIT_URL=http://mailpit:8025` 跑通管理员 OTP 登录与管理接口检查。
- 未执行：真实 GitHub / Google OAuth 登录验收，原因是当前环境未配置可直接使用的第三方应用凭据。

## 设计偏差

- 设计要求的真实第三方 OAuth 验收未在本地完成，因此结果状态只能记为“部分完成”。
- 凭据测试当前统一使用 `GET /v1/models` 做低成本连通性检查；这对 OpenAI 兼容接口更稳妥，对部分 Seedream 路由的覆盖仍有限。

## 遗留问题

- 需要在具备真实 GitHub / Google OAuth 应用凭据的环境中，补做登录、回调、邀请注册、绑定与解绑的实测验收。
- 本次在宿主机 WSL 环境里遇到 `localhost:8080` 被本地 Python 服务占用，实际冒烟改为在 Compose 网络内通过服务名访问；这不影响容器内链路结论，但后续若要在宿主机直接跑脚本，需要先释放 8080 端口或改用其他入口。
