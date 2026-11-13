import type { ReactNode } from 'react'
import { ArrowUpIcon } from '@phosphor-icons/react/ssr'
import { Reveal } from '@/shared/components/reveal'
import { SHOWCASE_ITEMS } from '@/shared/lib/showcase'
import { cn } from '@/shared/lib/cn'
import { LandingFrame } from './landing-frame'
import { ShowcaseFrame } from './showcase-frame'

const INPUT_IMAGE = SHOWCASE_ITEMS.find((item) => item.file === 'ratio-3x4.webp')
const RESULT_IMAGES = SHOWCASE_ITEMS.slice(0, 5)

/** 参数 mock 里的小标签（11px 大写字距）。 */
const mockLabel = 'text-overline text-foreground/80'

/** 参数 mock 里的胶囊选项。 */
const mockChip = 'rounded-[6px] bg-tonal px-2 py-1'
const mockChipActive = 'rounded-[6px] bg-primary px-2 py-1 text-on-primary'

/** 步骤一：输入框 + 参考图 + 发送按钮的示意。 */
function PromptMock() {
  return (
    <div className="flex flex-col gap-3.5 rounded-[12px] bg-surface p-4 shadow-floating">
      <p className="m-0 text-sm text-foreground">
        清晨的江南水乡，薄雾笼罩水面，一艘乌篷船停在青石台阶旁，柔和逆光，胶片质感
      </p>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {INPUT_IMAGE ? (
            <ShowcaseFrame
              file={INPUT_IMAGE.file}
              label={INPUT_IMAGE.label}
              decorative
              sizes="32px"
              className="size-8 shrink-0 rounded-[6px]"
            />
          ) : (
            <span aria-hidden="true" className="size-8 shrink-0 rounded-[6px] bg-tonal" />
          )}
          <span className="text-xs text-foreground/80">参考图 1/4</span>
        </div>
        <span className="inline-flex size-8 items-center justify-center rounded-[8px] bg-primary text-on-primary">
          <ArrowUpIcon weight="bold" aria-hidden="true" className="size-[14px]" />
        </span>
      </div>
    </div>
  )
}

/** 步骤二：模型 / 画幅 / 张数参数面板的示意。 */
function ParamsMock() {
  return (
    <div className="flex flex-col gap-3.5 rounded-[12px] bg-surface p-4 shadow-floating">
      <div className="flex flex-col gap-1.5">
        <span className={mockLabel}>模型</span>
        <div className="flex gap-1 rounded-[8px] bg-tonal p-[3px] text-xs">
          <span className="flex-1 rounded-[6px] bg-surface px-1.5 py-1 text-center shadow-soft">图像 · 默认模型</span>
          <span className="flex-1 rounded-[6px] px-1.5 py-1 text-center text-foreground/80">视频</span>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className={mockLabel}>画幅</span>
        <div className="flex flex-wrap gap-1.5 font-mono text-xs">
          <span className={mockChip}>1:1</span>
          <span className={mockChip}>16:9</span>
          <span className={mockChip}>9:16</span>
          <span className={mockChip}>4:3</span>
          <span className={mockChipActive}>3:4</span>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className={mockLabel}>张数</span>
        <div className="flex gap-1.5 font-mono text-xs">
          <span className={mockChipActive}>1</span>
          <span className={cn(mockChip, 'px-2.5')}>2</span>
          <span className={cn(mockChip, 'px-2.5')}>4</span>
        </div>
      </div>
    </div>
  )
}

/** 步骤三：六宫格结果 + 一张生成中的示意。 */
function ResultsMock() {
  return (
    <div className="grid h-full grid-cols-3 grid-rows-2 gap-2">
      {RESULT_IMAGES.map((item, index) => (
        <ShowcaseFrame
          key={item.file}
          file={item.file}
          label={item.label}
          decorative
          sizes="(min-width: 960px) 120px, 30vw"
          className={cn('size-full rounded-[4px]', index === 2 && 'outline-2 outline-offset-2 outline-foreground')}
        />
      ))}
      <span className="flex items-center justify-center rounded-[4px] border border-dashed border-border-control font-mono text-overline text-foreground/80">
        生成中
      </span>
    </div>
  )
}

interface WorkflowStep {
  title: string
  description: string
  mock: ReactNode
}

const STEPS: WorkflowStep[] = [
  { title: '写下画面', description: '用文字写下想要的画面，也可以上传一张参考图。', mock: <PromptMock /> },
  { title: '选好参数', description: '选择模型、画面比例和张数，点发送即可。', mock: <ParamsMock /> },
  { title: '拿到作品', description: '画好的图自动存进图库，可以放大、下载或删除。', mock: <ResultsMock /> },
]

/**
 * 流程区（画板 01）：白底 section，衬线「流程 / 三步，出图」，三列卡片。
 * 每列上方 260px 高的示意块（输入框 / 参数面板 / 结果九宫格），下方 28px 衬线标题。
 * 示意块是纯展示，整块 aria-hidden，读屏只读标题与说明。
 */
export function Workflow() {
  return (
    <Reveal>
      <section id="workflow" aria-labelledby="flow-title" className="scroll-mt-20 border-t border-border bg-surface">
        <LandingFrame className="flex flex-col gap-14 py-20 md:py-32">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div className="flex flex-col gap-4">
              <h2 id="flow-title" className="font-display text-headline text-foreground">
                流程
              </h2>
              <p className="font-display text-section font-medium text-foreground/80">三步，出图</p>
            </div>
            <p className="m-0 max-w-[400px] text-module font-normal text-foreground/80">
              任务提交后自动排队生成，进度可随时查看。
            </p>
          </div>

          <ol className="m-0 grid list-none grid-cols-1 gap-8 p-0 sm:grid-cols-2 lg:grid-cols-3">
            {STEPS.map((step) => (
              <li key={step.title} className="flex flex-col gap-6">
                <div
                  aria-hidden="true"
                  className="flex h-[260px] flex-col justify-center rounded-[6px] border border-border bg-canvas p-6"
                >
                  {step.mock}
                </div>
                <div className="flex flex-col gap-2">
                  <h3 className="font-display text-statement font-semibold text-foreground">{step.title}</h3>
                  <p className="text-copy text-foreground/80">{step.description}</p>
                </div>
              </li>
            ))}
          </ol>
        </LandingFrame>
      </section>
    </Reveal>
  )
}
