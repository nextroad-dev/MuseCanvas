import {
  ArrowsOutSimpleIcon,
  CubeIcon,
  ImageSquareIcon,
  ListChecksIcon,
} from '@phosphor-icons/react/ssr'
import type { Icon as PhosphorIcon } from '@phosphor-icons/react'
import { Reveal } from '@/shared/components/reveal'
import { iconSize } from '@/shared/components/ui/size'
import { LandingFrame } from './landing-frame'

interface Feature {
  icon: PhosphorIcon
  title: string
  description: string
}

const FEATURES: Feature[] = [
  { icon: CubeIcon, title: '随时换新模型', description: '管理员在后台添加后，马上就能用。' },
  { icon: ArrowsOutSimpleIcon, title: '画面比例自动匹配', description: '换了模型，可选的比例和张数会跟着变。' },
  { icon: ImageSquareIcon, title: '可以上传参考图', description: '用参考图定下构图和风格。' },
  { icon: ListChecksIcon, title: '进度随时可查', description: '排队、生成、保存，每一步都有提示。' },
]

/**
 * 平台特性条：白底、上下 hairline、4 列 duotone 图标 + 标题 + 说明，
 * 列与列之间一条 1px 竖线；<1280px 折成 2 列，窄屏单列。
 */
export function FeaturesStrip() {
  return (
    <section aria-label="平台特性" className="border-y border-border bg-surface">
      <Reveal>
        <LandingFrame>
          <ul className="m-0 grid list-none grid-cols-1 divide-y divide-border p-0 sm:grid-cols-2 lg:grid-cols-4 lg:divide-x lg:divide-y-0">
            {FEATURES.map(({ icon: FeatureIcon, title, description }) => (
              <li key={title} className="flex flex-col gap-3.5 py-8 sm:py-10 lg:px-7 lg:first:pl-0 lg:last:pr-0">
                <span className="inline-flex size-10 items-center justify-center rounded-control bg-accent-soft text-accent">
                  <FeatureIcon weight="duotone" aria-hidden="true" className={iconSize.md} />
                </span>
                <h3 className="text-subtitle font-medium text-foreground">{title}</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
              </li>
            ))}
          </ul>
        </LandingFrame>
      </Reveal>
    </section>
  )
}
