# GPT-IMAGE-2 API 接入文档

> 适用项目：MuseCanvas / AI 做图台  
> 更新时间：2026-06-21  
> Provider：OpenAI  
> 推荐定位：通用高质量生图、自然语言编辑、多轮图像工作流

---

## 1. 模型概览

`gpt-image-2` 是 OpenAI 最新一代 GPT Image 系列模型，可用于：

- 文本生成图像
- 图像编辑
- 多参考图编辑
- 流式图像生成
- 对话式图像工作流
- 高质量真实感、产品图、海报、信息图生成

官方推荐：

- 简单单次生成 / 编辑：使用 **Images API**
- 多轮对话式生成 / 修改：使用 **Responses API + image_generation 工具**

---

## 2. 官方文档

| 文档 | 地址 |
|---|---|
| Image Generation Guide | https://developers.openai.com/api/docs/guides/image-generation |
| Create Image API Reference | https://developers.openai.com/api/reference/resources/images/methods/generate/ |
| Images API Reference | https://developers.openai.com/api/reference/resources/images |
| ChatGPT Images 2.0 发布介绍 | https://openai.com/index/introducing-chatgpt-images-2-0/ |

> 注意：OpenAI 文档有时存在不同页面同步不一致的问题。实际接入时，以最新 API Reference 和控制台可用模型为准。

---

## 3. 鉴权方式

```http
Authorization: Bearer $OPENAI_API_KEY
Content-Type: application/json
```

环境变量建议：

```bash
OPENAI_API_KEY=sk-xxxx
```

生产环境中不要把 API Key 暴露给前端。应由后端代理调用 OpenAI API。

---

## 4. 文生图接口

### Endpoint

```http
POST https://api.openai.com/v1/images/generations
```

### 最小请求示例

```bash
curl -X POST "https://api.openai.com/v1/images/generations" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "一张高级感的 AI 做图台产品宣传图，深色界面，玻璃拟态，中文标题 MuseCanvas",
    "size": "1536x1024",
    "quality": "medium",
    "output_format": "png",
    "n": 1
  }'
```

### Node.js SDK 示例

```ts
import OpenAI from "openai";
import fs from "node:fs";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const result = await client.images.generate({
  model: "gpt-image-2",
  prompt: "一张适合作为 SaaS 首页 Hero 的 AI 生图平台宣传图，深色背景，高级科技感",
  size: "1536x1024",
  quality: "medium",
  output_format: "png",
  n: 1,
});

const b64 = result.data?.[0]?.b64_json;

if (!b64) {
  throw new Error("No image returned");
}

fs.writeFileSync("output.png", Buffer.from(b64, "base64"));
```

---

## 5. 图像编辑接口

### Endpoint

```http
POST https://api.openai.com/v1/images/edits
```

### 请求格式

图像编辑接口使用 `multipart/form-data`。

### 单图编辑示例

```bash
curl -X POST "https://api.openai.com/v1/images/edits" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -F "model=gpt-image-2" \
  -F "image[]=@input.png" \
  -F "prompt=把这张图改成更高级的产品官网主视觉，保留主体，背景换成深色玻璃拟态工作台" \
  -F "size=1536x1024"
```

### 多参考图编辑示例

```bash
curl -X POST "https://api.openai.com/v1/images/edits" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -F "model=gpt-image-2" \
  -F "image[]=@ref-1.png" \
  -F "image[]=@ref-2.png" \
  -F "prompt=参考这些图片，生成一张统一风格的 MuseCanvas 产品宣传图，保留品牌调性和界面高级感" \
  -F "size=1536x1024"
```

### Node.js 编辑示例

```ts
import OpenAI from "openai";
import fs from "node:fs";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const result = await client.images.edit({
  model: "gpt-image-2",
  image: [
    fs.createReadStream("ref-1.png"),
    fs.createReadStream("ref-2.png"),
  ],
  prompt: "参考这些图片，生成统一风格的 AI 做图台宣传图",
  size: "1536x1024",
});

const b64 = result.data?.[0]?.b64_json;

if (!b64) {
  throw new Error("No image returned");
}

fs.writeFileSync("edited.png", Buffer.from(b64, "base64"));
```

---

## 6. 常用参数

| 参数 | 类型 | 说明 |
|---|---:|---|
| `model` | string | 模型名，使用 `gpt-image-2` |
| `prompt` | string | 文本提示词 |
| `size` | string | 图像尺寸 |
| `quality` | string | `low` / `medium` / `high` / `auto` |
| `output_format` | string | `png` / `jpeg` / `webp` |
| `output_compression` | number | JPEG/WebP 压缩率，0-100 |
| `n` | number | 生成数量，通常 1-10 |
| `stream` | boolean | 是否开启流式生成 |
| `partial_images` | number | 流式模式下返回的中间图数量 |
| `moderation` | string | `auto` / `low` |
| `background` | string | 背景参数，但 `gpt-image-2` 当前不适合依赖透明背景能力 |

