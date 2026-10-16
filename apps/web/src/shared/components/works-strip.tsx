import Image from 'next/image'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ContentFrame } from '@/shared/components/content-frame'

interface ShowcaseWork {
  file: string
  ratio: string
  label: string
  grow: number
  width: number
  height: number
}

/**
 * 作品条：5 种画幅等高不等宽（flex 比例 + aspect-ratio）。
 * 素材由仓库所有者后补（plan §7.1）：`public/showcase/` 与 `showcase.json`
 * 缺失时渲染 `bg-tonal` 占位块，构建与渲染都不报错。
 */
const WORKS: ShowcaseWork[] = [
  { file: 'ratio-3x4.webp', ratio: '3 / 4', label: '3:4', grow: 0.75, width: 900, height: 1200 },
  { file: 'ratio-16x9.webp', ratio: '16 / 9', label: '16:9', grow: 1.78, width: 1600, height: 900 },
  { file: 'ratio-1x1.webp', ratio: '1 / 1', label: '1:1', grow: 1, width: 1200, height: 1200 },
  { file: 'ratio-9x16.webp', ratio: '9 / 16', label: '9:16', grow: 0.5625, width: 900, height: 1600 },
  { file: 'ratio-4x3.webp', ratio: '4 / 3', label: '4:3', grow: 1.33, width: 1600, height: 1200 },
]

function showcaseDir() {
  return join(process.cwd(), 'public', 'showcase')
}

function resolvePrompt(file: string, label: string): string {
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

function resolveSrc(file: string): string | null {
  try {
    if (existsSync(join(showcaseDir(), file))) return `/showcase/${file}`
  } catch {
    // 同上：占位渲染
  }
  return null
}

/** 落地页作品条（server component：无 Query、无 store，保持 `force-static`）。 */
export function WorksStrip() {
  return (
    <section id="works" aria-labelledby="works-title" className="scroll-mt-16">
      <ContentFrame className="pb-4">
        <h2 id="works-title" className="sr-only">
          作品示例
        </h2>
        <div className="overflow-x-auto pb-2">
          <ul className="flex min-w-[1080px] items-start gap-4">
            {WORKS.map((work) => {
              const src = resolveSrc(work.file)
              const prompt = resolvePrompt(work.file, work.label)
              return (
                <li
                  key={work.file}
                  style={{ flex: `${work.grow} 1 0%` }}
                  className="flex min-w-0 flex-col"
                >
                  <figure className="m-0 flex min-w-0 flex-col gap-2.5">
                    <div
                      style={{ aspectRatio: work.ratio }}
                      className="relative flex items-center justify-center overflow-hidden rounded-card bg-tonal"
                    >
                      {src ? (
                        <Image
                          src={src}
                          alt={prompt}
                          width={work.width}
                          height={work.height}
                          sizes="(max-width: 640px) 70vw, (max-width: 1280px) 28vw, 320px"
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <span
                          aria-hidden="true"
                          className="flex flex-col items-center gap-2 text-decorative-muted"
                        >
                          <svg
                            width="28"
                            height="28"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <rect x="3" y="4" width="18" height="16" rx="2" />
                            <circle cx="9" cy="10" r="2" />
                            <path d="M21 16l-5-5-9 9" />
                          </svg>
                          <span className="font-mono text-xs tabular-nums">[作品图]</span>
                        </span>
                      )}
                    </div>
                    <figcaption className="flex items-baseline justify-between gap-3 text-sm text-muted-foreground">
                      <span className="min-w-0 truncate">{prompt}</span>
                      <span className="shrink-0 font-mono text-xs tabular-nums text-foreground">
                        {work.label}
                      </span>
                    </figcaption>
                  </figure>
                </li>
              )
            })}
          </ul>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          五种画幅，同一个面板里切换。示例作品均由 MuseCanvas 生成。
        </p>
      </ContentFrame>
    </section>
  )
}
