// 落地页作品条数据：5 件作品的画幅/布局元信息 + `public/showcase/showcase.json`
// 的提示词。作品素材由构建期 import 保证存在；JSON 不可用时提示词回落占位文案。

import showcasePrompts from '../../../public/showcase/showcase.json'

export interface ShowcaseItem {
  /** `public/showcase/` 下的文件名。 */
  file: string
  /** 浏览器可用地址。 */
  src: string
  /** CSS aspect-ratio 值，如 `3 / 4`。 */
  ratio: string
  label: string
  /** flex-grow 权重，落地页作品条用。 */
  grow: number
  width: number
  height: number
  prompt: string
}

interface ShowcaseWork {
  file: string
  ratio: string
  label: string
  grow: number
  width: number
  height: number
}

const SHOWCASE_WORKS: ShowcaseWork[] = [
  { file: 'ratio-3x4.webp', ratio: '3 / 4', label: '3:4', grow: 0.75, width: 900, height: 1200 },
  { file: 'ratio-16x9.webp', ratio: '16 / 9', label: '16:9', grow: 1.78, width: 1600, height: 900 },
  { file: 'ratio-1x1.webp', ratio: '1 / 1', label: '1:1', grow: 1, width: 1200, height: 1200 },
  { file: 'ratio-9x16.webp', ratio: '9 / 16', label: '9:16', grow: 0.5625, width: 900, height: 1600 },
  { file: 'ratio-4x3.webp', ratio: '4 / 3', label: '4:3', grow: 1.33, width: 1600, height: 1200 },
]

const promptMap: Record<string, string> =
  typeof showcasePrompts === 'object' && showcasePrompts !== null
    ? (showcasePrompts as Record<string, string>)
    : {}

/** showcase.json 中该文件的提示词；缺失时回退默认文案，不报错。 */
export function showcasePrompt(file: string, label: string): string {
  const prompt = promptMap[file]
  return typeof prompt === 'string' && prompt.trim().length > 0 ? prompt.trim() : `作品示例 · ${label}`
}

/** 文件存在时返回 `/showcase/<file>`，否则 null（调用方渲染占位）。 */
export function showcaseSrc(file: string): string | null {
  if (!file) return null
  return `/showcase/${file}`
}

/** 5 件作品的展示数据；JSON 缺失/损坏时仍保留占位卡片。 */
export const SHOWCASE_ITEMS: ShowcaseItem[] = SHOWCASE_WORKS.map((work) => ({
  ...work,
  src: `/showcase/${work.file}`,
  prompt: showcasePrompt(work.file, work.label),
}))
