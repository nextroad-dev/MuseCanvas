import Link from 'next/link'
import { Reveal } from '@/shared/components/reveal'
import { PublicHeader } from '@/shared/components/public-header'
import { SiteFooter } from '@/shared/components/site-footer'
import { WorksStrip } from '@/shared/components/works-strip'
import { buttonVariants } from '@/shared/components/ui/button-variants'
import { GENERATE_ROUTE } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'
import { CapabilityAccordion } from '@/features/landing/components/capability-accordion'
import { LandingFrame } from '@/features/landing/components/landing-frame'
import { MobileCtaBar } from '@/features/landing/components/mobile-cta-bar'
import { PlatformStrip } from '@/features/landing/components/platform-strip'
import { SectionHeading } from '@/features/landing/components/section-heading'
import { ShowcaseFrame } from '@/features/landing/components/showcase-frame'
import { WorkflowPreview } from '@/features/landing/components/workflow-preview'
import { CAPABILITY_ITEMS, WORKFLOW_STEPS } from '@/features/landing/content'

export const dynamic = 'force-static'

export const metadata = {
  title: 'MuseCanvas - 把灵感整理成可生成的画面',
  description: '面向创作者的 AI 图像生成工作台：提示词、画幅与参考图、任务队列和作品图库保持在同一条创作路径上。',
}

/** Landing CTA metrics from the design mock: 48px high, 16px label, 18px icon. */
const landingCta = 'px-6 text-base [&>svg]:size-[18px]'

/** Dark band buttons use inverse tokens: the primary recipe would vanish on the dark ground. */
const bandPrimary =
  'motion-press inline-flex min-h-[var(--control-lg)] items-center justify-center rounded-control bg-foreground-inverse px-6 text-base font-medium text-foreground transition-colors hover:opacity-90'
const bandSecondary =
  'motion-press inline-flex min-h-[var(--control-lg)] items-center justify-center rounded-control border border-border-control px-6 text-base font-medium text-foreground-inverse transition-colors hover:bg-foreground-inverse/10'

export default function HomePage() {
  return (
    <div className="min-h-screen bg-canvas text-foreground antialiased">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-tooltip focus:rounded-control focus:bg-primary focus:px-4 focus:py-2 focus:text-on-primary"
      >
        跳到主要内容
      </a>
      <PublicHeader current="landing" />

      <main id="main" className="motion-page-enter">
        {/* Hero: copy left, 3:4 figure right (stacked below `md`). */}
        <section aria-labelledby="hero-title" className="scroll-mt-16">
          <LandingFrame className="grid items-center gap-12 pb-16 pt-8 md:grid-cols-2 md:gap-16 md:pb-28 md:pt-16">
            <div className="flex min-w-0 flex-col gap-8">
              <h1
                id="hero-title"
                className="text-[length:clamp(3rem,calc(0.6rem_+_6vw),6rem)] font-medium leading-[1.08] tracking-[-0.01em] text-foreground [line-break:strict] [text-wrap:balance]"
              >
                让创意
                <br />
                快速落地
              </h1>
              <p className="max-w-xl text-xl leading-[1.7] text-foreground/85 [text-wrap:pretty]">
                把构想写成一段文字，AI 即刻生成画面，作品自动保存至图库。
              </p>
              <div className="flex flex-wrap items-center gap-x-7 gap-y-5">
                <Link href={GENERATE_ROUTE} className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), landingCta)}>
                  开始创作
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.8}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M5 12h14" />
                    <path d="M13 6l6 6-6 6" />
                  </svg>
                </Link>
                <Link
                  href="#works"
                  className="text-base font-medium text-foreground underline decoration-1 underline-offset-[6px] transition-colors hover:text-muted-foreground"
                >
                  先看看作品
                </Link>
              </div>
            </div>

            <figure className="m-0 flex flex-col gap-3.5">
              <ShowcaseFrame
                file="ratio-3x4.webp"
                label="3:4"
                sizes="(max-width: 768px) 100vw, 50vw"
                className="aspect-[3/4] max-h-[620px] w-full rounded-control"
              />
              <figcaption className="text-center text-sm text-muted-foreground">晨雾乌篷船</figcaption>
            </figure>
          </LandingFrame>
        </section>

        <WorksStrip />

        <PlatformStrip />

        {/* Capabilities: intro left, single-open accordion right. */}
        <section id="capabilities" aria-labelledby="cap-title" className="scroll-mt-16">
          <Reveal>
            <LandingFrame className="flex flex-wrap items-start gap-x-20 gap-y-12 py-24 md:py-32">
              <div className="flex max-w-[400px] flex-[1_1_320px] flex-col gap-5">
                <SectionHeading id="cap-title" title="能力" lede="写、画、存，都在一个页面" />
                <p className="text-lg leading-[1.7] text-foreground/85 [text-wrap:pretty]">
                  从描述画面到找回旧图，不用切换其他工具。
                </p>
              </div>
              <div className="min-w-0 flex-[999_1_560px]">
                <CapabilityAccordion items={CAPABILITY_ITEMS} defaultOpen={0} />
              </div>
            </LandingFrame>
          </Reveal>
        </section>

        {/* Workflow: hairline top rule, three 260px previews, step copy beneath each. */}
        <section id="workflow" aria-labelledby="flow-title" className="scroll-mt-16 border-t border-border bg-surface">
          <Reveal>
            <LandingFrame className="flex flex-col gap-14 py-24 md:py-32">
              <div className="flex flex-wrap items-end justify-between gap-6">
                <SectionHeading id="flow-title" title="流程" lede="三步，出图" />
                <p className="max-w-[400px] text-lg leading-[1.7] text-foreground/85 [text-wrap:pretty]">
                  任务提交后自动排队生成，进度可随时查看。
                </p>
              </div>

              <ol className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-8">
                {WORKFLOW_STEPS.map((step, index) => (
                  <li key={step.title} className="flex min-w-0 flex-col gap-6">
                    <WorkflowPreview index={index} />
                    <div className="flex flex-col gap-2">
                      <h3 className="text-[1.75rem] font-medium leading-[1.3] text-foreground [text-wrap:balance]">
                        {step.title}
                      </h3>
                      <p className="text-lg leading-[1.7] text-foreground/85 [text-wrap:pretty]">{step.description}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </LandingFrame>
          </Reveal>
        </section>

        {/* Closing band: dark ground with inverse tokens, two actions. */}
        <section aria-labelledby="cta-title" className="bg-foreground text-foreground-inverse">
          <Reveal>
            <LandingFrame className="flex flex-col items-start justify-between gap-10 py-24 md:flex-row md:items-end md:py-28">
              <h2
                id="cta-title"
                className="text-[length:clamp(2rem,calc(1.4rem_+_2vw),2.75rem)] font-medium leading-[1.25] text-foreground-inverse [text-wrap:balance]"
              >
                现在就画第一张
              </h2>
              <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:gap-4">
                <Link href={GENERATE_ROUTE} className={bandPrimary}>
                  开始创作
                </Link>
                <Link
                  href="https://github.com/nextroad-dev/MuseCanvas/blob/main/deploy/README.md"
                  rel="noopener noreferrer"
                  className={bandSecondary}
                >
                  部署到自己的服务器
                </Link>
              </div>
            </LandingFrame>
          </Reveal>
        </section>
      </main>

      <SiteFooter current="landing" />
      <MobileCtaBar />
    </div>
  )
}
