# 前端体验、OAuth 与供应商凭据配置设计

## 背景

基于 `../001-mvp/result.md`，MuseCanvas 当前已经完成 MVP 的本地代码实现和 Docker Compose 联调：

- 已有 Vue 3 用户端、管理员后台、Next.js API、Worker、PostgreSQL、Redis 和 S3 兼容对象存储。
- 已有邮箱 OTP 注册与登录、开放注册和邀请注册、服务端会话、`user` 与 `admin` 授权。
- 已有用户端生图页、图库、账户页，以及管理仪表盘、注册管理、SMTP、用户、模型和任务管理页面。
- 已有 GPT Image 与 Seedream 适配器，模型参数由管理员配置；供应商 API Key 已由服务端实现 AES-256-GCM 加密（`PROVIDER_CREDENTIALS_ENCRYPTION_KEY`）写入 `provider_credentials` 表，对应的 GET/POST/PATCH/DELETE `/api/admin/provider-credentials` 及 `{id}/test` 路由已实现，Worker 从数据库读取凭据解密调用（`apps/api/app/api/[...path]/route.ts`、`apps/worker/src/index.ts`、`packages/providers/src/crypto.ts`、`packages/database/src/migrate.ts`），但管理员后台尚无供应商凭据配置 UI，AdminModels.vue 的 API Key 说明仍标记为"从服务端环境变量读取"。
- 真实供应商凭据尚未完成成功生图验收；仅凭 `GET /v1/models` 测试不足以替代真实生图调用。

第一版前端以功能闭环为主，界面偏基础信息管理形态。本次设计重点提升第一版用户界面的完整度和视觉品质，同时增加 GitHub、Google OAuth 登录入口，并补全管理员后端的供应商凭据配置 UI（模型层与凭据层在服务端已分离）。

## 目标

- 美化现有用户端和管理员后台界面，形成更接近 AI 创作工具的视觉和交互体验。
- 在保留邮箱 OTP 的基础上，增加 GitHub OAuth 与 Google OAuth 登录。
- OAuth 新用户注册继续遵守当前注册策略：开放注册可直接创建账户，邀请注册必须先校验与邮箱绑定的邀请码。
- 支持用户将 GitHub 或 Google 身份与现有邮箱账户自动关联或主动绑定。
- 将 OpenAI 与 Seedream 的 API Key 调整为管理员页面配置，服务端加密保存，读取接口只返回“已配置”状态。
- 模型配置与供应商凭据解耦：模型负责参数与启停，凭据负责 API Key、Base URL 和连接状态。
- Worker 调用生图供应商时从服务端安全读取凭据，浏览器、普通用户接口和管理员读取接口都不得得到密钥原文。
- 保持现有安全边界：管理员仍不能查看用户提示词、图片内容、对象存储地址或未过滤的供应商响应。

## 非目标

- 不引入密码登录、密码找回或用户名密码账户体系。
- 不引入除 GitHub、Google 以外的 OAuth 提供商。
- 不把 GitHub/Google OAuth 应用的 Client Secret 放入前端代码。本次 OAuth 应用凭据仍由服务端部署环境提供。
- 不建设完整画布、图层、图片编辑器、图生图、多参考图或工作流编排。
- 不实现额度、套餐、支付、账单或成本统计。
- 不实现团队、多租户、成员邀请或组织级权限。
- 不引入新的 UI 框架、CSS 框架或状态管理库。
- 不允许浏览器直接调用 OpenAI、Seedream 或其他生图供应商。
- 不将 S3、Redis、PostgreSQL 等基础设施凭据迁入管理员页面；本次只处理生图供应商凭据。

## 术语

- **OAuth Provider**：第三方登录提供商，本次仅指 GitHub 和 Google。
- **OAuth Identity**：用户账户绑定的第三方身份，由 `provider` 和 `provider_subject` 唯一确定。
- **Provider Subject**：第三方提供商返回的稳定用户 ID，例如 Google `sub` 或 GitHub `id`。
- **Verified Email**：由 OAuth Provider 确认已验证的邮箱。新建或自动关联账户时必须使用已验证邮箱。
- **OAuth State**：服务端生成的一次性随机状态，用于防止 CSRF 和登录请求混淆。
- **PKCE**：OAuth 授权码流程的安全增强，用于防止授权码被截获后复用。
- **供应商凭据（Provider Credential）**：生图供应商调用所需的 API Key、Base URL、启用状态和测试状态。
- **模型配置（Model Configuration）**：管理员维护的模型展示名、供应商模型 ID、尺寸、质量、生成张数、并发和启停配置。
- **凭据轮换**：管理员写入新的 API Key，旧密钥不再用于后续任务，读取接口不返回任何密钥原文。

## 产品范围

### 前端界面美化

