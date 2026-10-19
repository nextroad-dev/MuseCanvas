import type { CSSProperties } from 'react'
import Image from 'next/image'
import { ContentFrame } from '@/shared/components/content-frame'
import { SHOWCASE_WORKS, showcasePrompt, showcaseSrc } from '@/shared/lib/showcase'

/**
 * 作品条：5 种画幅等高不等宽（flex 比例 + aspect-ratio）。
 * <640px 改为固定 200px 高、按画幅定宽的横向滚动条（`--work-ratio` 即宽高比），
 * 首屏约 3 张；>=640px 保持等高不等宽的桌面布局。
 * 素材由仓库所有者提供（plan §7.1）：`public/showcase/` 与 `showcase.json`
 * 缺失时渲染 `bg-tonal` 占位块，构建与渲染都不报错。
 * 图注只显示提示词，不显示画幅比例。
 */
const WORKS = SHOWCASE_WORKS

/** Mobile (<640px) card height; each card's width is this height times its ratio. */
const MOBILE_WORK_HEIGHT = 200

/** 落地页作品条（server component：无 Query、无 store，保持 `force-static`）。 */
export function WorksStrip() {
  return (
    <section id="works" aria-labelledby="works-title" className="scroll-mt-16">
      <ContentFrame className="pb-6">
        <h2 id="works-title" className="sr-only">
          作品示例
        </h2>
        <div className="overflow-x-auto pb-2">
          <ul className="flex min-w-0 items-start gap-3 sm:min-w-[1080px] sm:gap-4">
            {WORKS.map((work) => {
              const src = showcaseSrc(work.file)
              const prompt = showcasePrompt(work.file, work.label)
              return (
                <li
                  key={work.file}
                  style={
                    {
                      '--work-ratio': work.grow,
                      '--work-width': `${MOBILE_WORK_HEIGHT * work.grow}px`,
                    } as CSSProperties
                  }
                  className="flex min-w-0 w-(--work-width) flex-none flex-col sm:w-auto sm:flex-1 sm:grow-(--work-ratio)"
                >
                  <figure className="m-0 flex min-w-0 flex-col gap-2.5">
                    <div
                      style={{ aspectRatio: work.ratio }}
                      className="relative flex h-[200px] items-center justify-center overflow-hidden rounded-card bg-tonal sm:h-auto"
                    >
                      {src ? (
                        <Image
                          src={src}
                          alt={prompt}
                          width={work.width}
                          height={work.height}
                          sizes="(max-width: 640px) 360px, (max-width: 1280px) 28vw, 320px"
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
                    <figcaption className="truncate text-[13px] text-muted-foreground">{prompt}</figcaption>
                  </figure>
                </li>
              )
            })}
          </ul>
        </div>
        <p className="mt-3 text-xs text-muted-foreground sm:hidden">← 横向滑动查看示例作品</p>
        <p className="mt-2 text-[13px] text-muted-foreground">
          五种画幅，同一个面板里切换。示例作品均由 MuseCanvas 生成。
        </p>
      </ContentFrame>
    </section>
  )
}
