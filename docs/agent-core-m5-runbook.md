# Agent Core M5：用户控制、恢复与灰度运行手册

- 日期：2026-11-17
- 分支：`feat/agent-core-m5`
- 基线：`f55e9d4`（P4 控制面 + P5a lease/fencing 的整合快照）
- 范围：M5「用户控制和灰度」在本仓库可独立落地的部分
- 非目标：不包含 M2/P5 Runner、M3 媒体事件消费者、M4 Web 工作台接线和旧 Canvas 入口适配

## 1. 本次落地内容

| 能力 | 实现位置 | 说明 |
|---|---|---|
| 取消 / steering / 审批决议 | `apps/api/src/modules/agent/*`、`AgentCoreRepository` | P4 已有；本次补齐 deadline 后的拒绝与错误码投影 |
| 预算持久化 | `packages/database/src/repositories/agent-budget.ts` | 原子 reserve/settle/release、usage 聚合、幂等重放 |
| 恢复扫描 | `agent-recovery.ts` | deadline 终态、审批过期、取消收尾、过期 lease 再唤醒、outbox 积压 |
| 媒体对账 | `agent-media-recovery.ts` | 终态 generation job → ToolCall/Turn 收尾、预算结算、条件唤醒 |
| Worker 协调器 | `apps/worker/src/agent/coordinator.ts`、`apps/worker/src/index.ts` | 周期执行五类扫掠，失败隔离，不随 API 灰度开关停止 |
| 灰度准入 | `apps/api/src/modules/agent/feature.ts` | actor 允许名单 + 确定性百分比分桶；只作用于新 Session/Turn |
| 恢复索引 | `migrations/0044_agent_recovery_indexes.sql` | 仅新增部分索引，附逆向脚本 |
| Turn 错误投影 | `AgentCoreRepository.agentTurnDTO` | 只暴露 allowlist 错误码与固定文案，不漏 Provider 内容 |

## 2. 配置项

| 变量 | 默认 | 语义 |
|---|---|---|
| `AGENT_CORE_ENABLED` | 关闭 | 严格 `agent` / `agent/` 命名空间总开关。关闭时整命名空间 404，不影响 legacy Canvas。**灰度回滚不要先关它**。 |
| `AGENT_CORE_ADMISSION_READY` | 关闭 | 新 Session/新 Turn 的部署级准入门槛；已有 receipt 可重放，已有 Turn 可读、steer、cancel、审批。 |
| `AGENT_ADMISSION_PERCENT` | `100` | 在 admission-ready 前提下的 actor 灰度百分比 0–100；未设置视为 100，非法值按 0 失败关闭。 |
| `AGENT_ADMISSION_ACTORS` | 空 | 逗号分隔的 actor 允许名单；命中者绕过百分比，但仍受 `AGENT_CORE_ADMISSION_READY` 约束。 |
| `AGENT_RECOVERY_INTERVAL_MS` | `5000` | Worker 协调器周期，1000–60000；非法值回退默认。 |
| `AGENT_RECOVERY_BATCH_SIZE` | `50` | 单次扫掠上限，1–500；非法值回退默认。 |

百分比分桶：`sha256(actorId)` 前 4 字节大端取模 100，跨实例稳定；同一个 actor 不会在新旧入口之间漂移。

## 3. 部署前置条件

- **Agent 定义由运维预置**：应用不会创建任何 seed/default Agent 定义或模型配置；上线前必须由运维在 `agent_definitions` 与 `model_configs` 中显式写入并通过校验，空库直接打开准入只会失败。
- **真实环境验证未完成前保持关闭**：`AGENT_CORE_ENABLED` 与 `AGENT_CORE_ADMISSION_READY` 必须保持关闭，直到在真实 PostgreSQL、Redis 和 Provider 上完成迁移、调度与一次成功生成验证；集成 fixture 只是 source-only，不能替代该验证。
- **数据库至少迁移到 `0045`**：0041–0045 全部为必需，缺一不可。Worker 启动预检会以以下错误码失败：`WORKER_SCHEMA_0042_REQUIRED`（outbox 租约/隔离列）、`WORKER_SCHEMA_0043_REQUIRED`（控制面恢复列）、`WORKER_SCHEMA_0044_INDEX_REQUIRED`（四个恢复索引）、`WORKER_SCHEMA_0045_REQUIRED`（媒体 mask 准备身份列）。

