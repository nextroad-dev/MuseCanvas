import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ShowcaseWork {
  file: string
  /** 画幅（仅用于 aspect-ratio 布局与默认文案，不再渲染给用户看）。 */
  ratio: string
  label: string
  grow: number
  width: number
  height: number
}

/** 5 件作品：文件名、画幅与展示尺寸的唯一真源（落地页作品条 + 登录页拼图共用）。 */
export const SHOWCASE_WORKS: ShowcaseWork[] = [
  { file: 'ratio-3x4.webp', ratio: '3 / 4', label: '3:4', grow: 0.75, width: 900, height: 1200 },
  { file: 'ratio-16x9.webp', ratio: '16 / 9', label: '16:9', grow: 1.78, width: 1600, height: 900 },
  { file: 'ratio-1x1.webp', ratio: '1 / 1', label: '1:1', grow: 1, width: 1200, height: 1200 },
  { file: 'ratio-9x16.webp', ratio: '9 / 16', label: '9:16', grow: 0.5625, width: 900, height: 1600 },
  { file: 'ratio-4x3.webp', ratio: '4 / 3', label: '4:3', grow: 1.33, width: 1600, height: 1200 },
]

function showcaseDir() {
  return join(process.cwd(), 'public', 'showcase')
}

/** showcase.json 里该文件的提示词；缺失时回退默认文案，不报错。 */
export function showcasePrompt(file: string, label: string): string {
  try {
    const data = JSON.parse(readFileSync(join(showcaseDir(), 'showcase.json'), 'utf8')) as Record<
      string,
      unknown
    >
    const prompt = data[file]
    if (typeof prompt === 'string' && prompt.trim().length > 0) return prompt.trim()
  } catch {
    // 素材未补齐：落到默认文案，不报错
  }
  return `作品示例 · ${label}`
}

/** 文件存在时返回 `/showcase/<file>`，否则 null（调用方渲染占位）。 */
export function showcaseSrc(file: string): string | null {
  try {
    if (existsSync(join(showcaseDir(), file))) return `/showcase/${file}`
  } catch {
    // 同上：占位渲染
  }
  return null
}
