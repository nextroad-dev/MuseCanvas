import Link from 'next/link'
import { ArrowRightIcon as ArrowRight } from '@phosphor-icons/react/ssr'
import { Reveal } from '@/shared/components/reveal'
import { PublicHeader } from '@/shared/components/public-header'
import { SiteFooter } from '@/shared/components/site-footer'
import { ContentFrame } from '@/shared/components/content-frame'
import { BrandMark } from '@/shared/components/brand-mark'
import { WorksStrip } from '@/shared/components/works-strip'
// `button-variants` is the directive-free half of the button primitive, which is
// the whole reason this page can use it: a server component may render a client
// module but never *call* its exports, so `buttonVariants` is imported from the
// recipe module instead of mirrored here.
import { buttonVariants } from '@/shared/components/ui/button-variants'
import { cn } from '@/shared/lib/cn'

export const dynamic = 'force-static'

export const metadata = {
  title: 'MuseCanvas - 把灵感整理成可生成的画面',
  description: '面向创作者的 AI 图像生成工作台：提示词、画幅与参考图、任务队列和作品图库保持在同一条创作路径上。',
}

const heroPrimary = buttonVariants({ variant: 'primary', size: 'lg' })
const heroSecondary = buttonVariants({ variant: 'secondary', size: 'lg' })
const ctaGhost = buttonVariants({ variant: 'ghost', size: 'lg' })

const consoleSpecs: { label: string; value: string }[] = [
  { label: '生成模型', value: 'GPT Image 2.5 / Seedream 4.5' },
  { label: '画幅', value: '1:1 · 16:9 · 9:16 · 4:3 · 3:4' },
  { label: '单次张数', value: '1 / 2 / 4 张' },
  { label: '参考图', value: '最多 4 张，PNG / JPEG' },
]

const capabilities = [
  {
    no: '01',
    title: '提示词不需要套模板',
    description:
      '写下主体、场景、材质、光线，以及想避开的元素就够了。风格模板由系统侧统一维护，提交前不必手动挑选。',
  },
  {
    no: '02',
    title: '模型、画幅与参考图',
    description:
      '在同一个面板里切换模型、5 种画幅和单次张数，并上传 PNG 或 JPEG 参考图作为构图与风格依据。',
  },
  {
    no: '03',
    title: '排队、重试与取消',
    description:
      '任务提交后进入队列按序执行，失败会自动重试；也可以只对失败的任务手动重跑，或在结束前取消。',
  },
  {
    no: '04',
    title: '作品自动沉淀',
    description:
      '生成结果自动进入图库。调整网格密度、放大比对细节、下载原图，或者单张、批量删除不要的版本。',
  },
  {
    no: '05',
    title: '验证码登录',
    description:
      '用邮箱接收 6 位验证码直接进入，不需要再记一个密码；也支持 GitHub 与 Google 账号。部署方可切换为邀请码注册。',
  },
  {
    no: '06',
    title: '自托管与后台',
    description:
      '通过初始化向导完成部署配置，任务、用户、模型与提供商、提示词模板、OAuth 都有各自的管理页面。',
  },
]

const workflowSteps = [
  {
    no: '01',
    title: '写下画面',
    description: '用自然语言描述构图与氛围；需要延续某张图的感觉时，直接上传为参考图。',
  },
  {
    no: '02',
    title: '确定输出',
    description: '选择模型、画幅和张数。提交后任务进入队列，状态在创作台里一路可见。',
  },
  {
    no: '03',
    title: '回看与下载',
    description: '结果自动进入图库：按时间回看、放大比对、下载原图，或删除不满意的版本。',
  },
]

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

