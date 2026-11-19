# 剩余推荐项实施计划与记录

日期：2026-11-18。用户在旧 CanvasAgent 退役后授权“其余按照你的推荐完成”。本轮以 `recommendations.md` 的 R-01–R-07 为范围，不重复旧运行时删除；保留用户原有及并行修改。基线为 `dev` / `308ccca`，开始时记录 136 项工作区文件 hash、完整补丁及未跟踪源文件备份。

采用 Plan & Execute；四个只读 Scout 分别核查测试、基础设施、清理/内容图和 Stream/准入，主 Agent 统一修改与验证，最后独立审查。历史检索 CLI `nmem` 当前不可从 PATH 取得，本轮依据仓库文档和实际代码；没有把检索不可用写成没有历史。

## 执行步骤及验收

| 步骤 | 内容 | 验收 | 状态 |
|---|---|---|---|
| 1 | 固定范围、备份、并行核查调用及依赖 | 起始 patch/hash 已保留，实际失败已重现 | 完成 |
| 2 | R-01 Web TS loader；R-02 Docker workspace manifest | Web 单测、安装层结构正反例通过 | 完成 |
| 3 | R-03 隔离 Agent CI fixture 与防空跑入口 | 缺 URL/skip/缺 TAP 必失败；无服务本地单元通过 | 配置与单元完成；真实 CI 待执行 |
| 4 | R-04 持久领取；R-05 停写/收敛/策略阻塞 | 原子领取、旧 token 禁写、预算让出及取消/完成保护 | 本地代码/单元完成；真实 PG 与最终擦除政策待确认 |
| 5 | R-06 两个 Agent Stream 安全保留 | 默认关闭；保护 pending、未读、年轻、未知 group，批次有界 | 本地实现与单元完成；真实 Redis 未执行 |
| 6 | R-07 可信 session/turn 准备授权、actor admission、Compose 透传 | 契约先行，授权矩阵与现有工作排空回归 | 本地实现、契约及授权回归完成 |
| 7 | 独立审查、全仓检查、审计状态更新 | 定向与全仓验证，实际未执行项清晰记录 | 本地完成；目标环境验收未执行 |

## 政策与操作边界

- 新工作继续受 namespace、admission 和 actor rollout 控制；Compose 只增加可选透传，默认不开启。
- Stream 保留窗口未定，默认 0/关闭，配置明确窗口后才允许受保护修剪；不猜生产保留期限。
- 新 Agent 消息、快照、私有定义、准备记录与账本尚缺完整保留/擦除政策。本轮先实现取消收敛和显式政策阻塞，阻止账户清理假完成；不通过关闭触发器、删共享定义、无条件 cascade 或猜测审计期限实现擦除。
- 不运行真实数据迁移/删除、PG/Redis 服务、容器、Provider 或远端部署。不提交或推送。追加迁移是可审阅代码，不代表已应用。
- R-05 的最终内容擦除、真实 fixture CI/镜像构建及目标环境验收，在证据具备前不标记完成。

## 已验证记录

- 当前侧栏生命周期回归已由并行工作修复并实际通过，未重复修改组件/断言。
- Web 测试命令加入 `--import tsx`、显式 `tsx` 开发依赖并离线同步 lockfile；附件和 Canvas form 的 workspace TS 加载错误消失，Web 测试退出 0。
- Web Dockerfile 补齐 observability manifest；三镜像的 install 输入结构检查通过。检查器覆盖缺直接/传递依赖、COPY 太晚/目的路径错误、未知 workspace、别名及模糊 COPY 语法。
- 最终 `pnpm test:tooling`：17 通过、0 失败、0 跳过。严格 fixture runner 缺 URL 时退出非零；缺 plan、重复/矛盾统计、非安全整数、失败/bailout、错误顶层用例与任意 skip 均不能假成功。补充了真实 Node TAP 子测试协议的无服务正例与 nested-skip 反例。
- 新独立 Agent fixture CI 配置已写入，尚未推送或触发。五个专用 fixture 为 runtime、recovery、media terminal、cleanup 和 streams，限定 loopback 隔离目标；本地明确清空专用 URL 后加载为 0 pass / 5 skip，不计作集成断言通过。缺 cleanup URL 的严格入口实际退出 1。

## 实施要点

### R-04 / R-05：领取与内容收敛

追加 `0046_cleanup_claim_leases.sql`，为两个 cleanup 队列加入 claim token、lease expiry、next attempt 和 blocked 状态，保留历史迁移。`CleanupJobRepository` 使用数据库时钟原子领取、续租、退避，并在短事务的进度和完成写入前后校验 token/租约。对象存储调用在事务外，具有有界中止信号；外部删除仍须幂等。

Worker 启动预检要求 0046 的八个字段。部署必须先停旧 cleanup Worker，再应用迁移和启动新版本；旧二进制不遵守 fencing，不能滚动混跑。本轮未在真实数据库执行该迁移。

管理员删除用户只持久化 generation 取消意图；Worker 同时写入 Agent 取消和去重 wake，按 Session-before-Turn 顺序处理。仍有 turn/lease、保留或 unknown 预算、Provider operation、输出导入、未派发媒体完成、未到期输入或待删对象时继续等待。新 Agent session、私有 definition、准备身份、legacy links 和受保护引用会显式政策阻塞，防止设置虚假完成标记；未执行最终内容擦除或更改共享系统 definition。

