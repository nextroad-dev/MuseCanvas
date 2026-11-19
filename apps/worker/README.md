# Worker

独立 TypeScript 后台进程。队列消费者放在 `consumers`，可重试任务处理器放在
`jobs`，周期性恢复与清理逻辑放在 `schedulers`。

## Cleanup 领取与账户删除

`src/maintenance/claimed-cleanup.ts` 使用 `CleanupJobRepository` 原子领取账户和资产清理任务；claim token、数据库时钟租约和进度写入共同隔离过期 Worker。对象存储 I/O 位于事务外，删除仍需幂等，不承诺外部副作用恰好一次。

新 Worker 启动前要求追加迁移 `0046_cleanup_claim_leases.sql` 的八个字段已存在。部署顺序必须先停掉旧 cleanup Worker，再应用迁移并启动新版本；旧二进制不校验 token，不能与新版本混跑。本地添加迁移不表示已经应用到任何数据库。

账户删除只记录取消意图，等待 turn、预算、Provider、输出导入和对象删除等状态收敛。新 Agent 内容、私有 definitions、准备记录和受保护引用尚无完整擦除政策时，任务显式阻塞并保留原因，不设置完成标记。共享系统 definitions 与历史表继续保留。

## Agent Stream 保留

Agent turn 与 media stream 的修剪默认关闭；只有下面三个值都明确且有效才运行：

| 变量 | 默认 | 启用条件 |
|---|---|---|
| `AGENT_STREAM_RETENTION_ENABLED` | `false` | 精确为 `true` |
| `AGENT_STREAM_RETENTION_SECONDS` | `0` | 十进制整数 1–31536000 |
| `AGENT_STREAM_TRIM_BATCH_SIZE` | `0` | 十进制整数 1–10000 |

窗口由恢复、重放和业务保留要求确定，本仓库不替生产环境选择时长。Lua 在同一原子操作中检查保留窗口、已投递游标和最早 pending；未知 group、无 group、未读和年轻记录均受到保护。元数据查询与每次删除批次有界；generation 修剪失败不会阻止 Agent 维护。既有 generation retention 配置保持原语义。

Worker 本机 `127.0.0.1:3010` 的 `/metrics` 提供固定 stream-kind 标签的长度、pending 数、最早 pending 条目年龄、删除量、失败及跳过原因。未采样/未知 gauge 省略，不冒充零；删除条数不等于实际回收内存。

`AGENT_CORE_ENABLED` 和新工作 admission 是 API 准入开关；Worker 已受理任务的恢复和结算不受这些开关阻断。需暂停新增任务时关闭 admission，保留 namespace 以便已有会话读取和控制。

## 隔离 CI

Backend reliability CI 为 runtime、recovery、media terminal、cleanup 与 streams 提供专用的 disposable PostgreSQL/Redis fixture。`scripts/run-agent-fixture.mjs` 要求对应专用 URL，并拒绝缺失配置、失败、跳过、缺 plan 或重复统计；无服务本地加载产生的 skip 不是实际集成验证。真实 fixture、镜像构建和目标环境验收分别记录。

