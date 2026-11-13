import type { ReactNode } from 'react'
import { SHOWCASE_ITEMS } from '@/shared/lib/showcase'
import { LandingFrame } from './landing-frame'
import { ShowcaseFrame } from './showcase-frame'

/** 画板 01 的示例提示词卡文案（作品图本身来自 showcase 素材）。 */
const PROMPT_CARD_TEXT =
  '等距视角的微缩独立书店，黏土质感，木书架摆满书籍，窗台上有绿植和一只熟睡的橘猫，暖色台灯。'
const PROMPT_CARD_MODEL = '图像 · 默认模型'

function byFile(file: string) {
  return SHOWCASE_ITEMS.find((item) => item.file === file)
}

/** 图下渐变说明条：白色文字压暗底，保证任何图片上都可读。 */
function Caption({ children }: { children: ReactNode }) {
  return (
    <span className="media-scrim absolute inset-x-0 bottom-0 px-4 pb-4 pt-10 text-center text-base font-medium text-on-media">
      {children}
    </span>
  )
}

/**
 * 作品区（画板 01）：黑色 hairline 开场，衬线「作品」+ 24px 副题；
 * 两行拼图——① 16:9 + 1:1；② 9:16 竖图 + 4:3 宽图 + 白色提示词卡。
 * 图片全部来自 `SHOWCASE_ITEMS`，缺图由 `ShowcaseFrame` 渲染 tonal 占位；
 * <960px 全部改为纵向堆叠，避免 375 宽横向溢出。
 */
export function WorksGallery() {
  const wide16 = byFile('ratio-16x9.webp')
  const square = byFile('ratio-1x1.webp')
  const tall = byFile('ratio-9x16.webp')
  const wide43 = byFile('ratio-4x3.webp')

  return (
    <section id="works" aria-labelledby="works-title" className="scroll-mt-20">
      <LandingFrame className="pb-20 md:pb-32">
        <div className="border-t border-foreground pt-8">
          <div className="mb-12 flex flex-wrap items-end justify-between gap-6">
            <div className="flex flex-col gap-4">
              <h2 id="works-title" className="font-display text-headline text-foreground">
                作品
              </h2>
              <p className="font-display text-section font-medium text-foreground/80">这些都是在这里画的</p>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-6 md:gap-10">
          <div className="flex flex-col gap-6 md:flex-row md:flex-wrap md:items-start">
            {wide16 ? (
              <figure className="m-0 min-w-0 md:flex-[1.778_1_480px]">
                <ShowcaseFrame
                  file={wide16.file}
                  label={wide16.label}
                  sizes="(min-width: 960px) 60vw, 100vw"
                  className="aspect-video w-full rounded-[6px]"
                >
                  <Caption>{wide16.prompt}</Caption>
                </ShowcaseFrame>
              </figure>
            ) : null}
            {square ? (
              <figure className="m-0 min-w-0 md:flex-[1_1_280px]">
                <ShowcaseFrame
                  file={square.file}
                  label={square.label}
                  sizes="(min-width: 960px) 40vw, 100vw"
                  className="aspect-square w-full rounded-[6px]"
                >
                  <Caption>{square.prompt}</Caption>
                </ShowcaseFrame>
              </figure>
            ) : null}
          </div>

          <div className="flex flex-col gap-6 md:flex-row md:flex-wrap md:items-stretch">
            {tall ? (
              <figure className="m-0 min-w-0 md:flex-[0_1_260px]">
                <ShowcaseFrame
                  file={tall.file}
                  label={tall.label}
                  sizes="(min-width: 960px) 22vw, 100vw"
                  className="h-[320px] w-full rounded-[6px] md:h-[420px]"
                >
                  <Caption>{tall.prompt}</Caption>
                </ShowcaseFrame>
              </figure>
            ) : null}
            {wide43 ? (
              <figure className="m-0 min-w-0 md:flex-[1.333_1_400px]">
                <ShowcaseFrame
                  file={wide43.file}
                  label={wide43.label}
                  sizes="(min-width: 960px) 34vw, 100vw"
                  className="aspect-[4/3] w-full rounded-[6px] md:aspect-auto md:h-[420px]"
                >
                  <Caption>{wide43.prompt}</Caption>
                </ShowcaseFrame>
              </figure>
            ) : null}

            <aside
              aria-label="作品提示词"
              className="flex min-w-0 flex-col items-center justify-center gap-8 rounded-[6px] bg-surface p-8 text-center md:h-[420px] md:flex-[1_1_300px]"
            >
              <div className="flex flex-col gap-4">
                <p className="text-compact font-medium text-muted-foreground">这张图的提示词</p>
                <p className="font-display text-section font-medium leading-[1.6] text-foreground">{PROMPT_CARD_TEXT}</p>
              </div>
              <dl className="m-0 grid grid-cols-[auto_auto] justify-center gap-x-5 gap-y-2 text-left text-compact">
                <dt className="text-muted-foreground">模型</dt>
                <dd className="m-0 font-mono text-foreground">{PROMPT_CARD_MODEL}</dd>
                <dt className="text-muted-foreground">尺寸</dt>
                <dd className="m-0 font-mono tabular-nums text-foreground">
                  {wide43 ? `${wide43.width} × ${wide43.height}` : '1448 × 1086'}
                </dd>
              </dl>
            </aside>
          </div>
        </div>
      </LandingFrame>
    </section>
  )
}
