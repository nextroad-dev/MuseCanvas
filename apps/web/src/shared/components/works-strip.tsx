import { LandingFrame } from '@/features/landing/components/landing-frame'
import { SectionHeading } from '@/features/landing/components/section-heading'
import { ShowcaseFrame } from '@/features/landing/components/showcase-frame'
import { Reveal } from '@/shared/components/reveal'
import { SHOWCASE_WORKS } from '@/shared/lib/showcase'

/** Declared pixel size of the 4:3 showcase file, shown in the prompt card. */
const LANDSCAPE_43 = SHOWCASE_WORKS.find((work) => work.file === 'ratio-4x3.webp')

/** Prompt shown on the prompt card (mock copy). */
const PROMPT_CARD_TEXT =
  '等距视角的微缩独立书店，黏土质感，木书架摆满书籍，窗台上有绿植和一只熟睡的橘猫，暖色台灯。'

/**
 * 作品 section from the design mock: a mosaic of showcase images with short
 * titles as captions, and a prompt card. Two rows; the second row is 420px tall
 * from `md` and stacks at its own ratios below it. Images come only from the
 * showcase files, and a missing asset renders a placeholder.
 */
export function WorksStrip() {
  return (
    <section id="works" aria-labelledby="works-title" className="scroll-mt-16">
      <Reveal>
        <LandingFrame className="pb-24 md:pb-32">
          <div className="border-t border-foreground pt-8 md:pt-10">
            <SectionHeading
              id="works-title"
              title="作品"
              lede="这些都是在这里画的"
              className="mb-12 md:mb-14"
            />
          </div>

          <div className="flex flex-col gap-10">
            <div className="flex flex-col gap-6 md:flex-row md:flex-wrap md:items-start">
              <figure className="m-0 flex min-w-0 flex-col gap-3 md:flex-[1.778_1_480px]">
                <ShowcaseFrame
                  file="ratio-16x9.webp"
                  label="16:9"
                  className="aspect-video w-full rounded-control"
                  sizes="(max-width: 768px) 100vw, 60vw"
                />
                <figcaption className="text-center text-sm text-muted-foreground">茶山云海</figcaption>
              </figure>
              <figure className="m-0 flex min-w-0 flex-col gap-3 md:flex-[1_1_280px]">
                <ShowcaseFrame
                  file="ratio-1x1.webp"
                  label="1:1"
                  className="aspect-square w-full rounded-control"
                  sizes="(max-width: 768px) 100vw, 40vw"
                />
                <figcaption className="text-center text-sm text-muted-foreground">粗陶与橄榄枝</figcaption>
              </figure>
            </div>

            <div className="flex flex-col gap-6 md:flex-row md:flex-wrap md:items-stretch">
              <figure className="m-0 flex min-w-0 flex-col gap-3 md:flex-[0_1_260px]">
                <ShowcaseFrame
                  file="ratio-9x16.webp"
                  label="9:16"
                  className="aspect-[9/16] w-full rounded-control md:aspect-auto md:h-[420px]"
                  sizes="(max-width: 768px) 100vw, 22vw"
                />
                <figcaption className="text-center text-sm text-muted-foreground">荷塘白鹭</figcaption>
              </figure>
              <figure className="m-0 flex min-w-0 flex-col gap-3 md:flex-[1.333_1_400px]">
                <ShowcaseFrame
                  file="ratio-4x3.webp"
                  label="4:3"
                  className="aspect-[4/3] w-full rounded-control md:aspect-auto md:h-[420px]"
                  sizes="(max-width: 768px) 100vw, 34vw"
                />
                <figcaption className="text-center text-sm text-muted-foreground">微缩书店</figcaption>
              </figure>
              <aside
                aria-label="作品提示词"
                className="flex min-w-0 flex-col items-center justify-center gap-8 rounded-control bg-surface p-8 text-center md:flex-[1_1_300px] md:h-[420px]"
              >
                <div className="flex flex-col gap-4">
                  <p className="text-sm font-medium text-muted-foreground">这张图的提示词</p>
                  <p className="text-2xl font-medium leading-[1.6] text-foreground [text-wrap:balance]">
                    {PROMPT_CARD_TEXT}
                  </p>
                </div>
                <dl className="grid grid-cols-[auto_auto] justify-center gap-x-5 gap-y-2 text-left text-sm">
                  <dt className="text-muted-foreground">模型</dt>
                  <dd className="m-0 font-mono text-foreground">图像 · 默认模型</dd>
                  <dt className="text-muted-foreground">尺寸</dt>
                  <dd className="m-0 font-mono tabular-nums text-foreground">
                    {LANDSCAPE_43 ? `${LANDSCAPE_43.width} × ${LANDSCAPE_43.height}` : '4:3'}
                  </dd>
                </dl>
              </aside>
            </div>
          </div>
        </LandingFrame>
      </Reveal>
    </section>
  )
}