---

## 7. 尺寸建议

常用尺寸：

```txt
1024x1024
1536x1024
1024x1536
```

适合做图台预设：

| 场景 | 推荐尺寸 |
|---|---|
| 方图 / 社交头像 | `1024x1024` |
| 横版官网 Hero | `1536x1024` |
| 竖版海报 / 手机壁纸 | `1024x1536` |
| 自定义画布 | 使用后端校验宽高合法性 |

建议在后端统一限制：

- 宽高必须为正整数
- 宽高尽量为 16 的倍数
- 避免过大尺寸直接暴露给普通用户
- 根据用户套餐控制最大输出尺寸

---

## 8. 返回格式

GPT Image 模型通常返回 base64 数据：

```json
{
  "data": [
    {
      "b64_json": "..."
    }
  ]
}
```

后端建议处理流程：

1. 接收 OpenAI 返回的 base64
2. 转换为图片文件
3. 上传到对象存储，例如 S3 / R2 / OSS
4. 存储任务记录和图片 URL
5. 返回前端可访问的图片地址

不要让前端长期持有 base64，否则页面内存会很难看。前端工程已经够像垃圾场了，别再往里倒建筑废料。

---

## 9. 后端封装建议

### TypeScript 请求类型

```ts
export type OpenAIImageQuality = "low" | "medium" | "high" | "auto";
export type OpenAIImageFormat = "png" | "jpeg" | "webp";

export interface OpenAIImageGenerateParams {
  prompt: string;
  size?: string;
  quality?: OpenAIImageQuality;
  outputFormat?: OpenAIImageFormat;
  outputCompression?: number;
  n?: number;
  stream?: boolean;
}

export interface OpenAIImageEditParams {
  prompt: string;
  images: Array<Buffer | string>;
  mask?: Buffer | string;
  size?: string;
  quality?: OpenAIImageQuality;
  outputFormat?: OpenAIImageFormat;
}
```

### 统一返回结构

```ts
export interface GeneratedImageAsset {
  provider: "openai";
  model: "gpt-image-2";
  url?: string;
  b64?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  raw?: unknown;
}
```

---

## 10. MuseCanvas 接入定位

OpenAI GPT-IMAGE-2 建议作为 MuseCanvas 的主力通用模型：

| 场景 | 是否推荐 |
|---|---:|
| 普通文本生图 | 推荐 |
| 对话式修改图片 | 推荐 |
| 多参考图融合 | 推荐 |
| 产品主视觉 | 推荐 |
| 写实摄影 | 推荐 |
| 中文海报文字 | 可用，但建议和 Seedream / Qwen / Ideogram 对比 |
| 批量低价生图 | 不一定最优 |
| 本地部署 | 不支持 |

---

## 11. 任务表设计建议

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

推荐状态：

```txt
pending
running
succeeded
failed
canceled
```

---

## 12. 错误处理建议

常见错误类型：

| 类型 | 处理 |
|---|---|
| 鉴权失败 | 检查 API Key、额度、组织权限 |
| 参数错误 | 后端校验 size、quality、format |
| 内容安全拦截 | 返回用户友好的提示，不暴露原始安全细节 |
| 超时 | 后端任务异步化，前端轮询或 SSE |
| 返回空图 | 标记失败并记录 raw response |
| base64 解码失败 | 记录任务失败，保留原始响应摘要 |

---

## 13. 前端表单建议

不建议第一版暴露太多参数。MVP 可以只给：

- 提示词
- 比例 / 尺寸
- 质量
- 生成数量
- 参考图上传
- 是否作为编辑任务

高级参数折叠到“高级设置”里。

---

## 14. MVP 推荐配置

```ts
export const OPENAI_GPT_IMAGE_2_DEFAULTS = {
  provider: "openai",
  model: "gpt-image-2",
  size: "1536x1024",
  quality: "medium",
  outputFormat: "png",
  n: 1,
};
```

---

## 15. 接入检查清单

- [ ] 后端读取 `OPENAI_API_KEY`
- [ ] 禁止前端直接调用 OpenAI
- [ ] 支持文生图
- [ ] 支持图像编辑
- [ ] 支持多参考图
- [ ] base64 转文件并上传对象存储
- [ ] 任务状态入库
- [ ] 错误信息脱敏
- [ ] 租户级额度扣减
- [ ] 用户级并发限制
- [ ] 日志中不要记录完整 API Key
- [ ] 大图生成走异步任务
