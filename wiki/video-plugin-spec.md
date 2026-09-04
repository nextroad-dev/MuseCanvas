# 媒体插件开发规范 (Media Plugin Development Spec)

状态:已生效 · 约束对象:`packages/providers/src/plugins/*` 下所有媒体插件 · 依据:当前仓库代码与 `tests/integration/media-provider-contract.test.ts` 契约

---

## 1. 目标与范围

MuseCanvas 的媒体生成走统一的 **media provider 内核 + 静态插件** 架构。图像与视频插件均由 `apps/worker` 消费,必须遵守本规范;违反契约门禁(`media-provider-contract.test.ts`)的 PR 不予合入。

参考实现:异步视频生命周期优先看 **`veo-video` > `seedance-video`**;同步图像生命周期看 `openai-image` / `seedream-image` 的当前版本。

### 1.1 非目标

- 不覆盖 API 层的凭据管理界面与模型配置流程。

---

## 2. 内核契约 (Kernel Contract)

内核位于 `packages/providers/src/core/`,插件只允许通过注入的 `ExecutionContext` 访问外部世界。

### 2.1 插件接口 `MediaProviderPlugin`

```ts
interface MediaProviderPlugin {
  readonly manifest: MediaProviderManifest
  probe?(config, context): Promise<ProbeResult>            // 可选:凭据连通性测试
  validateConfig(config): void | Promise<void>             // 必须:配置校验,抛 NormalizedProviderError
  validateRequest(request, config): void | Promise<void>   // 必须:请求边界校验,早于任何网络调用
  submit(request, config, context): Promise<OperationResult>
  poll?(remoteId, opaqueState, config, context): Promise<OperationResult>   // 异步任务必须实现
  cancel?(remoteId, opaqueState, config, context): Promise<OperationResult> // 用户取消路径必须实现
  openOutput?(descriptor, config, context): Promise<BoundedOutput>          // 输出字节获取路径
}
```

### 2.2 Manifest 硬要求

| 字段 | 要求 |
|------|------|
| `id` / `version` | registry 按 `id@version` 精确注册/查找,`plugins/index.ts` 幂等注册。破坏性行为升级版本并保留已被修订引用的旧键;当前视频键为 `1.0.0`,图像活动键为 `1.1.0` 且保留 `1.0.0` |
| `modalities` | 图像插件为 `['image']`,视频插件为 `['video']` |
| `allowedHosts` | **白名单语义**:出站 HTTP 的每个目标主机都必须命中;支持精确主机与 `*.` 前缀通配(匹配子域) |
| `credentialSchemas` | 声明支持的凭据 schema(如 `legacy-api-key-v1`、`json-v1`、`access-token-v1`) |
| `models` | 列出受支持 `vendorModelId`、可选 `maxBatchSize` / `maxInputImages`;活动版本的 `validateRequest` 必须拒绝清单外的模型 |

### 2.3 网络出口:`SafeHttpClient`(唯一出口)

- 插件 **禁止** 使用 `globalThis.fetch` / 任何未注入的 HTTP 通道;一律经 `context.http`(或 `context.readOutput`)。
- 强制约束:仅 `https:`(错误消息必须包含 "https");主机必须命中 `allowedHosts`(消息含 "allowed hosts");手动跟随重定向且每一跳重新校验,上限 5 跳;响应体按 `maxBytes` 截断检查(含 `content-length` 预检)。
- `ExecutionContext.readOutput(descriptor, { maxBytes, timeoutMs, allowedHosts? })` 支持本次调用追加主机白名单,内核与插件自身白名单取并集。

### 2.4 超时

所有出站调用必须显式传 `timeoutMs`:交互路径建议 `config.timeoutMs ?? 15_000`(probe),任务路径用 `config.timeoutMs`。不允许无超时的网络调用。

---

## 3. 生命周期与状态机

视频生成是长任务,插件必须完整映射异步内核状态:

```
submit → waiting / submission_unknown / succeeded(同步) / failed
poll   → waiting(含 retryAfterMs) / succeeded(outputs) / failed / canceled
cancel → canceled / waiting(仍在收尾)
```