本次不改变核心功能路径，主要在现有页面上提升信息层级、视觉完成度、响应式体验和状态反馈。

#### 视觉方向

- 将 MuseCanvas 定位为“轻量 AI 创作工作台”，整体风格从纯后台表单提升为更有品牌感的创作工具界面。
- 基础布局仍使用 Vue 3、Tailwind CSS、Pinia、Vue Router 和当前组件体系。
- 优先整理项目内 UI 组件（当前 `components/ui/` 有 BaseSelect、ConfirmDialog、DataTable、EmptyState、ImageCard、MetricCard、ModelSelector、PromptEditor、StatusBadge，无 Toast/标签页/焦点管理工具）。确需复杂弹窗、下拉、标签页等无障碍交互（ARIA、焦点管理、键盘导航）时，允许引入 shadcn-vue 或 Reka UI 等无样式/无 CSS 的头部组件库——它们不是 UI/CSS 框架（不违反非目标第 34 条），而是为项目缺失的可访问性基础设施提供标准化实现，与 Tailwind 主题变量兼容。
- 建立更统一的 Tailwind 主题变量，包括主色、背景、卡片、边框、文字层级、阴影、圆角和焦点态。
- 保持浅色模式优先，可在关键区域使用深色渐变或品牌视觉块，但本次不承诺完整暗色模式切换。

#### 登录页

- 登录页改为左侧品牌介绍、右侧登录卡片的结构，小屏幕自动变为单列。
- 登录卡片顶部展示 GitHub、Google 登录按钮；当对应 OAuth Provider 未配置时不展示或置灰并说明。
- 邮箱 OTP 登录保留为主要备选路径，邀请码流程继续沿用当前三步交互。
- 邀请注册模式下，OAuth 新用户在回调后进入邀请码步骤，页面展示已验证邮箱，不允许用户在该步骤替换邮箱。
- 错误提示使用稳定错误码映射为用户可理解文案，例如 `OAUTH_EMAIL_UNAVAILABLE`、`OAUTH_STATE_INVALID`、`INVALID_INVITATION`。

#### 用户端

- 用户端三栏布局已基本实现（`GeneratePage.vue`），本次强化：
  - 左侧：任务历史，突出最近任务、状态和缩略图（已有 64px 左侧栏）。
  - 中间：生成结果预览区，优化空状态、排队中、生成中、失败和多图展示（已有 Loader2 + XCircle 状态）。
  - 右侧：提示词和参数面板，强化模型、尺寸、质量和生成张数的分组（已有 PromptEditor + ModelSelector + 尺寸/质量选择器）。
- 提示词输入区增加更明确的字数提示、快捷清空、提交中禁用和错误提示。
- 结果预览弹窗优化图片尺寸、提示词展示、下载入口和关闭交互。
- 图库页面优化为图片卡片网格，支持更好的空状态、加载状态、删除确认和下载反馈。
- 账户页展示当前邮箱、角色、注册时间和已绑定的 OAuth Identity；用户可主动发起绑定或解绑 GitHub、Google。

#### 管理员后台

- 管理员后台导航增加”供应商凭据”页面，作为独立 `/admin/providers` 路由（AdminLayout.vue navItems 新增 `Key` 图标项、router/index.ts 新增 admin-providers 子路由）。这样保持”模型负责参数，凭据负责密钥”的解耦视觉，也无需引入当前不存在的标签页组件。
- 仪表盘、用户管理、模型管理、任务管理继续保持数据安全过滤，不展示用户提示词、图片和对象存储地址。
- SMTP 配置与新增供应商凭据配置采用一致的“密钥只写不读”交互：
  - 密钥输入框为空时表示保持不变。
  - 已配置时只显示“已配置”和最近更新时间。
  - 保存、测试、启停操作显示清晰反馈。
- 表格页补齐加载、空数据、筛选结果为空、失败重试等状态。

#### 交互与可访问性

- 所有按钮、输入框、弹窗、下拉和标签页必须有可见焦点态。
- 关键操作必须支持键盘操作，弹窗打开后焦点进入弹窗，关闭后回到触发按钮。
- 颜色对比度满足常规文本可读性，不只依赖颜色表达成功、失败或禁用状态。
- 表单提交中禁用重复提交，错误信息靠近相关字段。
- 需要统一轻量 toast 或 inline alert，不用浏览器 `alert`。

### GitHub 与 Google OAuth

#### OAuth 提供商

本次支持两个提供商：

| Provider | Scope | 邮箱要求 |
|---|---|---|
| GitHub | `read:user user:email` | 必须从 `/user/emails` 获取 primary 且 verified 的邮箱 |
| Google | `openid email profile` | 必须校验 ID Token 中 `email_verified=true` |

OAuth Access Token 只用于登录当次读取用户资料和邮箱，不长期保存 refresh token 或 provider access token。

