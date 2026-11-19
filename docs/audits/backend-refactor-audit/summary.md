# MuseCanvas 后端重构审计总结

## 结论

共享 `media-service`、Outbox、独立事件通道、Provider registry 与 Worker 恢复/维护边界继续保留。用户明确要求移除旧 CanvasAgent，并授权完成其余推荐；当前工作区已完成旧代码/公开入口退役及 R-01–R-07 的本地实施、回归和独立复核。新 Agent Core、普通 Canvas CRUD、共享媒体能力、历史迁移与数据保留，旧会话不自动迁移。

最新全仓 1,652 项测试和额外 17 项工具测试通过，typecheck/lint/build 退出 0。真实 PG/Redis、干净镜像构建、迁移和部署均未执行；最终 Agent 内容擦除仍受政策阻塞。本地实现完成不等于生产或端到端验收完成。

## 后端架构健康状况

- **较健康/有清晰边界**：API 集中 route table 和 pipeline；domain/contracts 明确；media-service 是共享媒体命令；Worker 的 Outbox dispatch、generation/Agent consumers、恢复和 Provider 插件执行入口有独立职责；插件代码由 Worker 承载，不在 API 执行。
- **退役边界**：旧 CanvasAgent 专属代码与公开路由已按用户指令移除；历史表、legacy links 和账户清理责任保留。新 Core 使用的摘要语义已独立迁出并以兼容向量保护。
- **需进一步验证**：生产 DB migration/schema、Redis 运行数据和保留策略、Agent rollout 配置、外部运维任务与客户端流量没有在本地静态审计中确认。

## 已确认并清理

1. `packages/providers/package.json` 的无用直接 S3 SDK 依赖。API/Worker 使用方仍分别声明 SDK，未删除其运行依赖。
2. `apps/web/package.json` 的无用 Noto Serif 字体依赖，保留仍使用的 Noto Sans/IBM Plex。
3. `apps/api/src/modules/admin/plugin-catalog.ts` 中无调用 `isCatalogPluginActive` wrapper；实际调用方直接使用 `resolveCatalogPlugin` 并需要完整 manifest。

清理文件范围和定向验证见 `cleanup.md`。两份 package manifest 与同一份 `pnpm-lock.yaml` 由 pnpm 同步更新；`.gitignore` 只对本次审计目录增加跟踪例外，使审计与后续实施文档可被 Git 跟踪。

## 原风险处理与剩余验收

1. **账户删除**：已持久化取消意图，等待 turn/预算/Provider/输出/对象收敛；新 Agent 内容与受保护引用显式政策阻塞，不再仅凭旧 Canvas 清理设置完成。最终内容擦除政策仍待确定。
2. **Docker 输入**：Web 缺失 manifest 已补齐；结构检查覆盖安装时最终 WORKDIR、依赖闭包和反例，`.dockerignore` 改动也触发镜像 CI。实际 clean-context 构建未执行。
3. **部署准入**：四套 Compose 已可选透传 namespace/readiness/actor rollout，默认关闭。未修改目标环境，Worker 恢复/结算不随 API 准入关闭。
4. **Stream 保留**：已增加原子、默认关闭且查询/删除有界的安全修剪与指标；保护 pending、未读、年轻及未知 group，generation 失败不阻断 Agent 维护。真实 Redis 与保留窗口仍待验证/确定。
5. **Cleanup 租约**：追加 0046，原子领取、数据库时钟、token fencing、退避和 Worker schema 预检完成。新旧 cleanup 二进制不能混跑，部署前须停旧 Worker。
6. **Agent CI**：五套隔离 PG/Redis fixture、路径过滤和严格防空跑 runner 已配置；缺 URL/skip/缺 plan/重复统计会失败。CI 未推送或触发，本地 5 skip 不计集成验证。
7. **准备授权**：共享 session/turn 契约、actor admission、可信活跃轮次证明和 Web multipart 已同步。旧无上下文请求按新工作准入，已受理工作可在 admission 暂停时继续，最终 message/provenance 仍重验。
8. **OpenAPI**：本轮加强准备字段、配对约束及 DTO 校验；全 API 的完整 schema gate 仍是渐进工作。

完整文件/符号/置信度/证据在 `findings.md`。

## 当前工作区验证状态

修订后的完整复跑：Observability 5、Contracts 68、Domain 33、Database 319、Providers 241、Media Service 28、Web 185、Worker 310、API 463，共 1,652 pass / 0 fail / 0 skip；额外 tooling 17 项通过。`pnpm typecheck`、`pnpm lint`、`pnpm build`、离线 frozen-lockfile 与 diff 检查全部退出 0；保留原有非阻断 warnings。

清理租约和准备授权独立审查无问题；CI/Stream 首轮六项具体发现均修复并由同一 Reviewer 复核通过。五套真实 fixture 本地仅无服务加载/skip，未执行运行时断言。工作区原有及并行 Web 改动保持；没有提交、推送、迁移或部署。最新证据见 `implementation.md`、`validation.md`，原失败计数保留为历史快照。

## 后续优先级建议

1. 在隔离 CI 实际执行 PG/Redis fixture 与镜像构建，区分本地 mock/结构校验和真实环境证据。
2. 确定 Agent 用户内容、私有定义、准备记录、ledger/audit 和 legacy 引用的保留/擦除政策，以及 Stream 保留窗口。
3. 经另行授权，在确认的目标环境先停旧 cleanup Worker、应用 0046、固定镜像 digest 后部署，并验证健康、准入/排空和故障恢复。
4. 不自动转换旧会话、不清除历史表和数据、不把本地代码退役误称为生产流量/存量已排空。

## 最终验收边界

已完成静态架构审计、低风险清理、授权的旧 CanvasAgent 代码退役、R-01–R-07 本地实施、独立复核及全仓验证。最终内容擦除、真实 PG/Redis/镜像与目标环境验收尚未完成；不得描述为生产已发布、数据已擦除或端到端全部验收通过。