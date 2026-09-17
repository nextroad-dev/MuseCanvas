# Web

Vue 3 前端应用。页面按 `user` 与 `admin` 路由域组织，共享组件放在
`components`，服务端通信统一放在 `services`，Pinia 状态放在 `stores`。

---

## 设计基线（Jude-Frontweb）

全站采用暖白 Soft Product 风格：暖白画布、白底承载面、墨色主操作、绿色仅作为强调色。
设计 token 的唯一来源是 `src/assets/index.css` 的 `@theme` 块，任何原始色值、默认调色板、
原始圆角、装饰性渐变/毛玻璃都会被守卫脚本拒绝。

### 颜色 token 的角色分工

| token | 值 | 角色与硬约束 |
| --- | --- | --- |
| `--color-canvas` | `#F7F7F3` | 页面底色 |
| `--color-surface` | `#FFFFFF` | 承载面、编辑区、独立对象 |
| `--color-surface-subtle` | `#EFEFE9` | 次操作底色、局部强调、表头 |
| `--color-surface-subtle-strong` | `#E4E4DC` | 按压态（press） |
| `--color-foreground` | `#1A1A18` | 正文与主操作 |
| `--color-muted-foreground` | `#666660` | 唯一可用于说明/元数据的次级文字 |
| `--color-border` | `#E5E5DD` | 装饰性分割（不承担控件辨识） |
| `--color-border-strong` | `#C9C9C0` | 强调分割线 |
| `--color-border-control` | `#85857E` | 输入/下拉/上传区等依赖轮廓辨识的边界（≥3:1） |
| `--color-primary` / `-hover` / `-active` | `#1A1A18` / `#33322E` / `#0C0C0B` | 主按钮实底、统一焦点环 |
| `--color-accent` | `#168A49` | 绿色图形/图标/进度（≥3:1；不得用于 14px 文字） |
| `--color-accent-strong` | `#0D6133` | 绿色文字、链接、激活导航、选中标签（≥4.5:1） |
| `--color-accent-soft` | `#E7F6EC` | 选中态底色（导航激活、Pill 选中、Switch 开启） |
| `--color-credit` | `#8A5100` | 积分图标与积分文字 |
| `--color-success` / `-soft` | `#166534` / `#F0FDF4` | 成功 |
| `--color-warning` / `-soft` | `#854D0E` / `#FEFCE8` | 警告 |
| `--color-danger` / `-hover` / `-active` / `-soft` / `-border` | `#B91C1C` / `#991B1B` / `#7F1D1D` / `#FEF2F2` / `#FECACA` | 错误与危险 |
| `--color-info` / `-soft` | `#1E40AF` / `#EFF6FF` | 信息 |
| `--color-neutral-status` / `--color-neutral-soft` | `#57534E` / `#E9E9E1` | 中性状态 |
| `--color-positive` / `--color-negative` | `#166534` / `#B91C1C` | 积分账变增减 |
| `--color-overlay` | `#1A1A18` | 媒体遮罩、Dialog scrim |

使用规则：主操作 → `primary`；选中/激活/进度/生成中 → `accent*`；中性 hover →
`surface-subtle`；按压 → `surface-subtle-strong`；积分 → `credit`；语义状态 →
`success/warning/danger/info` 及其 `*-soft` 底色。

### 排版

- 字体自托管：`IBM Plex Sans` / `IBM Plex Mono` / `Noto Sans SC`（仅 400、500 两档），
  由 `@fontsource/*` 在 `src/app/main.ts` 中导入，页面不加载任何外部字体，CSP 保持
  `font-src 'self' data:`；字体包内含 `font-display: swap`，字体缺失时回退系统无衬线且正文保持可见。
- 正文 16px / 行高 1.59 / 字重 400；标题 400；按钮、标签、表头等强调为 500（不使用 semibold/bold）。
- 字号 token：`text-display`（营销 hero）、`text-title`（页面标题）、`text-section`（分区标题）、
  `text-subtitle`（Dialog / 卡片标题）；正文 `text-base`，紧凑控件与标签 `text-sm`，辅助说明 `text-xs`。
- 紧字距 (`tracking-[-0.0175em]`) 仅用于营销 Display 标题，不污染正文。
- 连续数值使用 `tabular-nums`；ID、时间戳、密钥、JSON、模型 ID 使用 `font-mono`。

### 形状、阴影、动效、焦点

- 圆角：`--radius-control`(10px) / `--radius-popover`(12px) / `--radius-card`(14px) /
  `--radius-panel`(18px) / `--radius-pill`。组件只能使用 `rounded-[var(--radius-*)]` 或 `rounded-full`。
- 阴影：卡片与面板一律边框无阴影；`--shadow-md` 仅给下拉/Tooltip，`--shadow-lg` 仅给
  Dialog/Drawer/Toast/Lightbox，不提供更大的阴影档位。
- 动效：`--motion-fast` 120ms / `--motion-base` 180ms / `--motion-slow` 240ms +
  `--ease-standard`；禁止全属性过渡，禁止 hover/active 缩放与hover位移，
  浮层只用透明度与 ≤4px 位移。`prefers-reduced-motion` 下动画与过渡静态化，状态完全由静态形状与文字表达。
- 焦点：`index.css` 的 base 层统一 `:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px }`，
  组件内不得再定义 `focus:ring-*`；校验错误仅保留 `border-danger`。
- 控件高度：默认 40px（`min-h-10`），紧凑 32px（`min-h-8`），营销 CTA 48px（`min-h-12`），
  图标按钮 40px，且不使用重叠透明层扩大命中区。

### 守卫规则

`scripts/check-design-tokens.mjs`（`pnpm --filter @musecanvas/web lint:tokens`，也随 `pnpm lint` 运行）：

- 颜色：禁止 Tailwind 默认调色板、黑/白工具类、十六进制与 `rgb()` 字面量；
  `@theme` 只能出现在 `src/assets/index.css`；每个颜色 token 必须有消费者（no-dead-token）。
- 圆角：只允许 `rounded-[var(--radius-*)]`（可带方向前缀）与 `rounded-full`。
- 动效与装饰：禁止全属性过渡（transition 的 all 变体）、交互态缩放、装饰性渐变、
  毛玻璃模糊，以及大于 lg 档的阴影。
- 排版：禁止小于 12px 的任意字号与 semibold / bold 字重。
- 无障碍：`.vue` 中原生 HTML 元素的 `title` 属性被禁止（可访问名称用 `aria-label`，
  说明性提示用 `AppTooltip`）；组件 prop 形式的 `title`（如 `<PageHeader title>`）不受影响。

### 字体产物说明

CJK 字体按 `unicode-range` 分片，`dist` 会包含 Noto Sans SC 400/500 的全部子集
（woff2 + woff），体积增加约 14MB（实测 `dist` 约 15MB，其中字体约 14MB）；浏览器只按需下载命中的分片，因此实际传输量远小于产物体积。
删除 `src/app/main.ts` 中的 `@fontsource/noto-sans-sc/*` 导入即可回到系统 CJK 字体回退。