#### 登录流程

1. 前端调用 `GET /api/auth/oauth/providers` 获取已启用 Provider。
2. 用户点击 GitHub 或 Google 登录，浏览器跳转到 `GET /api/auth/oauth/{provider}/start`。
3. 服务端生成 `state`、PKCE 参数和短期 HttpOnly Cookie，然后重定向到 Provider 授权页。
4. Provider 回调 `GET /api/auth/oauth/{provider}/callback`。
5. 服务端校验 `state`、PKCE、Provider 响应、邮箱验证状态和账户状态。
6. 如果 OAuth Identity 已存在且用户有效，直接创建 MuseCanvas 会话。
7. 如果 OAuth Identity 不存在，但已验证邮箱匹配一个现有 active 用户，自动绑定该 Identity 并创建会话。
8. 如果邮箱不存在且注册模式为 `open`，创建 active 用户、绑定 Identity 并创建会话。
9. 如果邮箱不存在且注册模式为 `invite_only`，创建短期 OAuth 注册挑战并重定向回登录页的邀请码步骤；邀请码校验通过后才创建用户并绑定 Identity。

OAuth 登录成功后仍使用现有 `muse_session` HttpOnly Cookie，不向前端暴露第三方 token。会话创建复用现有流程（`route.ts:158`）：`INSERT INTO sessions(user_id, token_hash, expires_at) VALUES($1, $2, now() + interval '30 days')`，`$2` 为 `hashToken(randomToken())`，通过 `response.cookies.set('muse_session', ...)` 写入 HttpOnly SameSite=Lax Cookie（`route.ts:161`）。

回调失败时重定向到登录页并在 URL 中携带错误参数：`/login?error=OAUTH_STATE_INVALID`。前端 `LoginPage.vue` 在 `onMounted` 时检测 `useRoute().query.error` 并展示映射后的文案。

#### 邀请注册兼容

- OAuth 回调拿到的已验证邮箱是注册邮箱，邀请码必须绑定同一邮箱。
- 邀请码步骤不得允许用户修改 OAuth 邮箱；若要更换邮箱，必须重新发起 OAuth 登录。
- OAuth 注册挑战（invitation challenge）在 Redis 中的键结构：`oauth:challenge:{challengeId}`，值包含 `{ email, provider, providerSubject, exp }`。一次性消费：校验邀请码后在事务中执行 `DEL` + 用户创建 + Identity 绑定 + 邀请码消费，与现有 OTP 邀请流程类似（`route.ts:154`）。挑战短期有效，建议 10 分钟，过期后用户需重新登录。
- 邀请码验证、消费用户创建和 Identity 绑定必须在同一个数据库事务中完成。

#### 账户绑定与解绑

- 已登录用户可在账户页绑定 GitHub 或 Google。
- 绑定流程复用 OAuth `start` 和 `callback`，但 `state` 中标记为 link 模式，并要求当前会话有效。link-mode state 的 Redis 记录包含 `{ mode: 'link', userId, provider, nonce, pkceVerifier, exp }`，回调时根据 `state` 中的 `mode` 字段区分登录与绑定流程。
- 若 Provider Identity 已绑定其他用户，返回 `OAUTH_IDENTITY_CONFLICT`。
- 若 Provider 返回的已验证邮箱与当前账户邮箱不一致，默认禁止绑定，返回 `OAUTH_EMAIL_MISMATCH`；后续如需支持多邮箱账户需另起设计。
- 用户可解绑 OAuth Identity；解绑不删除 MuseCanvas 用户。邮箱 OTP 始终保留，因此解绑不会造成账户无登录方式。

#### OAuth 安全要求

