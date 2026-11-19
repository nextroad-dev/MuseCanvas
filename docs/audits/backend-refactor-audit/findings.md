# 审计发现与处理状态

## 分级说明

P0 严重；P1 高优先级风险；P2 中优先级；P3 低优先级/维护性。置信度评估的是代码证据，不代替未知产品/运维决策。位置及结论保留原审计快照（其中行号可能已变化）；状态栏更新至 2026-11-18 推荐实施后的工作区。实际命令、计数与操作边界见 `implementation.md`。

| ID | 级别 / 置信度 | 原涉及位置 | 原发现 | 当前处理状态 |
|---|---|---|---|---|
| F-01 | P1 / 高 | `apps/api/src/modules/admin/users.ts:79-92`; `apps/worker/src/maintenance/index.ts:123-142`; `maintenance/canvas-cleanup.ts:8-28`; migrations `0041`/`0042` | 用户删除完成路径仅清理旧 Canvas 数据，没有覆盖新 Agent instructions/items/turn snapshots；且 legacy links 有非级联 FK 时先删 Canvas 父记录可能令事务失败 | 已补取消意图、收敛等待与显式政策阻塞，避免假完成；最终擦除政策和真实 PG 验证仍待完成 |
| F-02 | P1 / 高（构建风险） | `deploy/docker/web.Dockerfile:4-16`; `apps/api/package.json`; `apps/worker/package.json`; `packages/observability/package.json` | Web Docker install 前会复制 api/worker manifests（它们依赖 observability workspace），但未复制 observability manifest；安装时 workspace graph 可能不完整。未实际 Docker build，静态高风险，不声称已复现构建错误 | 已补 manifest、最终 WORKDIR 输入检查及 ignore 触发回归；实际 clean-context Docker 构建仍未执行 |
| F-03 | P1 条件 / 高 | `apps/api/src/modules/agent/feature.ts:3-24`; 四份 `deploy/compose*.yaml` backend environment | Compose 未映射 `AGENT_CORE_ENABLED`/`AGENT_CORE_ADMISSION_READY`；Compose 默认启动不会因宿主 `.env` 自动把变量注入容器。若产品要求开启 Agent Core，则配置路径缺口；默认关闭可能是安全选择 | 四份 Compose 已可选透传 namespace/readiness/actor rollout，默认 false/false/0/空；未开启目标环境 |
| F-04 | P2 / 高 | `apps/worker/src/queue/outbox-routing.ts:1-3,54-63`; `queue/index.ts:26-49,174-181`; `agent/redis-queue.ts:5-14,37-40`; `index.ts:121-128` | Agent turn / media events stream 由 outbox 写入、consumer ack；仓库 retention 只修剪 generation stream。外部可能有其他保留措施未确认 | 已实现原子安全边界、有界元数据/批次及指标，默认关闭；真实 Redis 与保留窗口仍待确认 |
| F-05 | P2 / 高 | `apps/worker/src/maintenance/index.ts:99-109,131-152`; `apps/worker/src/index.ts:106-113` | deletion/asset deletion 领取用了 `FOR UPDATE SKIP LOCKED` 查询，但领取与对象删除/状态更新分语句，数据库行锁结束后无持久 claim lease；单进程 `cleaning` guard 不保护多副本 | 已追加 0046、CleanupJobRepository 及短事务 fencing/重试，旧 Worker 必须先停；真实并发 fixture 待 CI |
| F-06 | P2 / 高 | `.github/workflows/backend-reliability.yml:6,48-52`; `tests/integration/agent-{runtime,recovery,media-terminal}-pg.test.ts`、`agent-streams-redis.test.ts`; `media-quality.yml:74-79` | Agent PG/Redis 集成测试使用专用 `MUSECANVAS_AGENT_*` URL，相关 CI fixture 未注入这些变量；通用 media-quality glob 会在无 URL 时 skip。不能把未配置的集成断言算作已验证 | 已配置五套独立 fixture 和拒绝缺 URL/skip/缺 plan/重复统计的 runner；本地 5 skip，真实 CI 未执行 |
| F-07 | P2 / 中（策略待确认） | 当前未提交 `apps/api/src/modules/image-edit/handlers.ts:316-360`; `apps/api/src/router/routes.ts:201`; `modules/agent/handlers.ts:45-47,68-70` | `prepareAgentImageEdit()` 只检查 `agentCoreEnabled()`，而创建 session/message 使用 actor-specific `agentCoreAdmissionReady(actor.id)`。全局 Core 开启时，尚未 admission 的已认证用户也能暂存 Agent 专用输入/遮罩；不会因此直接创建 generation 或收费任务 | 已实现 actor admission 及可信 owner/session/活跃 turn 证明；共享契约、API/Web/OpenAPI 和授权测试同步 |
| F-08 | P2 / 高 | `openapi.yml` description; `apps/api/src/router/canvas-openapi.test.ts:179-206`; `modules/agent/agent-openapi.test.ts:23-53`; `router/router.test.ts` | OpenAPI 详细一致性校验有意覆盖 Canvas/设置/Agent 等子集，而非所有 API；其余主要靠 routes 与 `API_ENDPOINTS` 一致性测试 | 本轮加强准备接口字段/配对/DTO 契约测试；其余 API 的完整 schema 覆盖仍非本轮目标 |
| F-09 | P2 / 中高 | `packages/providers/package.json`; `apps/web/package.json`; `pnpm-lock.yaml` | Providers 声明自己未使用的 S3 SDK，真实导入位于 API/Worker 且各自声明；Web 源码未使用 Noto Serif 字体 | 已清理：从相应 package manifest 移除并同步 lockfile；见 `cleanup.md` |
| F-10 | P3 / 高 | `apps/api/src/modules/admin/plugin-catalog.ts` 的 `isCatalogPluginActive` | 精确全仓搜索、路由/动态装载/测试/脚本及 exports 核实无调用；仅包装 `resolveCatalogPlugin(...) !== null`，现有使用方需要完整结果直接使用 `resolveCatalogPlugin` | 已清理：删除 3 行 wrapper；API 检查见 `cleanup.md` |
| F-11 | P2 / 高（生产孤立），删除信心低 | `apps/worker/src/provider-state.ts:102-106`; `provider-state.test.ts:45-46` | `manifestContainsSecrets` 未进入生产消费链，但测试用它表达敏感 URL 净化安全断言；直接删会削弱安全覆盖 | 保留；如迁移，应把断言改为对输出 DTO 的直接安全性质测试 |
| F-12 | P2 验证阻断 / 高（当前工作区） | `apps/web/src/features/agent-console/components/agent-composer.tsx`; `apps/web/src/features/agent-console/lib/attachment-references.test.mjs`; `agent-console-view.lifecycle.test.mjs` | 最终全仓 typecheck/build 已通过，但 Web 测试 189 项中仍有 2 项失败：侧栏生命周期断言预期 2 实际 0；新 attachment 测试的 Node ESM 加载无法解析 workspace `packages/contracts/src/endpoints`。失败内容是用户未提交文件，未修改；源码测试快照在审计过程中变化 | Web 已加入统一 TS loader；并行侧栏/测试更新保留，最终 Web 185 项与全仓 1,652 项全部通过 |

