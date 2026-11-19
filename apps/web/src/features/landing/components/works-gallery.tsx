import type { ReactNode } from 'react'
import { PaletteIcon, SparkleIcon } from '@phosphor-icons/react/ssr'
import { Reveal } from '@/shared/components/reveal'
import { Badge, Card, SectionHeader } from '@/shared/components/ui'
import { SHOWCASE_ITEMS } from '@/shared/lib/showcase'
import { LandingFrame } from './landing-frame'
import { ShowcaseFrame } from './showcase-frame'

/** 示例提示词卡文案（作品素材来自 `public/showcase/showcase.json`）。 */
const PROMPT_CARD_TEXT =
  '等距视角的微缩独立书店，黏土质感，木书架摆满书籍，窗台上有绿植和一只熟睡的橘猫，暖色台灯。'
const PROMPT_CARD_MODEL = '图像 · 默认模型'

function byFile(file: string) {
  return SHOWCASE_ITEMS.find((item) => item.file === file)
}

/** 图下渐变说明条：保证亮/暗图面上的说明文字清晰可读。 */
function Caption({ children, ratio }: { children: ReactNode; ratio: string }) {
  return (
    <figcaption className="media-scrim absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 px-4 pb-4 pt-10 text-sm text-on-media">
      <span className="truncate font-medium">{children}</span>
      <span className="shrink-0 rounded-pill bg-surface/20 px-2 py-0.5 font-mono text-caption backdrop-blur-sm">
        {ratio}
      </span>
    </figcaption>
  )
}

/**
 * 作品区：精选画廊 + 两行编辑式拼图（① 16:9 + 1:1；② 9:16 竖图 + 4:3 宽图 + 提示词卡）。
 * 图片数据全部读取自 `SHOWCASE_ITEMS`（`showcase.json`），经 `ShowcaseFrame`（`StaticImage`）渲染。
 */
export function WorksGallery() {
  const wide16 = byFile('ratio-16x9.webp')
  const square = byFile('ratio-1x1.webp')
  const tall = byFile('ratio-9x16.webp')
  const wide43 = byFile('ratio-4x3.webp')

  return (
    <section id="works" aria-labelledby="works-title" className="scroll-mt-20">
      <Reveal>
        <LandingFrame className="py-20 md:py-28">
          <div className="mb-10 flex flex-col gap-4 border-t border-border pt-10">
            <div>
              <Badge
                tone="accent"
                variant="soft"
                icon={<PaletteIcon weight="duotone" />}
                className="gap-1.5 px-3 py-1 text-caption"
              >
                精选画廊
              </Badge>
            </div>
            <SectionHeader
              id="works-title"
              title={<span className="block font-display text-headline text-foreground">作品</span>}
              description="这些都是在这里画的，覆盖横幅、方图、海报与竖屏多种画幅。"
            />
          </div>

          <div className="flex flex-col gap-6 md:gap-8">
            <div className="flex flex-col gap-6 md:flex-row md:flex-wrap md:items-start">
              {wide16 ? (
                <figure className="group m-0 min-w-0 md:flex-[1.778_1_480px]">
                  <ShowcaseFrame
                    file={wide16.file}
                    label={wide16.label}
                    hoverZoom
                    className="aspect-video w-full rounded-card border border-border shadow-soft"
                  >
                    <Caption ratio={wide16.label}>{wide16.prompt}</Caption>
                  </ShowcaseFrame>
                </figure>
              ) : null}
              {square ? (
                <figure className="group m-0 min-w-0 md:flex-[1_1_280px]">
                  <ShowcaseFrame
                    file={square.file}
                    label={square.label}
                    hoverZoom
                    className="aspect-square w-full rounded-card border border-border shadow-soft"
                  >
                    <Caption ratio={square.label}>{square.prompt}</Caption>
                  </ShowcaseFrame>
                </figure>
              ) : null}
            </div>

            <div className="flex flex-col gap-6 md:flex-row md:flex-wrap md:items-stretch">
              {tall ? (
                <figure className="group m-0 min-w-0 md:flex-[0_1_260px]">
                  <ShowcaseFrame
                    file={tall.file}
                    label={tall.label}
                    hoverZoom
                    className="h-80 w-full rounded-card border border-border shadow-soft md:h-[420px]"
                  >
                    <Caption ratio={tall.label}>{tall.prompt}</Caption>
                  </ShowcaseFrame>
                </figure>
              ) : null}
              {wide43 ? (
                <figure className="group m-0 min-w-0 md:flex-[1.333_1_400px]">
                  <ShowcaseFrame
                    file={wide43.file}
                    label={wide43.label}
                    hoverZoom
                    className="aspect-[4/3] w-full rounded-card border border-border shadow-soft md:aspect-auto md:h-[420px]"
                  >
                    <Caption ratio={wide43.label}>{wide43.prompt}</Caption>
                  </ShowcaseFrame>
                </figure>
              ) : null}

              <Card
                variant="surface"
                density="none"
                role="complementary"
                aria-label="作品提示词"
                className="min-w-0 justify-between gap-6 p-7 md:h-[420px] md:flex-[1_1_300px]"
              >
                <div className="flex flex-col items-start gap-4">
                  <Badge
                    tone="neutral"
                    variant="soft"
                    icon={<SparkleIcon weight="duotone" className="text-accent" />}
                    className="gap-1.5 px-3 py-1 text-caption"
                  >
                    这张图的提示词
                  </Badge>
                  <p className="m-0 font-display text-module leading-relaxed text-foreground">{PROMPT_CARD_TEXT}</p>
                </div>

                <dl className="m-0 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2.5 border-t border-border pt-5 text-ui">
                  <dt className="text-muted-foreground">模型</dt>
                  <dd className="m-0 justify-self-end">
                    <Badge tone="neutral" variant="soft" className="font-mono text-caption text-foreground">
                      {PROMPT_CARD_MODEL}
                    </Badge>
                  </dd>
                  <dt className="text-muted-foreground">尺寸</dt>
                  <dd className="m-0 justify-self-end">
                    <Badge tone="neutral" variant="soft" className="font-mono text-caption tabular-nums text-foreground">
                      {wide43 ? `${wide43.width} × ${wide43.height}` : '1600 × 1200'}
                    </Badge>
                  </dd>
                </dl>
              </Card>
            </div>
          </div>
        </LandingFrame>
      </Reveal>
    </section>
  )
}