## 4. 灰度上线步骤

1. 应用迁移到 `0045`，确认 0041–0045 均已执行，且 `agent_turns_deadline_recovery_idx` 等四个 0044 索引存在。
2. 部署 Worker，确认预检通过（`WORKER_SCHEMA_0042_REQUIRED` / `0043` / `0044_INDEX` / `0045` 均未出现），日志出现协调器运行记录（无工作时静默）。
3. 设置 `AGENT_CORE_ENABLED=true`，保持 `AGENT_CORE_ADMISSION_READY=false`：只读、steer、cancel、审批可用，新任务不受理。
4. 设置 `AGENT_CORE_ADMISSION_READY=true`，从 `AGENT_ADMISSION_PERCENT=1..5` 或 `AGENT_ADMISSION_ACTORS` 内测名单开始。
5. 观察：新 Turn 的 `queued → running`、`waiting_*` 事件、coordinator `processed` 日志、`outbox_events` pending 与 quarantine 计数。
6. 按 5% → 25% → 50% → 100% 提升百分比；每次变更只影响新准入，已有 Turn 固定 `engine_version='agent-core-v1'`。

## 5. 回滚演练

**标准回滚（推荐）**

1. 设置 `AGENT_CORE_ADMISSION_READY=false`（或把 `AGENT_ADMISSION_PERCENT=0` 并清空允许名单）。
2. 不关闭 `AGENT_CORE_ENABLED`：已受理 Turn 的读取、steer、cancel、审批决议仍可用。
3. 保持 Worker 运行：协调器继续处理 deadline、审批过期、取消收尾、媒体终态对账和过期 lease。
4. 已创建的 `generation_jobs` 不回滚、不删除，由既有媒体 Worker 排空；Agent ToolCall 记录真实结果。
5. 等待新引擎无 pending Turn、无 waiting_external、无 pending approval 后，再按发布流程回退代码。

**命名空间下线（仅在已确认无在途 Turn 时）**

`AGENT_CORE_ENABLED=false` 会让所有 agent 路径在认证前 404，包括读与取消。只能在确认没有在途 Turn、或运维改用数据库直接收尾后执行。

**数据回滚**

- `0044` 仅索引，可安全执行 `rollback/0044_agent_recovery_indexes.sql`。
- `0045/0043/0042/0041` 的逆向脚本会删除控制面/账本/核心表，只能作为离线灾难恢复，且必须先确认无在途 Turn、无待排空媒体任务、已完成备份。

## 6. 协调器扫掠语义

| 扫掠 | 触发条件 | 结果 |
|---|---|---|
| `expireDeadlines` | `deadline_at <= now()` 且非终态 | Turn `failed` + `DEADLINE_EXCEEDED`；审批过期、本地 ToolCall 失败、预算预留释放、active turn 清空；不唤醒 |
| `expireApprovals` | `expires_at <= now()` 且 pending | 审批 `expired`、ToolCall `failed`/`APPROVAL_EXPIRED`、预留释放；所有门禁满足时 Turn 回 `queued` 并唤醒 |
| `finalizeCancellations` | `cancel_requested_at` 存在、无活跃 lease | 本地 ToolCall `cancelled`、审批过期、可释放预留释放；Turn `cancelled`；`waiting_external` 保留给媒体对账 |
| `recoverExpiredLeases` | `running` 且 lease 过期、未取消、未超 deadline | 清理过期 lease 并重发 `agent.turn.wake`（按 fencing token 去重） |
| `reconcileMediaJobs` | `waiting_external` 且所有关联 job 终态 | ToolCall completed/failed/cancelled；结算 media 预算；整轮门禁满足时 `queued` + 唤醒；取消的 Turn 不唤醒 |
| `outboxBacklog` | 每次协调器运行 | 输出 pending 数、最老年龄、quarantined 数；超阈值告警 |