- GitHub 和 Google 的 Client Secret 只能存在服务端环境变量或后端密文配置中，不进入前端构建产物。
- `state`、PKCE verifier、nonce 和 OAuth 注册挑战必须短期有效且一次性使用（存 Redis，消费后立即 DEL）。
- Google 必须校验 ID Token。推荐使用 `jose` 库（项目尚无 JWT 库，需新增依赖），调用 `jwtVerify` 配合 Google JWKS 集合（`https://www.googleapis.com/oauth2/v3/certs`，需按 Cache-Control 缓存刷新）。校验项：`iss === 'https://accounts.google.com'`、`aud === OAUTH_GOOGLE_CLIENT_ID`、`exp` 未过期、`nonce` 等于 start 阶段生成的一次性值、`email_verified === true`。
- nonce 在 start 阶段由服务端 `randomToken(16)`（`security.ts:11`）生成，写入 Redis 键 `oauth:nonce:{nonce}`，TTL 与 state/PKCE 一致（建议 10 分钟）；作为 auth request 额外参数发送；回调校验 ID Token 中的 nonce 匹配后立即 DEL 该键，一次性消费。oauth_identities 表不存 nonce（`migrate.ts:33`），Redis 丢失时用户需重新发起登录。
- 自动绑定与用户创建路径必须显式校验账户状态，与 `actorFrom` 一致（`security.ts:16`）：邮箱匹配查询使用 `WHERE lower(email)=$1 AND deleted_at IS NULL` 取出最近一条用户，并校验 `status = 'active'`。若匹配用户存在但 `status='disabled'` 或已软删除，返回 `OAUTH_ACCOUNT_UNAVAILABLE`（与 OTP 流程 `ACCOUNT_UNAVAILABLE` 一致，`route.ts:131`），不得回退到步骤 8 自动创建。注意 `users_email_active_key` 为 `WHERE deleted_at IS NULL` 的部分唯一索引（`migrate.ts:12`），仅靠唯一约束无法阻止为软删除邮箱重建账户，必须在应用层显式拒绝。
- GitHub 必须通过服务端调用获取 verified primary email，不能相信前端传入邮箱。
- Provider 返回的头像、昵称只作为展示资料，不参与权限判断。
- 用户角色只能来自 MuseCanvas 数据库，不接受 OAuth Provider 的组织、团队或邮箱域推导。
- 禁用或软删除用户不能通过 OAuth 登录，也不能通过 OAuth 自动重新创建。
- 所有 OAuth 失败都转换为平台错误码，不把 Provider 原始错误、token 或请求细节返回给前端。回调错误应重定向到登录页并在 URL 中携带错误码参数（如 `/login?error=OAUTH_STATE_INVALID`），由前端映射为用户可读文案。

统一 OAuth 错误码表（在现有分散示例基础上补充）：

| 错误码 | 场景 |
|---|---|
| `OAUTH_PROVIDER_DISABLED` | Provider 未启用 |
| `OAUTH_STATE_INVALID` | state 不匹配、过期或重复消费 |
| `OAUTH_PKCE_INVALID` | PKCE verifier 校验失败 |
| `OAUTH_EMAIL_UNAVAILABLE` | Provider 未返回已验证邮箱 |
| `OAUTH_ACCOUNT_UNAVAILABLE` | 匹配邮箱的用户已停用或软删除 |
| `OAUTH_ACCOUNT_EXISTS` | 邮箱已存在但注册模式禁止自动创建 |
| `OAUTH_IDENTITY_CONFLICT` | Provider Identity 已绑定其他用户 |
| `OAUTH_EMAIL_MISMATCH` | 绑定模式的已验证邮箱与当前账户不一致 |
| `INVALID_INVITATION` | 邀请码无效或已过期 |
| `OAUTH_REGISTRATION_EXPIRED` | OAuth 注册挑战过期 |

### 生图供应商凭据配置

#### 管理员页面

新增供应商凭据配置能力，作为独立 `/admin/providers` 页面（见产品范围管理员后台章节）。

管理员可配置：

- 凭据名称，例如“OpenAI 主账号”“Seedream 国内账号”。
- 供应商类型：`openai` 或 `seedream`。
- API Base URL，沿用当前 Base URL 安全校验规则。
- API Key，写入或轮换时输入，读取时只显示是否已配置。
- 启用状态。
- 最近测试时间和测试结果。

管理员不可通过任何读取接口得到 API Key 原文、加密密文、Provider 原始响应或完整错误堆栈。

#### 模型与凭据关系

- 模型配置新增 `provider_credential_id`，并要求模型 adapter 与凭据 adapter 一致。
- 模型继续负责展示名称、供应商模型 ID、尺寸、质量、张数、并发、水印和启停。
- API Key 和默认 Base URL 从模型配置中移出，由供应商凭据提供。注意：当前实现中新任务创建时快照的 Base URL 来自模型配置的 `base_url`（`route.ts:175`），而非凭据的 Base URL。凭据的 `base_url` 目前仅在测试端点（`route.ts:283`）中使用。Worker 执行时按 `provider_credential_id` 读取当前凭据的 API Key，但 Base URL 使用任务创建时的快照（`provider_base_url`），因此轮换凭据的 Base URL 不影响已排队任务。如要统一来源，需改为任务创建时从凭据读取 Base URL 快照。
- 历史任务继续显示创建时保存的模型名称和参数快照。
- 新任务创建时保存 `provider_credential_id`、凭据名称和 Base URL 快照，但不保存 API Key。
- Worker 执行任务时按 `provider_credential_id` 读取当前凭据的 API Key（`apps/worker/src/index.ts:18-26`）；Base URL 使用任务创建时的快照（`provider_base_url`），而非凭据的 `base_url`，因此轮换凭据的 Base URL 不影响已排队任务。凭据被禁用或缺失时任务失败为 `PROVIDER_NOT_CONFIGURED`。

#### 凭据测试

