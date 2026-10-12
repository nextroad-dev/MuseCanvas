import Link from 'next/link'
import type { CSSProperties } from 'react'
import {
  ArrowRightIcon as ArrowRight,
  DownloadSimpleIcon as Download,
  StackIcon as Layers3,
  ImagesSquareIcon as Library,
  EnvelopeSimpleIcon as Mail,
  PencilLineIcon as PenLine,
  ArrowsClockwiseIcon as Repeat,
  ShieldCheckIcon as ShieldCheck,
  SlidersHorizontalIcon as SlidersHorizontal,
  MagicWandIcon as WandSparkles,
} from '@phosphor-icons/react/ssr'
import { Reveal } from '@/shared/components/reveal'
import { PublicHeader } from '@/shared/components/public-header'
import { SiteFooter } from '@/shared/components/site-footer'
import { ContentFrame } from '@/shared/components/content-frame'
// `button-variants` is the directive-free half of the button primitive, which is
// the whole reason this page can use it: a server component may render a client
// module but never *call* its exports, so `buttonVariants` is imported from the
// recipe module instead of mirrored here.
import { buttonVariants } from '@/shared/components/ui/button-variants'
import { cn } from '@/shared/lib/cn'
import { iconSize } from '@/shared/components/ui'

export const dynamic = 'force-static'

export const metadata = {
  title: 'MuseCanvas - 把灵感整理成可生成的画面',
  description: '面向创作者的 AI 图像生成工作台：提示词、画幅与参考图、任务队列和作品图库保持在同一条创作路径上。',
}

const heroPrimary = buttonVariants({ variant: 'primary', size: 'lg' })
const heroGhost = buttonVariants({ variant: 'ghost', size: 'lg' })

const consoleSpecs: { label: string; value: string; mono?: boolean }[] = [
  // 断行策略：数字与单位、名与版本之间用不断行空格绑定；` / ` 与 ` · ` 两侧留普通空格，允许在分隔符处换行
  { label: '生成模型', value: 'GPT Image 2.5 / Seedream 4.5', mono: true },
  { label: '画幅', value: '1:1 · 16:9 · 9:16 · 4:3 · 3:4', mono: true },
  { label: '单次张数', value: '1 / 2 / 4 张', mono: true },
  { label: '参考图', value: '最多 4 张，PNG / JPEG', mono: true },
]

const capabilities = [
  {
    title: '提示词不需要套模板',
    description:
      '写下主体、场景、材质、光线，以及想避开的元素就够了。风格模板由系统侧统一维护，提交前不必手动挑选。',
    icon: WandSparkles,
  },
  {
    title: '模型、画幅与参考图',
    description:
      '在同一个面板里切换模型、5 种画幅和单次张数，并上传 PNG 或 JPEG 参考图作为构图与风格依据。',
    icon: Layers3,
  },
  {
    title: '排队、重试与取消',
    description:
      '任务提交后进入队列按序执行，失败会自动重试；也可以只对失败的任务手动重跑，或在结束前取消。',
    icon: Repeat,
  },
  {
    title: '作品自动沉淀',
    description:
      '生成结果自动进入图库。调整网格密度、放大比对细节、下载原图，或者单张、批量删除不要的版本。',
    icon: Library,
  },
  {
    title: '验证码登录',
    description:
      '用邮箱接收 6 位验证码直接进入，不需要再记一个密码；也支持 GitHub 与 Google 账号。部署方可切换为邀请码注册。',
    icon: Mail,
  },
  {
    title: '自托管与后台',
    description:
      '通过初始化向导完成部署配置，任务、用户、模型与提供商、提示词模板、OAuth 都有各自的管理页面。',
    icon: ShieldCheck,
  },
]

const workflowSteps = [
  {
    title: '写下画面',
    description: '用自然语言描述构图与氛围，需要延续某张图的感觉时，直接把它作为参考图上传。',
    icon: PenLine,
  },
  {
    title: '确定输出',
    description: '选择模型、画幅和单次张数，提交后任务进入队列，每条任务的状态都可以在创作台里跟着看。',
    icon: SlidersHorizontal,
  },
  {
    title: '回看与下载',
    description: '完成后结果自动出现在图库，按时间回看、放大比对、下载原图，或删除不满意的版本。',
    icon: Download,
  },
]

