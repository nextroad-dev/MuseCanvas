# Seedream API 接入文档

> 适用项目：MuseCanvas / AI 做图台  
> 更新时间：2026-06-21  
> Provider：ByteDance Seed / 火山方舟 / BytePlus ModelArk  
> 推荐定位：中文海报、商业视觉、多参考图编辑、组图生成、国内稳定接入

---

## 1. 模型概览

Seedream 是字节 Seed 团队的图像生成与编辑模型系列，适合：

- 中文提示词生图
- 中文海报 / 图文排版
- 商业主视觉 KV
- 多参考图一致性生成
- 图片编辑
- 组图 / 连续图生成
- 高分辨率输出

常见模型版本：

```txt
doubao-seedream-4-0-250828
doubao-seedream-4-5-251128
seedream-5-0-lite
```

> 实际模型名请以火山方舟或 BytePlus 控制台为准。模型版本迭代很快，名字也很像人类给文件起的“最终版_final_真的最终版”。

---

## 2. 官方文档

| 文档 | 地址 |
|---|---|
| 火山方舟图片生成 API | https://www.volcengine.com/docs/82379/1541523?lang=zh |
| BytePlus Image Generation API | https://docs.byteplus.com/api/docs/ModelArk/1541523 |
| Seedream 4.0 / 5.0 Tutorial | https://docs.byteplus.com/en/docs/ModelArk/1824121 |
| Seedream Streaming Response | https://docs.byteplus.com/en/docs/ModelArk/1824137 |
| BytePlus Base URL / Auth | https://docs.byteplus.com/en/docs/ModelArk/1298459 |
| Seedream 4.0 产品介绍 | https://seed.bytedance.com/en/seedream4_0 |
| Seedream 4.5 产品介绍 | https://seed.bytedance.com/en/seedream4_5 |
| Seedream 5.0 Lite 产品介绍 | https://seed.bytedance.com/en/seedream5_0_lite |

---

## 3. 国内版与海外版差异

| 平台 | Base URL | 适用场景 |
|---|---|---|
| 火山方舟国内版 | `https://ark.cn-beijing.volces.com` | 国内账号、国内用户、低延迟 |
| BytePlus 海外版 | `https://ark.ap-southeast.bytepluses.com` | 海外账号、海外业务、新加坡等区域 |

---

## 4. 鉴权方式

```http
Authorization: Bearer $ARK_API_KEY
Content-Type: application/json
```

环境变量建议：

```bash
ARK_API_KEY=xxxx
ARK_BASE_URL=https://ark.cn-beijing.volces.com
```

或海外版：

```bash
ARK_API_KEY=xxxx
ARK_BASE_URL=https://ark.ap-southeast.bytepluses.com
```

---

## 5. 文生图接口

### 国内火山方舟 Endpoint

```http
POST https://ark.cn-beijing.volces.com/api/v3/images/generations
```

### 海外 BytePlus Endpoint

```http
POST https://ark.ap-southeast.bytepluses.com/api/v3/images/generations
```

---

## 6. 文生图请求示例

### curl 示例：国内版

```bash
curl -X POST "https://ark.cn-beijing.volces.com/api/v3/images/generations" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -d '{
    "model": "doubao-seedream-4-5-251128",
    "prompt": "高级感 AI 做图台产品宣传图，深色玻璃拟态界面，中文标题 MuseCanvas，适合官网 Hero 区域",
    "size": "2K",
    "response_format": "url",
    "watermark": false,
    "stream": false
  }'
```

### curl 示例：海外版

```bash
curl -X POST "https://ark.ap-southeast.bytepluses.com/api/v3/images/generations" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -d '{
    "model": "doubao-seedream-4-5-251128",
    "prompt": "A premium AI image studio hero visual, dark glassmorphism interface, title MuseCanvas, suitable for a SaaS landing page",
    "size": "2K",
    "response_format": "url",
    "watermark": false,
    "stream": false
  }'
```

---

## 7. 图生图 / 多参考图

Seedream 通常通过同一个 `/api/v3/images/generations` 接口处理图像编辑或参考图生成。