/** 创作流程示意块：纯 CSS 占位图形，无图片、无 JS，220px 高。 */
function WorkflowFigure({ index }: { index: number }) {
  if (index === 0) {
    return (
      <div aria-hidden="true" className="flex h-[220px] flex-col gap-3 rounded-card bg-canvas p-5">
        <div className="flex-1 rounded-control bg-surface p-4 text-sm leading-relaxed text-foreground shadow-soft">
          清晨的江边小镇，薄雾，木质渡船停在石阶旁，柔和逆光，胶片质感
          <span className="ml-0.5 inline-block h-4 w-0.5 bg-foreground align-[-3px]" />
        </div>
        <div className="flex gap-2">
          <span className="size-11 rounded-control bg-tonal-selected" />
          <span className="size-11 rounded-control bg-tonal-hover" />
          <span className="inline-flex items-center rounded-control border border-dashed border-border-control px-2.5 text-xs text-muted-foreground">
            参考图
          </span>
        </div>
      </div>
    )
  }
  if (index === 1) {
    return (
      <div
        aria-hidden="true"
        className="flex h-[220px] flex-col justify-center gap-4 rounded-card bg-canvas p-5"
      >
        <div className="flex flex-col gap-1.5">
          <span className="text-overline text-muted-foreground">模型</span>
          <div className="flex w-fit gap-1 rounded-control bg-tonal p-1">
            <span className="rounded-control bg-surface px-2.5 py-1 text-sm shadow-soft">
              GPT Image 2.5
            </span>
            <span className="px-2.5 py-1 text-sm text-muted-foreground">Seedream 4.5</span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-overline text-muted-foreground">画幅</span>
          <div className="flex items-end gap-1.5">
            <span className="h-7 w-7 rounded-[4px] border border-border-control" />
            <span className="h-6 w-11 rounded-[4px] border border-border-control" />
            <span className="h-8 w-4 rounded-[4px] border border-border-control" />
            <span className="h-7 w-9 rounded-[4px] border-2 border-primary bg-tonal-selected" />
            <span className="h-8 w-6 rounded-[4px] border border-border-control" />
          </div>
        </div>
      </div>
    )
  }
  return (
    <div aria-hidden="true" className="grid h-[220px] grid-cols-3 gap-2 rounded-card bg-canvas p-5">
      <span className="rounded-control bg-tonal-selected" />
      <span className="rounded-control bg-tonal-hover" />
      <span className="rounded-control bg-tonal outline-2 outline-offset-2 outline-primary" />
      <span className="rounded-control bg-tonal-hover" />
      <span className="rounded-control bg-tonal" />
      <span className="rounded-control bg-tonal-selected" />
    </div>
  )
}

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
        {/* Hero: 左标题区、右 CTA，底对齐。 */}
        <section aria-labelledby="hero-title" className="scroll-mt-16">
          <ContentFrame className="flex flex-wrap items-end justify-between gap-x-16 gap-y-10 pb-14 pt-12 md:pt-16 lg:pb-24 lg:pt-24">
            <div className="flex min-w-0 max-w-2xl flex-1 basis-[560px] flex-col gap-6">
              <p className="inline-flex w-fit items-center gap-2 rounded-pill bg-tonal px-3 py-1 text-sm font-medium text-foreground">
                <span aria-hidden="true" className="size-1.5 rounded-pill bg-accent" />
                自托管 AI 图像工作台
              </p>
              <h1
                id="hero-title"
                className="text-display text-foreground [line-break:strict] [text-wrap:balance]"
              >
                把灵感整理成
                <br />
                可生成的画面
              </h1>
              <p className="max-w-xl text-base text-muted-foreground [text-wrap:pretty]">
                提示词、模型与画幅、参考图、任务队列和作品图库，留在同一条创作路径上。写下画面，剩下的交给工作台。
              </p>
            </div>

            <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
              <Link href="/login" className={cn(heroPrimary, 'justify-center')}>
                开始创作
                <ArrowRight weight="bold" aria-hidden="true" />
              </Link>
              <Link href="#workflow" className={cn(heroSecondary, 'justify-center')}>
                看看创作流程
              </Link>
            </div>
          </ContentFrame>
        </section>

        <WorksStrip />

        {/* 规格横条：4 列 dl，上下 1px border。 */}
        <section aria-label="创作台速览">
          <ContentFrame className="pb-4 pt-12 md:pt-16">
            <dl className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] border-y border-border">
              {consoleSpecs.map((spec) => (
                <div key={spec.label} className="flex flex-col gap-1 py-5 pr-6">
                  <dt className="text-sm text-muted-foreground">{spec.label}</dt>
                  {/* 断行策略：数字与单位之间用不断行空格绑定；` / ` 与 ` · ` 两侧留普通空格，允许在分隔符处换行 */}
                  <dd className="m-0 font-mono text-sm tabular-nums text-foreground">{spec.value}</dd>
                </div>
              ))}
            </dl>
          </ContentFrame>
        </section>

        {/* 产品能力：6 项编号 01–06，三列，hairline 分隔。条目无入场动画（§3.4：加载动画滚到时已播完）。 */}
        <section id="capabilities" aria-labelledby="capabilities-title" className="scroll-mt-16">
          <Reveal>
            <ContentFrame className="py-16 md:py-24 lg:py-32">
              <SectionIntro
                eyebrow="产品能力"
                title="一次生成要经过的环节，都收在同一个工作台里"
                titleId="capabilities-title"
              />

              <ul className="mt-14 grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
                {capabilities.map((capability) => (
                  <li key={capability.title} className="flex min-w-0 flex-col gap-2.5 border-t border-border pt-6">
                    <span className="font-mono text-sm tabular-nums text-muted-foreground">
                      {capability.no}
                    </span>
                    <h3 className="text-module text-foreground [text-wrap:balance]">{capability.title}</h3>
                    <p className="text-sm text-muted-foreground [text-wrap:pretty]">
                      {capability.description}
                    </p>
                  </li>
                ))}
              </ul>
            </ContentFrame>
          </Reveal>
        </section>

        {/* 创作流程：三列卡，每列上方 220px 示意块，下方编号 + 标题 + 描述。 */}
        <section id="workflow" aria-labelledby="workflow-title" className="scroll-mt-16 bg-surface">
          <Reveal>
            <ContentFrame className="flex flex-col gap-14 py-16 md:py-24 lg:py-32">
              <SectionIntro
                eyebrow="创作流程"
                title="不把灵感塞进表单，而是放进流程"
                titleId="workflow-title"
                description="描述画面、确定输出、回看结果，三步之间没有需要来回搬运的中间状态。"
              />

              <ol className="grid grid-cols-[minmax(0,1fr)] gap-8 sm:grid-cols-2 lg:grid-cols-3">
                {workflowSteps.map((step, index) => (
                  <li key={step.title} className="flex min-w-0 flex-col gap-5">
                    <WorkflowFigure index={index} />
                    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
                      <span className="font-mono text-sm tabular-nums text-muted-foreground">
                        {step.no}
                      </span>
                      <h3 className="text-subtitle text-foreground [line-break:strict]">{step.title}</h3>
                      <span aria-hidden="true" />
                      <p className="text-sm text-muted-foreground [text-wrap:pretty]">{step.description}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </ContentFrame>
          </Reveal>
        </section>

        {/* 收尾区：bg-tonal，左标志 + 标题，右双按钮。 */}
        <section aria-labelledby="cta-title" className="bg-tonal">
          <Reveal>
            <ContentFrame className="flex flex-wrap items-center justify-between gap-8 py-20 md:py-24 lg:py-28">
              <div className="flex min-w-0 flex-wrap items-center gap-7">
                <BrandMark variant="mark" className="h-14" />
                <div className="flex min-w-0 flex-col gap-2">
                  <h2 id="cta-title" className="text-section text-foreground [text-wrap:balance]">
                    准备好让第一段描述成形了吗？
                  </h2>
                  <p className="max-w-xl text-base text-muted-foreground [text-wrap:pretty]">
                    登录后即进入创作台，生成的作品会直接出现在你的图库里。
                  </p>
                </div>
              </div>
              <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
                <Link href="/login" className={cn(heroPrimary, 'justify-center')}>
                  进入 MuseCanvas
                  <ArrowRight weight="bold" aria-hidden="true" />
                </Link>
                <Link href="/terms" className={cn(ctaGhost, 'justify-center')}>
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
