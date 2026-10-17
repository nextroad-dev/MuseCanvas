import Image from 'next/image'
import { ContentFrame } from '@/shared/components/content-frame'
import { SHOWCASE_WORKS, showcasePrompt, showcaseSrc } from '@/shared/lib/showcase'

/**
 * 作品条：5 种画幅等高不等宽（flex 比例 + aspect-ratio）。
 * 素材由仓库所有者提供（plan §7.1）：`public/showcase/` 与 `showcase.json`
 * 缺失时渲染 `bg-tonal` 占位块，构建与渲染都不报错。
 * 图注只显示提示词，不显示画幅比例。
 */
const WORKS = SHOWCASE_WORKS

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
              const src = showcaseSrc(work.file)
              const prompt = showcasePrompt(work.file, work.label)
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
                    <figcaption className="truncate text-sm text-muted-foreground">{prompt}</figcaption>
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
