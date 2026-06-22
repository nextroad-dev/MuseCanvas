# 前端体验、OAuth 与供应商凭据配置实现计划

## 设计文档

引用：`../002-ui-oauth-provider-credentials/design.md`

## 背景与现状

探索后确认后端基础设施大部分已就位（详见 `design.md` 背景）：DB schema（`oauth_identities`、`provider_credentials`、模型/任务关联列、`oauth_provider` 枚举）、供应商凭据全套 CRUD + `/test` 路由、`providerCredentialDto`、`oauthIdentityDto`、AES-256-GCM 加密与 fingerprint、Worker 从 DB 读取解密凭据、任务创建强制 `PROVIDER_NOT_CONFIGURED`、`.env.example` OAuth/加密变量均已存在。

本次补齐缺失部分。经用户确认：完整三块 A+B+C；OAuth 实现 + 未配置时优雅置灰，真实第三方登录由用户用真实应用验收。

## 任务拆解

### A. 供应商凭据管理 UI
- [ ] A1：`types/index.ts` 增 `ProviderCredential`/`ProviderCredentialInput`，扩展 `AdminModel.providerCredentialId/Name`。
- [ ] A2：`stores/admin.ts` 增 `providerCredentials` state + 5 个 action（fetch/create/update/test/delete）。
- [ ] A3：`router/index.ts` 增 `admin-providers` 子路由；`AdminLayout.vue` navItems 增「供应商凭据」。
- [ ] A4：新建 `views/admin/AdminProviderCredentials.vue`（DataTable + 创建/编辑对话框 + 只写 API Key + 测试 + 启停 + 删除确认）。
- [ ] A5：`AdminModels.vue` 移除过时说明、增凭据选择器、onMounted 拉取凭据。

### B. GitHub / Google OAuth
- [ ] B1：`apps/api` 增 `jose` 依赖。
- [ ] B2：新建 `apps/api/src/oauth.ts`（Provider 配置探测、授权 URL、code 交换、profile 读取/校验、PKCE/state/nonce 工具）。
- [ ] B3：`route.ts` 增 Redis 短期状态 helper（set + getDel）。
- [ ] B4：`route.ts` 增路由：`auth/oauth/providers|{p}/start|{p}/callback`、`auth/oauth/invitation`(POST)、`account/oauth`、`account/oauth/{p}/link/start`、`account/oauth/{p}`(DELETE)。
- [ ] B5：前端 `types` 增 OAuth 类型；`stores/auth.ts` + 新 `stores/account.ts`；`LoginPage.vue`（按钮 + 邀请步骤 + 错误映射）；`AccountPage.vue`（身份列表 + 绑定/解绑）。

### C. 视觉美化
- [ ] C1：`assets/index.css` 扩展主题变量。
- [ ] C2：新增轻量 Toast/inline alert，替代浏览器 alert，统一焦点态。
- [ ] C3：LoginPage 双栏、Generate/Library/Account 状态完善、管理表格状态完善、无障碍。

### 验证
- [ ] V1：`pnpm typecheck` / `pnpm lint` / `pnpm test`（含新增 OAuth 单测）/ `pnpm build`。
- [ ] V2：`docker compose` 手动冒烟（凭据 CRUD/测试/删除拒绝、模型选凭据、OAuth 置灰、OTP 不回归）。
- [ ] V3：写 `result.md`，OAuth 真实登录未验收如实标注。

## 涉及文件

新增：
- `apps/api/src/oauth.ts`（OAuth Provider 适配层）
- `apps/web/src/stores/account.ts`
- `apps/web/src/views/admin/AdminProviderCredentials.vue`
- `apps/web/src/components/ui/Toast.vue`（或 inline alert）
- `apps/api/src/oauth.test.ts`（OAuth 纯单元测试）

修改：
- `apps/api/app/api/[...path]/route.ts`（OAuth 路由 + Redis helper）
- `apps/api/package.json`（jose）
- `apps/web/src/types/index.ts`、`stores/admin.ts`、`stores/auth.ts`
- `apps/web/src/router/index.ts`、`layouts/AdminLayout.vue`
- `apps/web/src/views/admin/AdminModels.vue`
- `apps/web/src/views/auth/LoginPage.vue`、`views/user/AccountPage.vue`
- `apps/web/src/assets/index.css` 及各美化页面

## 注意事项

- 不引入新 UI/CSS/状态管理框架；Reka UI 仅在确需无障碍交互且现有组件不足时引入。
- OAuth Client Secret 仅服务端 env，不进前端构建；不向前端暴露第三方 token。
- callback 严格校验一次性 state（消费即 DEL），失败统一重定向 `/login?error=CODE`。
- 自动绑定/建号显式校验 `status='active' AND deleted_at IS NULL`，disabled/软删返回 `OAUTH_ACCOUNT_UNAVAILABLE`。
- 凭据/密钥/token 不入日志、审计摘要、错误响应。
- 无 DB/Redis 集成测试 harness，相关用例按 design 验证计划标注限制。