## 业务调用链交叉核对

- 普通 generation：`modules/generations/create.ts` → API `create-job.ts` → `media-service` transactional command → outbox → worker `processJob()` → provider / output ingestion。
- Agent message：Agent handlers/service → `AgentCoreRepository.message()` 事务写入 receipt/event/wake outbox → dispatcher → `muse:agent` → Runner。
- Agent 媒体审批：Runner/materializer 固定 revision、参数、预算、输入；审批解析后执行器重验，再通过共享 media-service 在事务内创建 job、绑定输入并追加 generation outbox；生成终态事件交 Agent media event/recovery 结算和续跑。
- 旧 CanvasAgent：审计时为语义独立的公开链路；后续已按用户明确指令退役代码与公开入口。旧会话不自动迁移，历史数据/迁移及账户清理责任保留，详见 `canvas-agent-removal.md`。
- 计费注意：当前 Agent tool proposal 采用 `free-v1`、`0 USD` 估算 reservation；结算记录的是 Agent 预算账本中的媒体任务/输出使用，不应等同旧积分扣款。未知估算按 unknown 处理。

## 保留与禁止误删

- 已应用历史 migrations、rollback 和持久化结构不做清理。`packages/database/src/migrations/runner.ts:184-209` 将已记录但缺失或 checksum 漂移视为 hard failure；修正应追加迁移。
- 旧 CanvasAgent 的公开入口与专属代码已获准退役；仍被新 Core 使用的摘要语义迁移至 `canonicalJsonDigest` 并保留兼容向量。普通 Canvas、共享媒体能力及历史迁移不随旧助手退役而删除。
- `media-service`、Outbox/各 Stream consumer、Worker 插件 availability/loader、recovery coordinator 都是被真实调用的边界，不做跨职责合并。
- F-01 的最终内容擦除、F-03/F-04 的生产启用及保留期限仍需明确政策与操作授权；本轮只实施经过审查的停写/收敛/阻塞、默认关闭配置和受保护修剪代码，未执行实际数据删除或部署。

## 置信度与剩余缺口

静态调用和测试来源可核实；实际数据库状态、部署 Compose overrides、Redis stream 体量、外部调用方/运维计划任务未查证。有关生产影响的表述均为条件性风险，需部署数据和产品决策确认。