核心字段：

```json
{
  "image": "https://example.com/input.png"
}
```

或多图：

```json
{
  "image": [
    "https://example.com/ref-1.png",
    "https://example.com/ref-2.png"
  ]
}
```

图片可以是：

- 可访问 URL
- Base64 图片数据

---

## 8. 多参考图示例

```bash
curl -X POST "https://ark.cn-beijing.volces.com/api/v3/images/generations" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -d '{
    "model": "doubao-seedream-4-5-251128",
    "prompt": "参考这些图片，生成一张统一风格的产品主视觉，保留界面高级感，强化品牌一致性",
    "image": [
      "https://example.com/ref-1.png",
      "https://example.com/ref-2.png"
    ],
    "size": "2K",
    "response_format": "url",
    "watermark": false,
    "stream": false
  }'
```

---

## 9. 组图 / 连续图生成

Seedream 支持 sequential image generation，用于一次生成多张连续风格图片。

### 请求示例

```json
{
  "model": "doubao-seedream-4-5-251128",
  "prompt": "生成一组 4 张 MuseCanvas 产品宣传图，保持同一视觉风格，分别展示：首页、画布、历史记录、模型选择",
  "size": "2K",
  "sequential_image_generation": "auto",
  "sequential_image_generation_options": {
    "max_images": 4
  },
  "response_format": "url",
  "watermark": false,
  "stream": false
}
```

---

## 10. 流式输出

Seedream 支持流式输出，适合：

- 前端展示生成进度
- 低等待感交互
- 大图或多图任务

基础字段：

```json
{
  "stream": true
}
```

前端建议通过后端 SSE 转发，而不是让浏览器直接连方舟 API。

---

## 11. 常用参数

| 参数 | 类型 | 说明 |
|---|---:|---|
| `model` | string | 模型名称，例如 `doubao-seedream-4-5-251128` |
| `prompt` | string | 提示词 |
| `image` | string / array | 输入图，可为 URL 或 Base64 |
| `size` | string | 输出尺寸，例如 `2K`、`4K` 或具体宽高 |
| `response_format` | string | 常用 `url` |
| `watermark` | boolean | 是否加水印 |
| `stream` | boolean | 是否开启流式输出 |
| `sequential_image_generation` | string | 是否启用组图生成 |
| `sequential_image_generation_options.max_images` | number | 组图最大图片数 |
| `output_format` | string | 输出格式，例如 `png`，以官方文档为准 |

---

## 12. 返回格式

Seedream 常见返回为图片 URL。

示意结构：

```json
{
  "data": [
    {
      "url": "https://..."
    }
  ]
}
```

> 注意：图片 URL 通常有有效期，建议后端拿到 URL 后立即转存到自己的对象存储，例如 S3 / R2 / OSS。

推荐处理流程：

1. 后端调用 Seedream API
2. 获取临时图片 URL
3. 后端下载图片
4. 上传到自有对象存储
5. 将永久 URL 写入数据库
6. 返回给前端

---

## 13. Node.js fetch 示例

```ts
type SeedreamGenerateInput = {
  prompt: string;
  model?: string;
  image?: string | string[];
  size?: string;
  stream?: boolean;
};

export async function generateWithSeedream(input: SeedreamGenerateInput) {
  const baseURL = process.env.ARK_BASE_URL ?? "https://ark.cn-beijing.volces.com";
  const apiKey = process.env.ARK_API_KEY;

  if (!apiKey) {
    throw new Error("Missing ARK_API_KEY");
  }

  const response = await fetch(`${baseURL}/api/v3/images/generations`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model ?? "doubao-seedream-4-5-251128",
      prompt: input.prompt,
      image: input.image,
      size: input.size ?? "2K",
      response_format: "url",
      watermark: false,
      stream: input.stream ?? false,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Seedream API error: ${response.status} ${errorText}`);
  }

  return response.json();
}
```

---

## 14. MuseCanvas 后端封装建议

### 请求类型

```ts
export type SeedreamModel =
  | "doubao-seedream-4-0-250828"
  | "doubao-seedream-4-5-251128"
  | "seedream-5-0-lite";