- “测试连接”由服务端执行，前端只得到成功或经过过滤的错误码。
- 测试应优先使用低成本的 Provider 鉴权或模型可用性检查，不默认提交真实生图任务。当前实现统一对两种适配器调用 `GET {baseUrl}/v1/models`（`route.ts:286`）；OpenAI 兼容此端点，但 Seedream/火山方舟可能不支持 `/v1/models`，因此 Seedream 的测试对低成本可用性检查的覆盖低于 OpenAI。后续可增加 adapter 分支逻辑或标注 Seedream 测试覆盖限制。
- 如果某 Provider 没有可靠的低成本测试接口，则只做格式、安全和必填项校验，并提示”未完成真实调用验证”（当前 Seedream 测试如失败会返回 `CONNECTIVITY_FAILED`，但不排除仍有路由可达的判断误差）。
- 真实生图验收仍通过用户端或专门的管理员测试任务完成，不能把未实际生成的测试写成供应商已可用。

#### 密钥保存与轮换

- API Key 使用服务端主密钥加密后入库。
- 加密主密钥只来自服务端环境变量，例如 `PROVIDER_CREDENTIALS_ENCRYPTION_KEY`，不得存入数据库、前端或日志。
- 读取凭据列表时只返回 `hasApiKey`、`keyFingerprint`（8 字符 HMAC-SHA256 前缀，不可逆，由 `fingerprintApiKey` 在 `packages/providers/src/crypto.ts:21-23` 实现）、更新时间和测试状态。
- 管理员提交空 API Key 表示保持不变；提交新 API Key 表示轮换。
- 保存、轮换、启用、禁用和测试均写入审计日志，审计摘要不包含密钥、完整 Base URL query、Provider 响应或提示词。

## API 设计

所有接口继续使用统一响应格式：

```json
{ "success": true, "data": {} }
```

```json
{ "success": false, "error": { "code": "ERROR_CODE", "message": "说明" } }
```

### OAuth 接口

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/auth/oauth/providers` | 匿名 | 返回 GitHub、Google 是否可用，不返回 Client Secret |
| GET | `/api/auth/oauth/{provider}/start` | 匿名 | 发起登录授权跳转 |
| GET | `/api/auth/oauth/{provider}/callback` | 匿名 | OAuth 回调，成功后设置会话 Cookie 并重定向 |
| POST | `/api/auth/oauth/invitation` | 匿名加短期挑战 | 邀请模式下提交邀请码完成 OAuth 注册 |
| GET | `/api/account/oauth` | 登录用户 | 获取当前账户已绑定 Provider |
| GET | `/api/account/oauth/{provider}/link/start` | 登录用户 | 发起绑定授权跳转 |
| DELETE | `/api/account/oauth/{provider}` | 登录用户 | 解绑 Provider |

示例：`GET /api/auth/oauth/providers`

```json
{
  "success": true,
  "data": {
    "providers": [
      { "provider": "github", "label": "GitHub", "enabled": true },
      { "provider": "google", "label": "Google", "enabled": true }
    ]
  }
}
```

### 供应商凭据接口

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/admin/provider-credentials` | admin | 查询凭据列表，不返回 API Key |
| POST | `/api/admin/provider-credentials` | admin | 创建凭据 |
| PATCH | `/api/admin/provider-credentials/{id}` | admin | 更新名称、Base URL、启停或轮换 API Key |
| POST | `/api/admin/provider-credentials/{id}/test` | admin | 服务端测试凭据 |
| DELETE | `/api/admin/provider-credentials/{id}` | admin | 软删除未被模型使用的凭据 |

示例：凭据读取 DTO（匹配 `dto.ts:25-39` 实现）

```json
{
  "id": "uuid",
  "displayName": "OpenAI 主账号",
  "adapter": "openai",
  "baseUrl": "https://api.openai.com",
  "enabled": true,
  "hasApiKey": true,
  "keyFingerprint": "ab12cd34",
  "lastTestStatus": "success",
  "lastTestErrorCode": "CONNECTIVITY_FAILED",
  "lastTestedAt": "2026-06-21T00:00:00.000Z",
  "updatedAt": "2026-06-21T00:00:00.000Z"
}
```

### 模型接口调整

- `GET /api/admin/models` 返回模型关联的凭据 ID、凭据名称（当前 `modelDto` 仅返回 `providerCredentialId` 和 `providerCredentialName`，见 `dto.ts:5`）。如需展示凭据启用状态，需在路由查询 `route.ts:102` 的 LEFT JOIN 中增加 `pc.enabled`，并在 `modelDto` 中新增 `providerCredentialStatus` 字段。
- `POST /api/admin/models` 和 `PATCH /api/admin/models/{id}` 接收 `providerCredentialId`。
- `GET /api/models` 面向普通用户仍只返回可用模型展示信息，不返回凭据信息、Base URL 或供应商密钥状态。
- 创建任务时，如果模型启用但凭据缺失、禁用或未配置 API Key，返回 `PROVIDER_NOT_CONFIGURED`。

