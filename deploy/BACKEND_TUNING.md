# 后端资源预算、保留与回滚

本轮变更保持 API 路径和响应结构；调整配置传播时效、限流预算、后台并发及历史消息保留策略。所有操作应先在隔离环境验证，再按项目既定流程部署；仓库不会自动 SSH 或更新部署机。

## 资源与超时

四份 Compose 入口均透传 `.env.example` 中的新变量：

| 变量 | 默认值 | 含义 |
| --- | ---: | --- |
| DATABASE_POOL_MAX | 12 | 每个 API/Worker 进程的连接数上限，副本数增加时需计算总量 |
| DATABASE_CONNECTION_TIMEOUT_MS | 5000 | 连接建立及池等待预算 |
| DATABASE_IDLE_TIMEOUT_MS | 30000 | 空闲连接回收 |
| DATABASE_STATEMENT_TIMEOUT_MS | 30000 | 普通 SQL 服务端执行预算 |
| DATABASE_LOCK_TIMEOUT_MS | 5000 | 锁等待预算 |
| DATABASE_IDLE_TRANSACTION_TIMEOUT_MS | 30000 | 空闲事务预算 |
| REDIS_CONNECT_TIMEOUT_MS | 1000 | Redis 连接预算 |
| REDIS_COMMAND_TIMEOUT_MS | 1000 | API 单次 Redis 操作的总预算，包含连接 |
| WORKER_REDIS_COMMAND_TIMEOUT_MS | 5000 | Worker 普通 Redis 命令预算；阻塞读取使用独立连接和 15 秒预算 |
| WORKER_CONCURRENCY | 2 | 同时消费任务数，允许 1–16，仍受模型容量限制 |
| WORKER_STORAGE_TIMEOUT_MS | 60000 | Worker 单次存储传输预算，与 Provider 失租取消信号合并 |

迁移使用专用会话，关闭普通语句/空闲事务时限并使用已有迁移锁预算；结束后销毁该会话，避免宽松预算泄漏到应用连接。生产阈值应按慢查询、连接等待和资源数据调整，不应直接扩大连接池。

API 配置 revision 最多每 5 秒检查一次；Worker 设置最多缓存 5 秒。同进程写入立即失效，并发刷新共享请求；失效前启动的读取不能重新填入旧快照。列表签名使用请求内配置与 S3 客户端，不跨请求共享签名 URL。因此跨实例配置变更最长约 5 秒可见，进行凭据轮换时需保留相应重叠窗口。

OTP 保留原来的“邮箱+IP”5 次/600 秒预算，同时增加邮箱 5 次/600 秒、IP 30 次/600 秒预算。Redis 故障及时退回进程内限流；多副本降级预算是按实例计算的。

## 队列、租约与自动恢复

Outbox 使用单条 SQL 原子认领 100 条，保存随机 token 和 120 秒租约；Redis 网络调用在数据库事务之外。确认和失败释放均检查 token，崩溃后可回收过期认领。数据库提交与 Redis 发布仍属于至少一次投递：网络或进程故障可能重投，不能移除下游幂等、状态 CAS 和模型容量控制。

Provider 60 秒租约每 20 秒续期；过期租约不能复活。任务状态写入同时检查 revision、token 和有效期。失租中止活动 HTTP/S3 请求，旧所有者不得继续更新状态或删除替代所有者可能使用的确定性对象。

派发、轮询和取消调度与对象清理、插件刷新分开运行。清理查询每类最多 50 行，使用 15 秒软预算；单资产原图/预览/封面作为一个删除组处理，最多三个 10 秒请求，可能超过软预算。逐项进度落库，后续扫描继续；账户完成还需等待已软删资产的未完成删除任务。对象删除不可通过代码回滚恢复。

长驻 Compose 服务使用 `restart: unless-stopped`，一次性迁移/种子服务不循环重启。Worker 在本机 `127.0.0.1:3010/health` 提供探针，要求消费者和短周期调度都有进展；持续失去进展约 3 分钟会退出，由重启策略恢复。Docker 的 unhealthy 标记本身不会触发重启，主动退出是恢复的一部分。仅容器内部可访问该端口，无新增公网端口。

## 历史保留与删除边界

