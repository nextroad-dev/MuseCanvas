# 清理记录

- `.gitignore`：仅新增 `docs/audits/backend-refactor-audit/*.md` 的例外，使本次要求的审计报告可被 Git 跟踪；其它 `docs/*` 忽略策略未变。

## 清理原则与范围

仅修改有完整调用链证据、可逆、且与公共 API/持久化结构无关的冗余。没有触碰用户原有未提交修改（包含前后端、contracts、数据库 Repository、OpenAPI、测试）；未删除 migration、route、兼容脚本、Redis stream 或生产配置。

## 批次 1：移除包级未使用依赖

**文件**

- `packages/providers/package.json`：移除 `@aws-sdk/client-s3`。Providers 源码没有此 SDK 的 imports；实际 S3 client 使用在 `apps/api/src/shared/storage/s3-driver.ts`、`apps/api/src/shared/services.ts`、`apps/worker/src/shared/storage.ts`，应用各自声明依赖。
- `apps/web/package.json`：移除 `@fontsource/noto-serif-sc`。Web 源码没有该字体导入；layout 使用 IBM Plex / Noto Sans 等其他字体，不影响它们。
- `pnpm-lock.yaml`：由 pnpm 同步删掉两个 importer 条目及对应 package/snapshot 锁定条目；API/Worker 的 S3 SDK lock 条目保留。

**影响**：减少两个 workspace 的无用直接依赖；不改运行时代码或 browser/API contract。

**验证**：

- `pnpm --filter @musecanvas/providers typecheck`：通过。
- `pnpm --filter @musecanvas/providers lint`：退出 0，43 warnings，无 errors。
- `pnpm --filter @musecanvas/providers exec node --import tsx --test "src/**/*.test.ts"`：241/241 通过。
- Web 依赖移除前后源码检索均无 Noto Serif 使用；最终串行全仓 typecheck/build 通过，Web 测试仍有两项当前工作区失败。完整现状见 `validation.md`。

## 批次 2：删除无调用 wrapper

**文件**：`apps/api/src/modules/admin/plugin-catalog.ts`

删除 `isCatalogPluginActive(pluginId, pluginVersion)` 三行导出。全仓精确符号搜索、API route registry、模块 imports、tests/scripts/CI、barrel 与动态加载路径均未发现调用。其实现仅包装 `resolveCatalogPlugin(...) !== null`，而实际调用方需要 catalog/manifest 数据，直接使用 `resolveCatalogPlugin`。未删除有效 sibling。

**影响**：移除一个不可达的内部 helper，不改变 HTTP/OpenAPI/持久化或 plugin admission 行为。

**验证**：

- `rg -n "isCatalogPluginActive" apps packages scripts tests .github`：无引用。
- `pnpm --filter @musecanvas/api typecheck`：通过。
- `pnpm --filter @musecanvas/api lint`：退出 0，87 warnings，无 errors。
- `pnpm --filter @musecanvas/api exec node --import tsx --test "src/**/*.test.ts"`：515/515 通过。
- `pnpm --filter @musecanvas/api build`：曾单独通过（Next static pages 与 API catch-all route 均完成）。

## 明确未执行的候选清理

- 未移除 `manifestContainsSecrets`：尽管生产链无引用，其安全测试当前依赖它，直接删会降低断言。
- 未删除旧 Canvas Agent、共享 media-service、API/worker adapter、migration/rollback、运维脚本和 alias。审计证据显示仍有公开入口、部署用途、数据/兼容承诺或调用链。
- 未修复用户删除时的新 Agent 数据处理、Agent streams retention、Worker cleanup lease 等风险；分别需数据保留、重放与多副本策略评审。
- 未修改 `prepareAgentImageEdit` 的 admission policy；产品尚未确认准备操作是否应受 actor rollout gate 限制。
- 未改任何当前用户已有 Web/Agent/contract/OpenAPI/database 代码。

## Diff 归属

代码清理仅限上述三份 dependency/lockfile 与 API plugin catalog helper 的差异。`docs/audits/backend-refactor-audit/` 是本任务新建报告。仓库其他既存差异属于调用本任务前已存在且审计中继续存在的用户工作区内容；请通过 `git diff` / `git status` 按路径核对，不要把它们视为本次清理。