### 前端接口对接

实现时新增或调整以下前端文件（映射当前 `stores/`、`types/`、`services/api.ts` 的使用模式）：

- `types/index.ts`：新增 `OAuthProviderInfo`（`{ provider, label, enabled }`）、`OAuthIdentity`（`{ provider, providerSubject, emailAtLink, displayName?, avatarUrl?, linkedAt, lastLoginAt }`）、`ProviderCredential`（匹配 API DTO）、`ProviderCredentialInput`（`{ displayName, adapter, baseUrl?, apiKey?, enabled? }`）；在 `AdminModel` 扩展 `providerCredentialId`/`providerCredentialName`。
- `services/api.ts`：保持通用 `api<T>(path, options)` 模式不变（`line:23-52`），新增的 store action 直接调用 `api<T>()` 即可。
- `stores/auth.ts`：新增 `fetchOAuthProviders()`、`startOAuth(provider)` 页面跳转逻辑、`completeOAuthInvitation(code)`。
- `stores/admin.ts`：新增 `fetchProviderCredentials()`、`createProviderCredential(data)`、`updateProviderCredential(id, data)`、`testProviderCredential(id)`、`deleteProviderCredential(id)`。
- `stores/account.ts`（或扩展 `stores/auth.ts`）：新增 `fetchOAuthIdentities()`、`linkOAuth(provider)` 跳转、`unlinkOAuth(provider)`。
- `LoginPage.vue`：检测 `route.query.error` 显示 OAuth 错误；新增邀请码步骤的 OAuth 子流程（与现有邮箱→邀请码→OTP 三步不同，OAuth 回调后直接跳转到邀请码步骤，已验证邮箱不可编辑）。
- `AccountPage.vue`：新增 OAuth Identity 列表、绑定按钮、解绑按钮（匹配 `oauthIdentityDto`）。
- `AdminModels.vue`：移除 stale 说明"API Key 仍从服务端环境变量读取"；模型表单中增加 `providerCredentialId` 选择器（可选下拉），关联已启用凭据。
- `router/index.ts`：新增 `/admin/providers` 子路由（`{ path: 'providers', name: 'admin-providers', component: () => import('@/views/admin/AdminProviderCredentials.vue') }`）。
- `AdminLayout.vue`：navItems 数组中新增"供应商凭据"项。
- 新增 `AdminProviderCredentials.vue`：参照 `AdminSmtp.vue` 的"只写"密码输入模式实现密钥输入。组件包含凭据列表（DataTable）、创建对话框、编辑对话框（密码输入框为空表示保持不变）、测试按钮、启用/禁用开关、删除确认（ConfirmDialog）。

## 数据模型

所有新表主键使用 UUID，时间字段使用带时区时间戳，涉及软删除的表使用 `deleted_at`。

### OAuth Identity

OAuth Provider 枚举已存在（`migrate.ts:10`）：

```sql
oauth_provider: 'github' | 'google'
```

`oauth_identities` 表已存在（`migrate.ts:33-35`）：

| 字段 | 说明 |
|---|---|
| `id` | UUID 主键 |
| `user_id` | 关联 `users.id` |
| `provider` | `github` 或 `google` |
| `provider_subject` | Provider 稳定用户 ID |
| `email_at_link` | 绑定时的已验证邮箱 |
| `email_verified` | 绑定时邮箱是否已验证，必须为 true |
| `display_name` | Provider 昵称，可为空 |
| `avatar_url` | Provider 头像，可为空 |
| `linked_at` | 绑定时间 |
| `last_login_at` | 最近一次通过该 Identity 登录时间 |
| `deleted_at` | 解绑或软删除时间 |

约束：

- `UNIQUE(provider, provider_subject) WHERE deleted_at IS NULL`
- `UNIQUE(user_id, provider) WHERE deleted_at IS NULL`
- 不保存 OAuth access token、refresh token 或 ID token 原文。

OAuth `state`、PKCE verifier、`nonce` 和邀请模式下的短期注册挑战优先存 Redis，TTL 到期即可丢弃。Redis 丢失时用户重新发起 OAuth 登录，不影响核心数据一致性。

### 供应商凭据

`provider_credentials` 表已存在（`migrate.ts:36`）：