- `STREAM_RETENTION_SECONDS=604800`：默认保留 7 天；设为 `0` 可在部署前禁用自动删除。
- `STREAM_TRIM_BATCH_SIZE=1000`：每 30 秒最多删除 1000 条。
- Lua 原子检查消费组：只有唯一且名称为 `workers` 的受管组才允许清理；存在额外组或未知组时停止清理。
- 删除边界同时小于保留时间、最早 pending ID、最后读取 ID；因此 pending、未读和较新的消息不会被删。保留最早 pending 之前的边界可能让历史保留更久，不能用无条件 MAXLEN 替代。
- Stream 删除不可直接撤销，禁用策略只能停止后续删除；需要重放旧消息时应事先采用符合部署机规范的备份/归档。逻辑删除后 Redis 内存块和 AOF 的物理回收还受内部块布局与 AOF rewrite 影响。
- PostgreSQL Outbox 不自动删除。`scripts/outbox-retention-report.sql` 只读统计历史与活跃认领；可选清理工具默认 dry-run，只有显式 `--execute` 才处理已派发、无租约的过期记录。执行前须完成部署机备份/归档，不得删除待派发记录。

## 迁移与回滚

| 迁移 | 内容 | 回滚 |
| --- | --- | --- |
| 0035 | Outbox 认领 token/expiry 列，默认 NULL，无历史回填 | 停止新 Worker 并回退其代码后，删除两个新增列；事件历史保留 |
| 0036 | 有效资产 `(created_by,created_at DESC,id DESC)` 部分索引 | `DROP INDEX CONCURRENTLY` |
| 0037 | 未派发 Outbox `created_at` 部分索引 | `DROP INDEX CONCURRENTLY` |
| 0038 | 移除冗余 model/revision 排序索引，保留唯一约束索引 | `CREATE INDEX CONCURRENTLY` 重建旧索引 |
| 0039 | 移除冗余 job/attempt 排序索引，保留唯一约束索引 | `CREATE INDEX CONCURRENTLY` 重建旧索引 |

Up 文件位于 `packages/database/migrations/`，Down 文件单独位于 `packages/database/rollback/`，不会被自动扫描。并发索引文件每份一条 DDL，必须在事务块之外执行，不能给整套回滚加单一 BEGIN。按相反编号回滚；移除 0035 列之前必须停新 Worker。保留迁移历史用于审计，重新上线已回滚的 schema 应新增前向修复迁移，不修改历史校验和。

迁移器检查并发索引的 `indisvalid/indisready`。失败遗留 INVALID 索引时会停止，不能靠 `IF NOT EXISTS` 跳过；操作人员核对索引名和定义后，在事务之外 `DROP INDEX CONCURRENTLY IF EXISTS <准确索引名>`，再重跑尚未记录的迁移。并发建索引避免阻塞普通写入，但仍有目录锁、等待与额外 I/O，应监控负载和剩余磁盘。

## 验证与测量

`tests/integration/backend-reliability-pg.test.ts` 只接受显式 loopback、`fixture` 角色、`postgres` 管理库入口；每次创建并删除带随机后缀的独占数据库。不会使用继承的 `DATABASE_URL`/`REDIS_URL` 建立连接，不读取 `.env`。真实迁移、事务失败回滚、双派发器认领、过期租约隔离、微秒分页、唯一索引反向扫描均有回归。

本地 PostgreSQL 17.11 合成基准：10 万资产、100 个用户，另有 20 万 Outbox 历史；每项取三次暖缓存执行时间的中位数。一次完整复测记录如下，属于数据库查询执行时间而非 API 或生产性能承诺：

| 查询 | 修改前 | 修改后 | 计划变化 |
| --- | ---: | ---: | --- |
| 用户资产前 51 条 | 13.188ms | 0.066ms | 顺序扫描/排序 → 所有者复合索引扫描 |
| 未派发事件前 100 条 | 52.132ms | 0.063ms | 顺序扫描/排序 → 待派发部分索引扫描 |

完整计划和 buffer 数据写入 `.runtime/backend-benchmark.json`，CI 的 `synthetic-backend-query-plans` artifact 保留当次结果。测量会随机器、数据分布和缓存变化；生产上线前仍须用代表性参数复测 P50/P95、连接等待、队列积压和写入开销。

`backend-reliability.yml` 使用独立 PostgreSQL 17/Redis 7.4 服务验证真实 Lua 保留边界、数据库并发和所有 Compose 入口；普通本地测试缺少显式 fixture URL 时跳过这些服务用例。此 CI 不部署应用，也不代表部署环境验收完成。
