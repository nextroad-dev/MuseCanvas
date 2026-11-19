# API

Next.js API 应用。路由入口放在 `app/api`，业务实现放在 `src/modules`；
认证、HTTP 基础设施和中间件保持独立，路由层不直接访问数据库或供应商。

Agent 对外入口为 `/api/agent/*`。旧 CanvasAgent 的 `/api/canvases/:id/agent/*`、
`/api/canvas-agent/status` 和 `/api/admin/canvas-agent-settings` 已退役，按普通未知路径处理；
旧 Agent Core 会话不会自动转换为新 Agent Core 会话。
历史表与迁移保留，移除代码不会执行数据清理。

生成入口（2026-11-19 起）：`POST /api/generations` 与 `POST /api/images/edit` 已删除，媒体生成仅作为 Agent 工具执行；`GET /api/jobs*`、`POST /api/jobs/:id/{cancel,retry}`、`DELETE /api/jobs/:id` 与 `POST /api/images/edit/preparations` 保留。

## Agent 准入与图片准备

四套 Compose 可选透传 `AGENT_CORE_ENABLED`、`AGENT_CORE_ADMISSION_READY`、`AGENT_ADMISSION_PERCENT`、`AGENT_ADMISSION_ACTORS`；默认分别为 `false`、`false`、`0`、空。开关不会因本次代码修改而在目标环境自动启用。白名单可绕过百分比限制，但不能绕过 readiness。

`POST /api/images/edit/preparations` 的 multipart 元数据契约为 `PrepareAgentImageEditRequest`，图片和 mask 仍为二进制 part；`region` 在 multipart 中序列化为 JSON 文本。接口要求活动账户、同源 mutation 校验和 migration 0045：

- 无 `turnId`（包括仅有 `sessionId`）按新工作准备，校验当前 actor admission；提供 session 时还校验所有权与未归档状态。
- 有 `turnId` 必须同时有 `sessionId`；数据库证明会话归属、当前活跃且未终态/未取消的 turn，以及数据库时钟内有效的 deadline 后，才可在暂停新准入时继续准备。
- 无效 UUID、缺配对字段或重复 part 为 400；不存在、跨 owner 或过期的资源上下文统一为 404；新工作 admission 关闭为 503。namespace 关闭时，精确准备路径与 `/api/agent/*` 均在认证前返回 404。

准备只暂存输入，不创建付费 job。session/turn 用于当次暂存授权，不构成持久的 turn 绑定；最终 message、附件来源、有效期与批准后的输入重验仍是执行依据。暂存元数据写入会在短事务内锁定活动 owner，避免账户删除提交后新增输入；对象存储 I/O 不持有该锁。接口及错误信封详见根 `openapi.yml`，新 Core 专用规范仍限定 `/api/agent/*` 子集。

## 默认 Agent 定义的供给

`agent_definitions` 不自动 seed，唯一写入方式是 `scripts/agent-definition.ts`（默认 dry-run，`--apply` 落库）。媒体生成现在只经 Agent 工具执行，因此在 live 模式下至少要有一个 active 定义：

1. 先配置一个启用的 `language` 模型（内置 `openai_chat` / `anthropic_messages` 插件）。
2. 运行 `pnpm --filter @musecanvas/database exec tsx ../../scripts/agent-definition.ts --owner <user-uuid> --name '<name>' --instructions @./instructions.md --model-config <model-config-uuid> --apply`。
3. 把输出的定义 UUID 写入 web 服务的 `AGENT_DEFAULT_DEFINITION_ID`（可同时设置 `AGENT_DEFAULT_DEFINITION_VERSION`，默认 1）。该变量由 web 在每个请求上读取，不参与前端构建内联，因此同一镜像可服务不同实例；留空时「新建对话」会提示未配置。

`AGENT_CORE_ENABLED=true` 才开放 `/api/agent/*`；`AGENT_CORE_ADMISSION_READY=true` 才受理新会话/新 turn。关闭 admission 不影响已受理 turn 的恢复、结算与取消。