| 字段 | 说明 |
|---|---|
| `id` | UUID 主键 |
| `display_name` | 管理员可见名称 |
| `adapter` | `openai` 或 `seedream` |
| `base_url` | Provider Base URL |
| `api_key_encrypted` | 加密后的 API Key，可为空表示未配置 |
| `api_key_fingerprint` | 不可逆指纹，用于显示是否轮换 |
| `enabled` | 是否启用 |
| `last_test_status` | `success`、`failed`、`not_tested` |
| `last_test_error_code` | 过滤后的测试错误码 |
| `last_tested_at` | 最近测试时间 |
| `created_by` | 创建管理员 |
| `updated_by` | 最近更新管理员 |
| `created_at` | 创建时间 |
| `updated_at` | 更新时间 |
| `deleted_at` | 软删除时间 |

`model_configs` 已调整（`migrate.ts:37`）：

- 已添加 `provider_credential_id uuid REFERENCES provider_credentials(id)`。
- 保留现有 `adapter`，并校验模型 adapter 与凭据 adapter 一致。
- `base_url` 字段进入兼容期：实现迁移后不再作为 UI 主要编辑字段，后续可移除。

`generation_jobs` 已调整（`migrate.ts:38-39`）：

- 已添加 `provider_credential_id`，保存创建任务时选择的凭据。
- 已添加 `provider_credential_name`，用于历史任务显示和排障。
- 继续保存 `provider_base_url` 快照，但不保存 API Key。

## 服务端与 Worker 设计

### 服务端认证模块

- 新增 OAuth Provider 适配层，封装 GitHub 和 Google 的授权 URL、Token 交换、用户资料读取和邮箱验证。
- OAuth 回调只在服务端处理，不允许前端提交 provider token 换取 MuseCanvas 会话。
- 现有 `actorFrom`、会话 Cookie（`muse_session` HttpOnly SameSite=Lax）、管理员授权和 CSRF 来源校验继续复用。会话创建复用已有模式：`INSERT INTO sessions(user_id, token_hash, expires_at) VALUES($1, $2, now() + interval '30 days')` + `hashToken(randomToken())`（`route.ts:158`），通过 `response.cookies.set` 写入。
- OAuth 回调本身是跨站 GET，不走普通 mutation CSRF 校验，但必须严格校验 `state`（一次性使用，消费后 DEL Redis 键）。`state` 不能被 SameSite Cookie 保护（回调是跨站请求），因此完全依赖状态参数验证。
- `oauth_identities` 表（`migrate.ts:33-35`）和 `oauthIdentityDto`（`dto.ts:41-51`）已在代码库中存在，OAuth 路由直接使用即可。

### 生图 Provider 调用

当前已实现（无需修改）：

- `packages/providers/src/index.ts` 的 `generateImages` 入参为显式 `apiKey` 和 `baseUrl`，不再直接读取环境变量（`line:28-47`）。
- Worker（`apps/worker/src/index.ts:18-26`）通过 `resolveApiKey()` 从数据库 `provider_credentials` 表读取加密凭据，校验启用状态后解密调用。`ALLOW_PROVIDER_ENV_FALLBACK=true` 时回退到环境变量。
- 新任务创建时（`route.ts:173-175`）查询凭据是否启用且已配置 `api_key_encrypted`；凭据缺失/禁用时抛出 `PROVIDER_NOT_CONFIGURED` 阻止任务入队。
- 解密后的 API Key 只存在于服务端内存，不写入日志、错误消息、任务记录或 Redis payload。
- Provider 错误继续转换为平台错误码，例如 `PROVIDER_NOT_CONFIGURED`、`PROVIDER_TEMPORARY_ERROR`、`PROVIDER_REJECTED`。

### 迁移兼容

- `oauth_identities` 和 `provider_credentials` 表已在 `packages/database/src/migrate.ts:33-39` 创建（含 `oauth_provider` 枚举、两张表的唯一索引和 `model_configs`/`generation_jobs` 的关联列）。迁移文件目前不主动创建默认凭据记录。
- 线上迁移也可以为 `openai`、`seedream` 创建默认凭据记录（可选任务），Base URL 来自现有模型或环境变量，但不自动把环境变量中的 API Key 持久化到数据库——必须等待管理员在后台手动填写。
- 管理员需要在后台明确写入 API Key 后，模型才视为供应商凭据完整。
- 本地开发可保留短期环境变量 fallback，但必须由显式开关控制，例如 `ALLOW_PROVIDER_ENV_FALLBACK=true`，生产环境默认关闭。

## 环境变量

新增或调整 `.env.example`：

```bash
# OAuth, server-side only
OAUTH_REDIRECT_BASE_URL=http://localhost:8080
OAUTH_GITHUB_CLIENT_ID=
OAUTH_GITHUB_CLIENT_SECRET=
OAUTH_GOOGLE_CLIENT_ID=
OAUTH_GOOGLE_CLIENT_SECRET=

# Server-side encryption for provider credentials
PROVIDER_CREDENTIALS_ENCRYPTION_KEY=

# SSRF 防护开关（两个独立开关，均默认关闭，对应 route.ts:49-53）
ALLOW_INSECURE_PROVIDER_BASE_URL=false
ALLOW_PRIVATE_PROVIDER_BASE_URL=false

# Optional local/dev compatibility only
ALLOW_PROVIDER_ENV_FALLBACK=false
OPENAI_API_KEY=
ARK_API_KEY=
```