export interface SeedreamGenerateParams {
  prompt: string;
  model?: SeedreamModel | string;
  image?: string | string[];
  size?: string;
  responseFormat?: "url" | "b64_json";
  watermark?: boolean;
  stream?: boolean;
  sequentialImageGeneration?: "auto" | "disabled";
  maxImages?: number;
}
```

### 统一返回类型

```ts
export interface SeedreamImageAsset {
  provider: "seedream";
  model: string;
  url?: string;
  b64?: string;
  expiresAt?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  raw?: unknown;
}
```

---

## 15. OpenAI 与 Seedream 的统一 Provider 抽象

建议在 MuseCanvas 中统一抽象为：

```ts
export type ImageProvider = "openai" | "seedream";

export interface GenerateImageRequest {
  provider: ImageProvider;
  model: string;
  prompt: string;
  images?: string[];
  size?: string;
  quality?: "low" | "medium" | "high" | "auto";
  outputFormat?: "png" | "jpeg" | "webp";
  count?: number;
  stream?: boolean;
  watermark?: boolean;
}

export interface GenerateImageResponse {
  provider: ImageProvider;
  model: string;
  images: Array<{
    url?: string;
    b64?: string;
    mimeType?: string;
    expiresAt?: string;
  }>;
  raw?: unknown;
}
```

---

## 16. MuseCanvas 接入定位

Seedream 建议作为 MuseCanvas 的中文和商业视觉主力模型：

| 场景 | 是否推荐 |
|---|---:|
| 中文海报 | 强烈推荐 |
| 商业主视觉 | 推荐 |
| 多参考图一致性 | 推荐 |
| 组图生成 | 推荐 |
| 国内用户访问 | 推荐 |
| 普通文本生图 | 推荐 |
| 复杂英文语义 | 可用，但建议和 OpenAI 对比 |
| 私有化部署 | 不适合 |
| 极细粒度蒙版编辑 | 不一定最优 |

---

## 17. 任务表设计建议

```sql
CREATE TABLE image_generation_tasks (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  input_assets JSONB,
  params JSONB,
  status TEXT NOT NULL,
  result_assets JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 18. 错误处理建议

| 错误类型 | 处理 |
|---|---|
| 鉴权失败 | 检查 `ARK_API_KEY`、账号权限、模型授权 |
| 模型不存在 | 从控制台确认模型名 |
| 图片 URL 不可访问 | 后端先上传参考图到对象存储并生成可访问 URL |
| 图片过大 | 压缩或限制上传尺寸 |
| 内容安全拦截 | 返回友好提示 |
| URL 过期 | 后端立即转存 |
| 流式中断 | 支持任务重试或标记失败 |
| 额度不足 | 对租户做额度提示 |

---

## 19. 前端表单建议

MVP 暴露参数：

- 提示词
- 模型版本
- 尺寸：`2K` / `4K`
- 参考图上传
- 是否组图
- 组图数量
- 是否加水印
- 生成按钮

高级参数折叠：

- 流式输出
- 输出格式
- 多图模式
- 风格模板
- 参考强度

---

## 20. MVP 推荐配置

```ts
export const SEEDREAM_DEFAULTS = {
  provider: "seedream",
  model: "doubao-seedream-4-5-251128",
  size: "2K",
  responseFormat: "url",
  watermark: false,
  stream: false,
};
```

---

## 21. 接入检查清单

- [ ] 后端读取 `ARK_API_KEY`
- [ ] 支持国内 / 海外 Base URL 配置
- [ ] 禁止前端直连 Seedream API
- [ ] 支持文生图
- [ ] 支持图生图
- [ ] 支持多参考图
- [ ] 支持组图生成
- [ ] 支持临时 URL 转存对象存储
- [ ] 支持租户额度扣减
- [ ] 支持用户并发限制
- [ ] 支持错误信息脱敏
- [ ] 模型名从配置读取，不要硬编码死在业务逻辑里
- [ ] 保存 raw response 便于排查，但不要暴露给普通用户
