import Link from 'next/link'
import { ArrowRight, Layers3, Library, Mail, Repeat, ShieldCheck, WandSparkles } from 'lucide-react'

export const dynamic = 'force-static'

export const metadata = {
  title: 'MuseCanvas - 把灵感整理成可生成的画面',
  description: '面向创作者的 AI 图像生成工作台：提示词、画幅与参考图、任务队列和作品图库保持在同一条创作路径上。',
}

const consoleSpecs: { label: string; value: string; mono?: boolean }[] = [
  { label: '生成模型', value: '由管理端配置的图像模型，可切换' },
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
  },
  {
    title: '确定输出',
    description: '选择模型、画幅和单次张数，提交后任务进入队列，每条任务的状态都可以在创作台里跟着看。',
  },
  {
    title: '回看与下载',
    description: '完成后结果自动出现在图库，按时间回看、放大比对、下载原图，或删除不满意的版本。',
  },
]

export default function HomePage() {
  return (
    <div className="min-h-screen bg-canvas text-foreground antialiased">
      {/* Top navigation */}
      <nav className="sticky top-0 z-50 border-b border-border bg-surface" aria-label="主导航">
        <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between gap-4 px-4 sm:px-6">
          <Link href="/" className="rounded-[var(--radius-control)]" aria-label="MuseCanvas 首页">
            <img
              src="/brand/musecanvas_flow_ribbon_final_pack/03_transparent_trimmed_png/03_wordmark_transparent_trimmed.png"
              alt="MuseCanvas"
              className="h-6 w-auto"
            />
          </Link>
          <div className="flex items-center gap-1 sm:gap-2">
            <Link
              href="#capabilities"
              className="hidden min-h-10 items-center rounded-[var(--radius-control)] px-3 text-sm text-muted-foreground transition-colors hover:bg-surface-subtle hover:text-foreground md:inline-flex"
            >
              产品能力
            </Link>
            <Link
              href="#workflow"
              className="hidden min-h-10 items-center rounded-[var(--radius-control)] px-3 text-sm text-muted-foreground transition-colors hover:bg-surface-subtle hover:text-foreground md:inline-flex"
            >
              创作流程
            </Link>
            <Link
              href="/terms"
              className="hidden min-h-10 items-center rounded-[var(--radius-control)] px-3 text-sm text-muted-foreground transition-colors hover:bg-surface-subtle hover:text-foreground sm:inline-flex"
            >
              用户协议
            </Link>
            <Link
              href="/login"
              className="inline-flex min-h-10 items-center gap-1.5 rounded-[var(--radius-control)] bg-primary px-4 text-sm font-medium text-foreground-inverse transition-colors hover:bg-primary-hover active:bg-primary-active"
            >
              登录
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
        </div>
      </nav>

      <main>
        {/* Hero */}
        <section className="border-b border-border">
          <div className="mx-auto grid max-w-[1200px] items-start gap-12 px-4 py-20 sm:px-6 sm:py-24 lg:grid-cols-[minmax(0,1fr)_minmax(340px,26rem)] lg:py-28">
            <div className="max-w-2xl">
              <p className="mb-6 inline-flex items-center rounded-full bg-surface-subtle px-3 py-1 text-xs font-medium text-muted-foreground">
                面向创作者的 AI 图像工作台
              </p>

              <h1 className="text-display font-normal leading-[1.05] tracking-[-0.0175em] text-foreground">
                MuseCanvas
                {/* CJK 副标题在 60px 下需要更宽的行距才不会拥挤，仅局部覆盖 */}
                <span className="mt-3 block text-muted-foreground leading-[1.2]">把灵感整理成可生成的画面</span>
              </h1>

              <p className="mt-8 max-w-xl text-base leading-[1.59] text-muted-foreground">
                从提示词、模型与画幅，到任务队列和作品图库，一次生成经过的每个环节都留在同一条清晰的创作路径里。
              </p>

              <div className="mt-10 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
                <Link
                  href="/login"
                  className="inline-flex min-h-12 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-primary px-6 text-sm font-medium text-foreground-inverse transition-colors hover:bg-primary-hover active:bg-primary-active"
                >
                  开始创作
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
                <Link
                  href="#workflow"
                  className="inline-flex min-h-12 items-center justify-center rounded-[var(--radius-control)] bg-surface-subtle px-6 text-sm font-medium text-foreground transition-colors hover:bg-surface-subtle-strong active:bg-surface-subtle-strong"
                >
                  看看创作流程
                </Link>
              </div>

              <p className="mt-4 text-sm leading-[1.5] text-muted-foreground">
                邮箱验证码登录，也支持 GitHub 与 Google 账号。
              </p>
            </div>

            {/* Console overview — 参数为创作台当前真实可选项 */}
            <aside
              aria-labelledby="console-overview-title"
              className="rounded-[var(--radius-panel)] border border-border bg-surface"
            >
              <div className="flex items-baseline justify-between gap-4 px-6 pb-4 pt-5">
                <h2 id="console-overview-title" className="text-sm font-medium text-foreground">
                  创作台速览
                </h2>
                <span className="font-mono text-xs text-muted-foreground">/generate</span>
              </div>

              <dl className="mx-6 divide-y divide-border border-y border-border">
                {consoleSpecs.map((spec) => (
                  <div key={spec.label} className="grid gap-1 py-4 sm:grid-cols-[5.5rem_1fr] sm:gap-4">
                    <dt className="text-sm text-muted-foreground">{spec.label}</dt>
                    <dd
                      className={`text-sm text-foreground ${spec.mono ? 'font-mono tabular-nums' : 'leading-[1.5]'}`}
                    >
                      {spec.value}
                    </dd>
                  </div>
                ))}
              </dl>

              <p className="px-6 py-4 text-xs leading-[1.5] text-muted-foreground">
                提交前不需要选择风格模板；参考图单张不超过 10&nbsp;MB、合计不超过 20&nbsp;MB。
              </p>
            </aside>
          </div>
        </section>

        {/* Capabilities ledger */}
        <section
          id="capabilities"
          aria-labelledby="capabilities-title"
          className="scroll-mt-24 border-b border-border bg-surface"
        >
          <div className="mx-auto max-w-[1200px] px-4 py-20 sm:px-6 sm:py-24">
            <header className="max-w-3xl">
              <p className="text-sm font-medium text-muted-foreground">产品能力</p>
              <h2
                id="capabilities-title"
                className="mt-3 text-section font-normal leading-[1.35] text-foreground"
              >
                一次生成要经过的环节，都收在同一个工作台里
              </h2>
            </header>

            <ul className="mt-10 grid gap-x-8 md:grid-cols-2 lg:grid-cols-3">
              {capabilities.map((capability) => {
                const Icon = capability.icon
                return (
                  <li key={capability.title} className="border-t border-border py-6">
                    <Icon className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
                    <h3 className="mt-4 text-base font-medium leading-[1.5] text-foreground">{capability.title}</h3>
                    <p className="mt-2 text-sm leading-[1.59] text-muted-foreground">{capability.description}</p>
                  </li>
                )
              })}
            </ul>
          </div>
        </section>

        {/* Workflow */}
        <section id="workflow" aria-labelledby="workflow-title" className="scroll-mt-24 border-b border-border">
          <div className="mx-auto grid max-w-[1200px] gap-12 px-4 py-20 sm:px-6 sm:py-24 lg:grid-cols-[0.75fr_1fr] lg:items-start">
            <div className="max-w-xl">
              <p className="text-sm font-medium text-muted-foreground">创作流程</p>
              <h2 id="workflow-title" className="mt-3 text-section font-normal leading-[1.35] text-foreground">
                不把灵感塞进表单，而是放进流程
              </h2>
              <p className="mt-4 text-base leading-[1.59] text-muted-foreground">
                登录后进入的不是一个功能堆叠的后台，而是一个专注的生成工作区：描述画面、确定输出、回看结果，三步之间没有需要来回搬运的中间状态。
              </p>
            </div>

            <ol className="border-t border-border">
              {workflowSteps.map((step, index) => (
                <li key={step.title} className="grid gap-x-6 gap-y-2 border-b border-border py-8 sm:grid-cols-[56px_1fr]">
                  <span className="font-mono text-sm tabular-nums text-muted-foreground">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div>
                    <h3 className="text-subtitle font-normal leading-[1.4] text-foreground">{step.title}</h3>
                    <p className="mt-2 text-sm leading-[1.59] text-muted-foreground">{step.description}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* CTA */}
        <section aria-labelledby="cta-title" className="bg-surface-subtle px-4 py-16 sm:px-6 sm:py-20">
          <div className="mx-auto flex max-w-[1200px] flex-col items-start justify-between gap-8 md:flex-row md:items-center">
            <div className="max-w-xl">
              <h2 id="cta-title" className="text-section font-normal leading-[1.35] text-foreground">
                准备好让第一段描述成形了吗？
              </h2>
              <p className="mt-3 text-base leading-[1.59] text-muted-foreground">
                登录后即进入创作台：写下提示词、选择画幅与张数，生成的作品会直接出现在你的图库里。
              </p>
            </div>
            <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
              <Link
                href="/login"
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-primary px-6 text-sm font-medium text-foreground-inverse transition-colors hover:bg-primary-hover active:bg-primary-active"
              >
                进入 MuseCanvas
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
              <Link
                href="/terms"
                className="inline-flex min-h-12 items-center justify-center rounded-[var(--radius-control)] px-4 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                先看用户协议
              </Link>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-border bg-surface py-8">
        <div className="mx-auto flex max-w-[1200px] flex-col items-start justify-between gap-4 px-4 sm:flex-row sm:items-center sm:px-6">
          <img
            src="/brand/musecanvas_flow_ribbon_final_pack/03_transparent_trimmed_png/04_monochrome_logo_transparent_trimmed.png"
            alt="MuseCanvas"
            className="h-6 w-auto"
          />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
            <Link href="/terms" className="rounded-[var(--radius-control)] transition-colors hover:text-foreground">
              用户协议
            </Link>
            <Link href="/privacy" className="rounded-[var(--radius-control)] transition-colors hover:text-foreground">
              隐私政策
            </Link>
            <span>&copy; 2026 MuseCanvas</span>
          </div>
        </div>
      </footer>
    </div>
  )
}
