# MuseCanvas MVP 实现结果

## 设计文档

引用：`design.md`

## 结果状态

- 状态：代码实现与本地 Docker Compose 联调已完成
- 完成日期：2026-06-21
- 说明：本功能历史上未在编码前生成 `impl.md`，本结果文档不事后伪造实现计划；后续编号功能按 `design.md -> impl.md -> result.md` 执行。

## 完成情况

- [x] 建立 pnpm workspace，完成 Vue 3 用户端与管理后台、Next.js API、独立 Worker 和共享包结构。
- [x] 实现邮箱 OTP 注册与登录、安全会话、首个管理员初始化以及 `user`、`admin` 服务端授权。
- [x] 实现开放注册和邀请注册切换、绑定邮箱的一次性邀请码及 SMTP 配置和测试。
- [x] 实现邀请注册三步流程：邮箱判断后仅对需要注册的新用户展示邀请码，邀请码验证通过后才发送 OTP。
- [x] 实现用户停用、恢复、软删除、会话撤销和持久化异步清理。
- [x] 实现 GPT Image 与 Seedream 适配器、管理员自定义 Base URL、常用模型参数预设和模型并发限制。
- [x] 实现生成任务、PostgreSQL outbox、Redis Stream、Worker 重试与恢复状态。
- [x] 实现 S3 兼容对象存储、私有图库、短期签名下载和资产软删除。
- [x] 实现管理仪表盘、注册、SMTP、用户、模型和非敏感任务管理页面及接口。
- [x] 实现 Docker Compose 和 Nginx 反向代理，本地包含 PostgreSQL、Redis、MinIO 与 Mailpit。
- [ ] 使用真实供应商凭据完成 GPT Image 与 Seedream 各一次成功生图验收：当前本地环境未配置可用于验收的供应商密钥，因此未将真实外部调用写成已验证。

## 变更摘要

- `apps/web`：实现登录、生成、图库、账户和管理员页面；使用 Vue Router、Pinia、Tailwind CSS 及项目内 UI 组件。
- `apps/api`：实现统一响应、认证授权、注册策略、用户与模型管理、任务和图库 API、安全 DTO、限流及 CSRF 来源校验。
- `apps/worker`：实现 outbox 投递、Redis Stream 消费、模型并发许可、供应商调用、S3 持久化、失败重试和删除清理。
- `packages/database`：建立用户、会话、OTP、邀请码、SMTP、模型、任务、资产、outbox、清理任务和审计日志表。
- `packages/providers`：实现 OpenAI 兼容图片接口和 Seedream 接口，支持管理员配置安全的 HTTPS Base URL。
- `infra` 与 `compose.yaml`：提供 Web、API、Worker、Nginx、PostgreSQL、Redis、MinIO、Mailpit 的构建、健康检查和本地编排。
- `.env.example`：集中列出服务端所需环境变量，不包含真实密钥。

## 验证记录

- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm test`：通过，API 单元测试 5 项全部通过。
- `pnpm build`：通过，Web 与 API 均完成生产构建。
- `docker compose up --build -d`：通过，所有服务成功启动，API 健康检查通过。
- 管理后台端到端冒烟：OTP 管理员登录及各管理接口通过，匿名管理接口访问被拒绝。
- 邀请注册真实本地联调：未注册邮箱首先返回 `nextStep: invitation` 且不发送邮件；错误邀请码返回 `INVALID_INVITATION`；有效邀请码触发 OTP，验证后成功创建普通用户。
- 容器日志检查：本次重建和联调期间未发现 API、Web 或 Nginx 致命错误。
- 未执行：真实 GPT Image、Seedream 供应商成功调用；需要各供应商有效密钥和已获批模型。

## 设计偏差

- 编码前未生成 `impl.md`，不符合文档链路要求。本次通过更新根目录与 `/docs` 的 Agent 规则增加强制完成门禁，避免后续遗漏。
- 邀请注册交互按后续确认调整为显式三步流程，因此邀请码模式下会暴露邮箱是否已经注册；接口仍按邮箱和 IP 限流，且不返回角色、用户 ID 等额外账户信息。
- 本地 Compose 增加 MinIO 和 Mailpit 作为对象存储与 SMTP 联调服务；它们属于本地基础设施，不作为生产服务选型承诺。

## 遗留问题

- 配置有效供应商密钥后，需补充 GPT Image 与 Seedream 各一次真实成功生图、资产转存和下载验收记录。
- 当前自动化覆盖以 API 单元测试和管理员冒烟为主；设计中列出的并发消费、Worker 故障恢复、跨用户资源隔离和对象清理仍应扩展为可重复执行的集成测试。
- 生产部署需启用安全 Cookie、受信任的 HTTPS 域名、加密 SMTP，并替换本地 MinIO、Mailpit 配置。