/** Entrance order for a list: each item starts one `--stagger-step` after the previous. */
function staggerAt(index: number) {
  return { '--stagger-index': index } as CSSProperties
}

/**
 * Section opener shared by every marketing block: eyebrow, title, optional lede.
 * The title scale (`text-title`) is the section level; the page hero owns `text-display`.
 */
function SectionIntro({
  eyebrow,
  title,
  titleId,
  description,
}: {
  eyebrow: string
  title: string
  titleId: string
  description?: string
}) {
  return (
    <header className="flex max-w-[var(--content-medium)] flex-col gap-3">
      <p className="text-sm font-medium text-muted-foreground">{eyebrow}</p>
      <h2 id={titleId} className="text-title text-foreground [line-break:strict] [text-wrap:balance]">
        {title}
      </h2>
      {description ? (
        <p className="max-w-reading text-base text-muted-foreground [text-wrap:pretty]">{description}</p>
      ) : null}
    </header>
  )
}

export default function HomePage() {
  return (
    <div className="min-h-screen bg-canvas text-foreground antialiased">
      <PublicHeader current="landing" />

      <main className="motion-page-enter">
        {/* Hero: the page's first screen. Headline and CTAs on the left, a floating spec sheet on the right. */}
        <section className="scroll-mt-16">
          <ContentFrame className="grid grid-cols-[minmax(0,1fr)] items-center gap-12 pb-16 pt-12 md:grid-cols-[minmax(0,1fr)_minmax(320px,26rem)] md:gap-16 md:pt-16 lg:pb-32 lg:pt-28">
            <div className="flex max-w-2xl flex-col">
              <p className="inline-flex w-fit items-center gap-2 rounded-pill bg-tonal px-3 py-1 text-sm font-medium text-foreground">
                <span aria-hidden="true" className="size-1.5 rounded-pill bg-accent" />
                MuseCanvas
              </p>
              <h1 className="mt-6 text-display text-foreground [line-break:strict] [text-wrap:balance]">
                把灵感整理成可生成的画面
              </h1>

              <p className="mt-6 max-w-xl text-base text-muted-foreground [text-wrap:pretty]">
                从提示词、模型与画幅，到任务队列和作品图库，一次生成经过的每个环节都留在同一条清晰的创作路径里。
              </p>

              {/* CTA pair: primary (ink) + ghost. Stacks full-width on phones so each target stays 48px tall. */}
              <div className="mt-10 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
                <Link href="/login" className={cn(heroPrimary, 'justify-center')}>
                  开始创作
                  <ArrowRight weight="bold" aria-hidden="true" />
                </Link>
                <Link href="#workflow" className={cn(heroGhost, 'justify-center')}>
                  看看创作流程
                </Link>
              </div>
            </div>

            {/* Spec sheet: a floating layer, so it is the one block on this page that carries a shadow. */}
            <aside
              aria-labelledby="console-overview-title"
              className="overflow-hidden rounded-panel bg-surface shadow-floating"
            >
              <div className="flex items-baseline justify-between gap-4 bg-tonal px-6 py-4">
                <h2 id="console-overview-title" className="whitespace-nowrap text-sm font-medium text-foreground">
                  创作台速览
                </h2>
                <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">/generate</span>
              </div>

              <dl className="flex flex-col">
                {consoleSpecs.map((spec, index) => (
                  <div
                    key={spec.label}
                    style={staggerAt(index)}
                    className="motion-reveal motion-stagger grid gap-1 border-t border-border px-6 py-4 first:border-t-0 sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:gap-4"
                  >
                    <dt className="whitespace-nowrap text-sm text-muted-foreground">{spec.label}</dt>
                    <dd
                      className={cn(
                        'text-sm text-foreground',
                        spec.mono ? 'font-mono tabular-nums' : '[text-wrap:pretty]',
                      )}
                    >
                      {spec.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </aside>
          </ContentFrame>
        </section>

        {/* Capabilities: no boxed cards. Each item is opened by a hairline rule and carried by its own type. */}
        <section id="capabilities" aria-labelledby="capabilities-title" className="scroll-mt-16">
          <Reveal>
            <ContentFrame className="py-16 md:py-24 lg:py-32">
              <SectionIntro eyebrow="产品能力" title="一次生成要经过的环节，都收在同一个工作台里" titleId="capabilities-title" />

              <ul className="mt-14 grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
                {capabilities.map((capability, index) => {
                  const Icon = capability.icon
                  return (
                    <li
                      key={capability.title}
                      style={staggerAt(index)}
                      className="motion-reveal motion-stagger flex min-w-0 flex-col gap-3 border-t border-border pt-6"
                    >
                      <Icon weight="duotone" className={cn(iconSize.lg, 'text-muted-foreground')} aria-hidden="true" />
                      <h3 className="mt-2 text-module text-foreground [text-wrap:balance]">{capability.title}</h3>
                      <p className="text-sm text-muted-foreground [text-wrap:pretty]">{capability.description}</p>
                    </li>
                  )
                })}
              </ul>
            </ContentFrame>
          </Reveal>
        </section>

        {/* Workflow: a tinted surface band. Steps are a numbered sequence separated by rules, not tiles. */}
        <section id="workflow" aria-labelledby="workflow-title" className="scroll-mt-16 bg-surface">
          <Reveal>
            <ContentFrame className="grid grid-cols-[minmax(0,1fr)] gap-12 py-16 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)] md:gap-16 md:py-24 lg:py-32">
              <div className="flex max-w-xl flex-col gap-3 md:sticky md:top-24 md:self-start">
                <p className="text-sm font-medium text-muted-foreground">创作流程</p>
                <h2 id="workflow-title" className="text-title text-foreground [line-break:strict] [text-wrap:balance]">
                  不把灵感塞进表单，而是放进流程
                </h2>
                <p className="mt-3 text-base text-muted-foreground [text-wrap:pretty]">
                  登录后进入的不是一个功能堆叠的后台，而是一个专注的生成工作区：描述画面、确定输出、回看结果，三步之间没有需要来回搬运的中间状态。
                </p>
              </div>

              <ol className="flex flex-col">
                {workflowSteps.map((step, index) => {
                  const StepIcon = step.icon
                  return (
                    <li
                      key={step.title}
                      style={staggerAt(index)}
                      className="motion-reveal motion-stagger grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-6 border-t border-border py-8 first:border-t-0 first:pt-0 last:pb-0"
                    >
                      <span className="font-mono text-sm tabular-nums text-muted-foreground">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <div className="flex min-w-0 flex-col gap-2">
                        <h3 className="flex items-center gap-2 text-subtitle text-foreground [line-break:strict]">
                          <StepIcon weight="duotone" className={cn(iconSize.md, 'shrink-0 text-muted-foreground')} aria-hidden="true" />
                          {step.title}
                        </h3>
                        <p className="text-sm text-muted-foreground [text-wrap:pretty]">{step.description}</p>
                      </div>
                    </li>
                  )
                })}
              </ol>
            </ContentFrame>
          </Reveal>
        </section>

        {/* CTA: a tonal band closes the page with one centred decision. */}
        <section aria-labelledby="cta-title" className="bg-tonal">
          <Reveal>
            <ContentFrame className="flex flex-col items-center gap-6 py-20 text-center md:py-24 lg:py-32">
              <h2 id="cta-title" className="text-section text-foreground [line-break:strict] [text-wrap:balance]">
                准备好让第一段描述成形了吗？
              </h2>
              <p className="max-w-2xl text-base text-muted-foreground [text-wrap:pretty]">
                登录后即进入创作台：写下提示词、选择画幅与张数，生成的作品会直接出现在你的图库里。
              </p>
              <div className="mt-2 flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:items-center">
                <Link href="/login" className={cn(heroPrimary, 'justify-center')}>
                  进入 MuseCanvas
                  <ArrowRight weight="bold" aria-hidden="true" />
                </Link>
                <Link href="/terms" className={cn(heroGhost, 'justify-center')}>
                  先看用户协议
                </Link>
              </div>
            </ContentFrame>
          </Reveal>
        </section>
      </main>

      <SiteFooter current="landing" />
    </div>
  )
}