图像插件为同步生命周期:`submit → succeeded(outputs) / failed`,不实现 `poll` / `cancel`。为避免无幂等保证时重复生成/计费,worker 仅对明确的 HTTP 429 以新 run 有界重试;超时、传输错误、5xx 及“已进入 submitting 但无 remoteId”的重投递均终态失败。确定性 4xx 返回 `failed/PROVIDER_REJECTED`。

### 3.1 `OperationResult.status` 语义(worker 侧后果)

| status | worker 行为 | 插件使用条件 |
|--------|------------|--------------|
| `waiting` | 按 `retryAfterMs` 调度下一次 `poll` | 任务仍在远端执行;瞬时网络错误后的可重试等待 |
| `submission_unknown` | 稍后重新驱动提交 | 提交时遇到瞬时错误(如 429/5xx),**远端未确认受理**;无 `remoteId` |
| `succeeded` | 进入输出摄取 | 必须携带非空 `outputs` |
| `failed` | **终态、不可重试、任务失败** | 仅用于确定性失败:4xx 拒绝、内容安全过滤、空结果、任务终态失败 |
| `canceled` | 释放容量、任务取消 | `cancel()` 确认或 404(任务已不存在) |

**异步远端任务规则:瞬时错误绝不映射为 `failed`。** `NormalizedProviderError.fromHttp` 已把 429/5xx 分类为 `PROVIDER_TEMPORARY_ERROR`(可重试)、其余为 `PROVIDER_REJECTED`(终态);视频插件据此分流。同步图像提交遵守上一节的更保守重试策略。

### 3.2 轮询节奏

- 返回 `retryAfterMs` 表达轮询间隔;尊重供应商 `Retry-After` 响应头并设上限(参考 `seedance-video` 的 `MAX_RETRY_AFTER_MS = 30_000`)。
- worker 会将 `retryAfterMs` 收敛到 `[1s, 600s]`;插件无需自实现退避循环或 `sleep`。

### 3.3 幂等

提交可重试时,若供应商支持,必须携带幂等键(参考 `seedance-video` 的 `x-client-request-id`)。异步任务可用 `submission_unknown` 重新驱动;同步图像供应商当前无可靠幂等键,worker 因此只重试明确的 429,不重试结果未知的超时/传输/5xx。

---

## 4. 输出契约

### 4.1 `OutputDescriptor` 判别式

- `url` 与 `b64Json` **二选一**(XOR),不允许同时存在或同时缺失。
- `index` 必须稠密、从 0 递增。
- `mimeType` 必填;视频一律 `video/*`;活动图像插件仅接受 `image/png` / `image/jpeg`。
- **`url` 必须是 `https:`**。供应商返回 `gs://`、签名 URL 等非直接可下载定位符时,插件在 `poll` 内完成映射,不得把原始定位符直接作为 `url` 输出(参考 `veo-video`:`mapGcsUriToHttps` 显式配置优先,回退规范形式 `https://storage.googleapis.com/<bucket>/<object>`)。

### 4.2 `openOutput`

- 下载前再次校验 `https:` 与主机白名单;拒绝与 `manifest.modalities` 不符的 mimeType。活动图像插件的鉴权请求只能访问官方端点主机;输出 CDN 仅允许无鉴权下载。
- 下载走 `context.readOutput`,继承 `maxBytes` 与超时。`maxBytes` 必须是正安全整数且不超过 100 MB;base64 在解码分配前预检预计字节数。
- 若 `poll` 已把定位符映射为 https,此处的防御校验仍必须保留(输出字节路径是安全边界)。活动图像插件还必须校验 PNG/JPEG 声明 MIME 与实际格式、完整容器尾、单页属性和解码器元数据,并强制完整像素解码;仅解析文件头不算有效输出。

### 4.3 尺寸与时长

- 成功视频结果尽量携带 `durationSeconds`(优先取供应商返回值,回退 `opaqueState` 中记录的请求值)。
- 活动图像插件从解码后的输出取得并强制提供 `width` / `height`:单边不超过 8000 px、总像素不超过 2500 万、宽高比不超过 16:1;通用 `readBoundedOutput` 仍只做尽力解析。

---

## 5. 安全边界(红线)

### 5.1 opaqueState 卫生

`opaqueState` 会被加密后持久化,但仍按“可能泄漏”对待:

- 只允许 JSON 安全的**标识符**:taskId / operationName / model / 请求参数回显。
- **禁止**:token、apiKey、私钥、签名参数、任何 `https?://` URL、`signature=` / `sig=` 片段。
- 契约测试 `assertOpaqueHygiene` 会扫描这些模式,违反即失败。

### 5.2 错误脱敏

- 供应商报文进入 `detail` 前必须经 `sanitizeProviderDetail`(内核自动):剥离 `Bearer` token、`sk-` 密钥与长随机串,截断 1200 字符。
- 插件自定义 `detail` 中同样不得内联凭据(如 SA JWT 的私钥)。

### 5.3 凭据

- 只从 `ProviderConfig`/`credential` 读取;**禁止** 读 `process.env` 或环境默认凭据(参考 `veo-video` `resolveAccessToken` 的注释约束)。
- 需要短期 token 的供应商(如 Vertex AI):实现服务账号 JWT 铸造 —— `RS256` 签名断言 → token endpoint(`https://oauth2.googleapis.com/token`)换取 `access_token`,模块级缓存、提前 60s 过期;token endpoint 主机必须进 `allowedHosts`。
- `probe` 必须先自校验配置:非法配置抛 `NormalizedProviderError`;配置有效后的连通性/鉴权失败返回 `{ healthy: false, message }`,不得触发生成请求。

### 5.4 日志

worker 侧已有 `redactForLog`;插件自身日志同样禁止打印请求体原文、Authorization 头、输出 URL。

---

## 6. 错误模型

统一使用 `NormalizedProviderError.create(pluginId, version, code, detail, extra?)`,code 取自内核联合类型:

| code | 语义 | 典型场景 |
|------|------|----------|
| `PROVIDER_NOT_CONFIGURED` | 缺凭据/配置 | `validateConfig` 缺 apiKey |
| `INVALID_CREDENTIAL` | 凭据内容错误 | SA 字段缺失、token 铸造失败 |
| `INVALID_CONFIG` | 配置非法 | 非白名单 `baseUrl`、缺 projectId |
| `INVALID_REQUEST` | 请求越界 | 非法时长/比例/分辨率、空 prompt |
| `PROVIDER_REJECTED` | 供应商确定性拒绝(终态) | 400/401/403、内容安全过滤 |
| `PROVIDER_TEMPORARY_ERROR` | 瞬时(可重试) | 429/5xx、传输错误 |
| `PROVIDER_TIMEOUT` | 超时 | 内核自动 |
| `PROVIDER_EMPTY_RESULT` | 空结果 | 成功响应但无视频 |
| `UNSAFE_URL` | 越界输出定位符 | 非 https、白名单外主机、裸 `gs://` |
| `OUTPUT_READ_FAILED` | 输出下载/超限/不可解码 | 超过 `maxBytes`、容器截断、像素解码失败 |

worker 侧 `classifySubmitError` 仍统一规范化错误;异步视频按瞬时分类进入 `submission_unknown` / `waiting`,同步图像仅在诊断明确为 HTTP 429 时创建新 run 重试,其余结果未知错误终态失败。**新插件不得发明联合类型之外的 code。**

### 6.1 边界异常的 message 约定

传输边界错误使用 `SafeHttpError`(`NormalizedProviderError` 子类,`message = "CODE: detail"`),以满足契约对消息文本的断言:

| 场景 | detail 必须匹配 |
|------|----------------|
| 非 `https:` 协议 | `/https/i`(现有文案含 "only HTTPS is permitted") |
| 主机白名单拒绝 | `/allowlist\|allowed\|host/i`(现有文案含 "allowed hosts") |
| 重定向上限 | `/redirect/i` |
| 体积超限 | `/exceed/i` |

插件层抛出的校验错误仍保持 code-only message(worker 有 `err.message === 'CODE'` 的严格比较)。

---

## 7. 参数校验(视频特有)

`validateRequest` 必须在任何网络调用前完成全量校验,`submit` 不允许发送未校验值:

- 模型白名单、非空 prompt、prompt 长度上限;
- `durationSeconds` / `fps` / `seed` / `count`(批量上限,如 `maxBatchSize`) 的枚举或范围;
- 宽高比枚举(如 `16:9`、`9:16`)与分辨率枚举(如 `720p`/`1080p`/`4k`)及组合约束(参考 `veo-video` 的 1080p/4k 仅限标准模型 + 8s);
- 输入图:数量上限、mimeType 仅 `image/png|jpeg`、单张大小上限(参考 20MB)、非空校验;
- 供应商扩展控制(如 `seedance-video` 的 `extractVideoControls`)采用**白名单转发**:只转发显式校验过的字段,未知 `extra` 键一律丢弃。

### 7.1 图像输入特有约束

- `openai-image@1.1.0` / `seedream-image@1.1.0` 在网络调用前校验模型、prompt、size、quality、count 与输入图。
- 输入图统一调用 `core/image-input.ts`:PNG/JPEG 字节签名、单张 10MB、总计 20MB、最多 4 张、边长 `[32,6000]`、最大宽高比 `16:1`。
- 图像输出必须满足 `url` / `b64Json` XOR、HTTPS URL 与 PNG/JPEG MIME;活动版 `openOutput` 必须再次检查 MIME、尺寸/像素边界并完成真实解码。

---

## 8. 测试门禁

新插件必须同时满足两层测试(全部无网络、无凭据、全 mock):

1. **单测** `src/plugins/<plugin>/<plugin>.test.ts`:
   - manifest 快照(版本、modality、白名单、模型清单);
   - `validateRequest` 全边界(非法模型/时长/比例/分辨率/超限输入图);
   - `submit` 精确端点 + 请求体 + 认证头;视频瞬时错误映射 `submission_unknown`,同步图像规范化异常中仅明确 HTTP 429 可供 worker 有界重试;确定性 4xx 返回 `failed/PROVIDER_REJECTED`;
   - 视频 `poll` 状态映射:运行中→`waiting`、成功→判别式输出、任务失败→`failed`、瞬时错误→可重试、安全过滤→`failed`;
   - 视频 `cancel` 成功/404 语义;所有插件 `openOutput` 的 https、白名单与 MIME 拒绝;活动图像额外覆盖截断容器、伪造 MIME、超尺寸/像素和完整解码。
   - 若实现服务账号铸造:覆盖 mint 路径(断言 `Bearer` 头与 token 端点调用)与缓存复用(两次调用仅一次 token 交换)。
2. **契约集成** `tests/integration/media-provider-contract.test.ts`(只增不删):
   - registry 精确键 `<id>@<version>`;活动图像键为 `1.1.0`,历史图像键与当前视频键为 `1.0.0`;
   - manifest 声明(白名单、模型、schema);
   - Safe HTTP 边界(明文协议/白名单外主机/重定向上限/体积上限);
   - 图像同步提交或视频异步生命周期夹具 + `assertOpaqueHygiene` + `assertDiscriminatedOutputs`(https-only URL 输出)。

运行方式:

```bash
corepack pnpm --filter @musecanvas/providers typecheck
corepack pnpm --filter @musecanvas/providers test
corepack pnpm --filter @musecanvas/providers exec tsx --test ../../tests/integration/media-provider-contract.test.ts
```

---

## 9. 新插件接入清单

1. `src/plugins/<id>/index.ts`:`manifest` + `class XxxPlugin implements MediaProviderPlugin`,导出常量 `<ID>_PLUGIN_ID`/`<ID>_PLUGIN_VERSION`。
2. `src/plugins/index.ts`:注册进 `globalProviderRegistry`(幂等)并 `export *`。
3. 按第 8 节补齐两层测试。
4. 模型配置侧:`model_config_revisions` 以 `(plugin_id, plugin_version)` 精确锁定插件;模型注册/修订流程引用该键,破坏性插件变更必须升 `version` 并保留旧版本插件。
5. 提交前本地跑通第 8 节三条命令;CI(`media-quality.yml`)执行同一门禁。

---

## 10. 变更记录

| 日期 | 内容 |
|------|------|
| 2026-09-04 | 初版:固化内核契约、状态机语义、安全红线与测试门禁;吸收 Veo SA 令牌铸造、GCS→HTTPS 映射、Seedance 瞬时错误非终态化三项实现的既定事实 |
| 2026-09-04 | 图像模型切换到与 Veo 共用的静态插件内核:`openai-image@1.1.0` / `seedream-image@1.1.0`;保留历史 `1.0.0` 精确键,统一输入图与输出安全契约 |