### R-06：保守 Stream 保留

两个 Agent streams 使用相同的显式 opt-in 配置，四份 Compose 默认 `false/0/0`，既有 generation retention 原语义不变。Lua 用 Redis 时钟和十进制字符串 ID 比较，在一个原子执行中保护 pending、未读、年轻和未知 group。先以非 FULL stream 元数据检查 group 数，只在唯一 group 时取详情；扩展 XPENDING 最多取一个最早 pending，扫描/删除由 batch 限制；零游标直接返回无可删记录。

generation 与 Agent 维护分别捕获错误。Worker loopback `/metrics` 暴露固定 kind/reason 标签的删除、失败、跳过及 length/pending/最早 pending 条目年龄；未知 gauge 不写零，也不把删除条数当内存回收量。真实 Redis fixture 分别令 pending、大序号精度、未读、年轻和批次边界主导一次调用，并断言确切剩余 ID 与 pending payload 可重领；实际执行仍待 CI。

### R-07：准备授权与兼容

先增加 `PrepareAgentImageEditRequest` 和根 OpenAPI 的 session/turn 字段，再修改 API/Web。旧客户端无上下文和 session-only 请求都按新工作执行 actor admission；turn-only 为 400。只有属于活动 owner、未归档会话的当前非终态且未取消、未超期 turn，才可在暂停新 admission 时继续准备；不存在或跨 owner 等上下文在暂存前统一为 404。精确图片准备路径在 namespace 关闭时也于认证前返回 404。

Web 使用共享请求派生类型传 multipart 上下文。session/turn 只授权本次 staging，不把不可变准备身份伪装为持久 turn 绑定；最终 message、附件 provenance/expiry 和执行前校验仍有效。共享暂存写入在短事务中锁定活动 owner，防止删除提交后新增/提升输入和准备身份；对象 I/O 与补偿不持有该锁。

四份 Compose 可选透传 namespace、readiness、actor percent/allowlist，默认关闭。白名单仍不能绕过 readiness；Worker recovery/settlement 不增加这些 gate。

## 独立审查与修复

- 清理租约、取消持久化、政策阻塞与 fixture 由独立 Reviewer 审查：无问题，保留旧 Worker 停机和真实 PG 验证边界。
- 准备授权、owner 锁顺序与 Web/契约由另一 Reviewer 审查：无问题，最终结论为 OK with notes。
- CI/Stream Reviewer 首轮提出六项问题：元数据无界扫描、保护边界被 fixture 批次掩盖、generation 异常阻断 Agent、零游标、TAP 缺 plan/重复统计、Docker 最终 WORKDIR 与 ignore 触发路径。四组 tooling 反例先实际复现失败，再修正；同一 Reviewer 复核六项均已修复，结论为 OK with notes。

## 最终本地验证（2026-11-18）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0；保留原有非阻断 warnings，不声称零 warning |
| `pnpm -r --no-bail --if-present test` | exit 0；1,652 pass / 0 fail / 0 skip |
| `pnpm test:tooling` | exit 0；17 pass / 0 fail / 0 skip |
| `pnpm build` | exit 0；不替代 Docker/目标环境验证 |
| `pnpm check:docker-manifests` | 三份应用镜像输入检查通过；不是实际镜像构建 |
| `pnpm install --lockfile-only --offline --frozen-lockfile` | exit 0；未执行线上安装 |
| `git diff --check` | exit 0 |

全仓测试分项：Observability 5、Contracts 68、Domain 33、Database 319、Providers 241、Media Service 28、Web 185、Worker 310、API 463，全部通过且无跳过。tooling 为额外的 17 项，不混入上述包测试计数。

最终源代码验证记录在本机临时目录 `C:/Users/judej/AppData/Local/Temp/musecanvas-recommendations-reviewed-93frihbt/` 的 `status.json`、`test-summary.json` 和各命令日志；tooling 新增协议正反例的最终 17 项结果另见临时文件 `musecanvas-review-tooling-final.log`。首次全仓 1,650 项通过后因审查修复新增两项 Worker 测试，已完整复跑，未把不同快照的数量混用。

起始 patch/hash 与未跟踪源文件备份仍保留。局部编辑共同业务文件，另识别并保留并行 Web 的错误提示和测试 loader 更新；未 reset/stash/checkout、提交、推送或部署。无真实数据库/Redis、容器、Provider、迁移或内容删除执行。

## 尚未完成的发布门槛

1. 真正执行隔离 CI PG/Redis fixtures，验证并发领取/过期重领/回滚、真实 Lua 保留和恢复；本地 skip 不替代它们。
2. 干净上下文 API/Web/Worker/Nginx 镜像构建及合成 Compose config 验证；后续按已确认环境另行授权部署与烟雾测试。
3. 决定 Agent 内容、私有定义、准备记录、ledger/audit 与 legacy 引用的保留/擦除政策，以及 Stream 保留窗口。本轮只实现显式阻塞与默认关闭，不擅自填生产值。
4. 应用 0046 前停旧 cleanup Worker；固定镜像 digest、确认 schema 与回滚方案后才发布。没有自动提交、推送、迁移或开启生产 admission。