要求：

- 所有 OAuth 和 Provider 密钥都只能是服务端环境变量或服务端密文数据，禁止 `VITE_*`。
- `OPENAI_API_KEY`、`ARK_API_KEY` 在本功能完成后只作为本地兼容或迁移期 fallback，不作为生产推荐配置。
- 若后续将 OAuth Client Secret 也迁入管理员后台，需要单独设计防锁死策略和恢复流程。

## 安全与隐私

- 前端所有权限判断只用于展示，服务端继续强制认证和授权。
- OAuth、供应商凭据和 SMTP 凭据都不得出现在浏览器、日志、审计摘要、错误消息或测试响应中。
- 管理员任务列表仍不得选择或返回用户提示词、图片 URL、对象键或供应商原始响应。
- Base URL 校验沿用现有 SSRF 防护（`route.ts:49-53`）：默认只允许 HTTPS，拒绝用户名密码、query、hash 和私网地址。私网地址与 HTTP 协议由两个独立的环境开关分别控制——`ALLOW_INSECURE_PROVIDER_BASE_URL`（允许 HTTP 协议）和 `ALLOW_PRIVATE_PROVIDER_BASE_URL`（允许内网地址），均默认关闭。
- Seedream 返回的临时图片 URL 下载仍必须由 Worker 完成，并校验协议、文件类型、大小和尺寸。
- 禁用用户、软删除用户、撤销会话等现有规则对 OAuth 登录同样生效。
- OAuth Identity 自动绑定只基于 Provider 验证过的邮箱；未验证邮箱不得创建或绑定账户。
- 管理员配置变更必须写入审计日志，但审计日志只记录动作、目标 ID、非敏感摘要和时间。

## 验证计划

进入实现阶段后，至少需要覆盖：

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`（当前 `apps/api/src/backend.test.ts` 仅覆盖 5 项纯单元测试，使用 `node:test`，无 DB/Redis/HTTP harness）
- 集成测试基础设施：新增 DB/Redis 测试 harness，支持针对 OAuth 路由、凭据 CRUD 和 Worker 数据库操作的集成测试（当前 runner 无法执行涉及数据库的测试用例）
- OAuth 单元/集成测试：state 校验、Google 邮箱验证与 ID Token 校验逻辑、GitHub verified primary email 获取与缓存、邮箱匹配自动绑定、账户状态拒绝（`OAUTH_ACCOUNT_UNAVAILABLE`）、邀请模式短期挑战一次性消费、Identity 冲突、链接模式 state 校验。
- Provider 凭据测试：API Key 加密写入/解密轮换、读取不返回密钥原文、空 Key 保持不变、fingerprint 轮换后更新、禁用凭据阻止新任务。
- Worker 测试：任务执行时使用数据库凭据（需 DB harness），缺失或禁用凭据返回 `PROVIDER_NOT_CONFIGURED`。
- 前端冒烟：登录页 OAuth 按钮展示与条件隐藏、OTP 兼容、邀请码步骤在 OAuth 回调后的展现、账户页 OAuth Identity 列表与绑定/解绑、管理员供应商凭据页 CRUD 与测试。
- 真实外部验收：配置有效 OpenAI 和 Seedream 凭据后，各完成一次真实成功生图、资产转存和下载验证；未执行时必须在 `result.md` 如实记录。

## 设计风险与取舍

- OAuth 登录会引入第三方可用性依赖，因此邮箱 OTP 必须继续保留。
- GitHub 用户可能没有公开邮箱，必须通过 `user:email` 获取 verified primary email；没有可用邮箱时不能自动创建账户。
- 邀请模式下 OAuth 回调后需要额外邀请码步骤，登录体验会比开放注册多一步，但能保持现有注册策略一致。
- 生图供应商 API Key 配置 UI 上线后（后端凭据表与加密已实现）会提升运维便利性，但也要求服务端加密主密钥（`PROVIDER_CREDENTIALS_ENCRYPTION_KEY`）稳定保存；主密钥丢失会导致已有凭据不可解密，需要管理员重新录入。
- 凭据被禁用或删除可能影响队列中未执行任务。本设计选择不保存历史 API Key，优先保证密钥安全；未执行任务在凭据不可用时失败并返回稳定错误码。
- OAuth Client Secret 本次仍通过部署环境配置，避免管理员后台误配置导致所有登录入口同时不可用；若未来需要后台配置 OAuth Provider，应增加至少一个环境级恢复入口。