协调器使用 `FOR UPDATE SKIP LOCKED` 与数据库时钟，可在多副本下运行；所有扫掠按 `Session → Turn → Tool → Approval → Reservation` 顺序加锁，候选行先无锁读取、加锁后复查，竞争中的行留待下一轮。每条 Outbox wake 使用恢复专用 dedupe key，重复扫掠不会重复入队。

## 7. 验收对照

- **cancel 后不再提交新媒体任务**：`withTurnLease` 在 `cancel_requested_at` 或 deadline 存在时拒绝执行与提交；协调器负责收尾。Runner 端调用点属于 M2/P5。
- **已提交但无法取消的任务保留真实结果**：`reconcileMediaJobs` 只在 job 终态后写 ToolCall 结果，不伪造成功、不删除 job。
- **approval resolve 幂等**：`AgentCoreRepository.resolveApproval` 按 approval + arguments hash 幂等；审批已自然到期时 API 返回 409/`APPROVAL_EXPIRED` 并带回最终 approval 数据，Turn 已过 deadline 后的新决议同样拒绝。
- **新旧入口不重复计费/job/asset**：灰度只控制新准入，`engine_version` 固定；legacy 路由与表不变。跨入口 `agent_legacy_links` 适配仍未实现。
- **关闭新入口后已受理任务仍排空**：admission 开关不影响协调器与媒体 Worker，见回滚步骤。

## 8. 已知缺口（不属于本次 M5 切片）

1. **Runner / Agent consumer（M2/P5）**：`muse:agent` 与 `muse:agent-media-events` 尚无消费者；协调器只保证数据库权威状态可恢复，不能自行调用模型或 Provider。
2. **媒体完成事件生产者（M3）**：`media.job.completed` 只有契约与路由；当前靠协调器扫描数据库兜底。
3. **旧入口适配（P8）**：`legacy-canvas-adapter.ts`、`agent_legacy_links` 写入、跨入口幂等未实现。
4. **Web 工作台（M4）**：`agent-console` 仍走 mock API；控制端点已具备，接线未完成。
5. **真实环境验证**：PG/Redis/Provider/浏览器烟雾测试未执行；集成 fixture 为 source-only、显式 opt-in。

## 9. 本地验证证据（2026-11-17）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | exit 0；contracts/config/domain/database/providers/media-service/observability/api/worker/web 全部通过 |
| `pnpm test` | exit 0；9 个包共 1433 个测试通过（database 256、api 494、worker 132、web 180、providers 241、domain 33、contracts 74、media-service 18、observability 5） |
| `pnpm lint` | exit 0；0 errors，仅既有风格 warning（含新文件中的 `no-explicit-any` / `preserve-caught-error`） |
| 集成 fixture 独立 tsc | `agent-recovery-pg.test.ts` 与既有 `agent-runtime-pg.test.ts` 均 exit 0；未连接真实 PostgreSQL |
| `git diff --check` | exit 0 |

集成 fixture 运行方式（需显式授权并有隔离 fixture 库）：

```bash
MUSECANVAS_AGENT_RECOVERY_PG_URL=postgres://fixture@127.0.0.1:5432/postgres \
  pnpm exec tsx --test tests/integration/agent-recovery-pg.test.ts
```

该 URL 只允许 loopback / `fixture` 用户 / 初始库 `postgres`；fixture 会创建随机数据库、迁移到 `0045` 并在结束后删除。不得复用生产或共享开发库。
