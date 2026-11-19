import type { ReactNode } from 'react'
import { ArrowUpIcon, FlowArrowIcon } from '@phosphor-icons/react/ssr'
import { Reveal } from '@/shared/components/reveal'
import { Badge, Card, SectionHeader, controlSquare, iconSize } from '@/shared/components/ui'
import { SHOWCASE_ITEMS } from '@/shared/lib/showcase'
import { cn } from '@/shared/lib/cn'
import { LandingFrame } from './landing-frame'
import { ShowcaseFrame } from './showcase-frame'

const INPUT_IMAGE = SHOWCASE_ITEMS.find((item) => item.file === 'ratio-3x4.webp')
const RESULT_IMAGES = SHOWCASE_ITEMS.slice(0, 5)

const mockLabel = 'text-overline text-muted-foreground'
const mockChip = 'rounded-pill bg-tonal px-2.5 py-0.5 text-foreground'
const mockChipActive = 'rounded-pill bg-accent-soft px-2.5 py-0.5 font-medium text-accent'

/** 步骤一：输入框 + 参考图 + 发送按钮示意。 */
function PromptMock() {
  return (
    <Card variant="surface" density="compact" className="gap-3.5">
      <p className="m-0 text-sm leading-relaxed text-foreground">
        清晨的江南水乡，薄雾笼罩水面，一艘乌篷船停在青石台阶旁，柔和逆光，胶片质感
      </p>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {INPUT_IMAGE ? (
            <ShowcaseFrame
              file={INPUT_IMAGE.file}
              label={INPUT_IMAGE.label}
              decorative
              className={cn(controlSquare.sm, 'shrink-0 rounded-control')}
            />
          ) : (
            <span aria-hidden="true" className={cn(controlSquare.sm, 'shrink-0 rounded-control bg-tonal')} />
          )}
          <span className="text-xs text-muted-foreground">参考图 1/4</span>
        </div>
        <span
          className={cn(
            'inline-flex items-center justify-center rounded-control bg-primary text-on-primary',
            controlSquare.sm,
          )}
        >
          <ArrowUpIcon weight="bold" aria-hidden="true" className={iconSize.sm} />
        </span>
      </div>
    </Card>
  )
}

/** 步骤二：模型 / 画幅 / 张数参数面板示意。 */
function ParamsMock() {
  return (
    <Card variant="surface" density="compact" className="gap-3.5">
      <div className="flex flex-col gap-1.5">
        <span className={mockLabel}>模型</span>
        <div className="flex gap-1 rounded-control bg-tonal p-1 text-xs">
          <span className="flex-1 rounded-control bg-surface px-2 py-1 text-center font-medium shadow-soft">
            图像 · 默认模型
          </span>
          <span className="flex-1 rounded-control px-2 py-1 text-center text-muted-foreground">视频</span>
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
          <span className={mockChip}>2</span>
          <span className={mockChip}>4</span>
        </div>
      </div>
    </Card>
  )
}

/** 步骤三：六宫格结果 + 一张生成中占位示意。 */
function ResultsMock() {
  return (
    <div className="grid h-full grid-cols-3 grid-rows-2 gap-2">
      {RESULT_IMAGES.map((item, index) => (
        <ShowcaseFrame
          key={item.file}
          file={item.file}
          label={item.label}
          decorative
          className={cn(
            'size-full rounded-control border border-border',
            index === 2 && 'ring-2 ring-accent ring-offset-2 ring-offset-canvas',
          )}
        />
      ))}
      <span className="flex items-center justify-center rounded-control border border-dashed border-border-control bg-surface font-mono text-overline text-muted-foreground">
        生成中
      </span>
    </div>
  )
}

interface WorkflowStep {
  step: string
  title: string
  description: string
  mock: ReactNode
}

const STEPS: WorkflowStep[] = [
  { step: '01', title: '写下画面', description: '用文字写下想要的画面，也可以上传一张参考图。', mock: <PromptMock /> },
  { step: '02', title: '选好参数', description: '选择模型、画面比例和张数，点发送即可。', mock: <ParamsMock /> },
  { step: '03', title: '拿到作品', description: '画好的图自动存进图库，可以放大、下载或删除。', mock: <ResultsMock /> },
]

/**
 * 流程区：白底 section，三步编号卡片 + 上方纯展示示意块。
 * 示意块设置 `aria-hidden`，辅助技术仅朗读步骤编号、标题与说明。
 */
export function Workflow() {
  return (
    <Reveal>
      <section id="workflow" aria-labelledby="flow-title" className="scroll-mt-20 border-t border-border bg-surface">
        <LandingFrame className="flex flex-col gap-12 py-20 md:py-28">
          <div className="flex flex-col gap-4">
            <div>
              <Badge
                tone="accent"
                variant="soft"
                icon={<FlowArrowIcon weight="duotone" />}
                className="gap-1.5 px-3 py-1 text-caption"
              >
                工作流程
              </Badge>
            </div>
            <SectionHeader
              id="flow-title"
              title={<span className="block font-display text-headline text-foreground">流程</span>}
              description="三步，出图。任务提交后自动排队生成，进度可随时查看。"
            />
          </div>

          <ol className="m-0 grid list-none grid-cols-1 gap-6 p-0 sm:grid-cols-2 lg:grid-cols-3">
            {STEPS.map((step) => (
              <li key={step.title} className="flex">
                <Card
                  variant="outline"
                  density="none"
                  className="w-full gap-6 rounded-panel bg-canvas p-5 transition-[transform,box-shadow] duration-[var(--motion-base)] ease-out hover:-translate-y-0.5 hover:shadow-soft"
                >
                  <div aria-hidden="true" className="flex h-60 flex-col justify-center">
                    {step.mock}
                  </div>
                  <div className="flex flex-col items-start gap-2.5 px-1">
                    <Badge tone="accent" variant="soft" className="font-mono text-caption">
                      STEP {step.step}
                    </Badge>
                    <h3 className="m-0 font-display text-statement text-foreground">{step.title}</h3>
                    <p className="m-0 text-sm leading-relaxed text-muted-foreground">{step.description}</p>
                  </div>
                </Card>
              </li>
            ))}
          </ol>
        </LandingFrame>
      </section>
    </Reveal>
  )
}
