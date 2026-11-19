import {
  ArrowsOutSimpleIcon,
  CubeIcon,
  ImageSquareIcon,
  ListChecksIcon,
} from '@phosphor-icons/react/ssr'
import type { Icon as PhosphorIcon } from '@phosphor-icons/react'
import { Reveal } from '@/shared/components/reveal'
import { controlSquare, iconSize } from '@/shared/components/ui'
import { cn } from '@/shared/lib/cn'
import { LandingFrame } from './landing-frame'

interface Feature {
  index: string
  icon: PhosphorIcon
  title: string
  description: string
}

const FEATURES: Feature[] = [
  { index: '01', icon: CubeIcon, title: '随时换新模型', description: '管理员在后台添加后，马上就能用。' },
  { index: '02', icon: ArrowsOutSimpleIcon, title: '画面比例自动匹配', description: '换了模型，可选的比例和张数会跟着变。' },
  { index: '03', icon: ImageSquareIcon, title: '可以上传参考图', description: '用参考图定下构图和风格。' },
  { index: '04', icon: ListChecksIcon, title: '进度随时可查', description: '排队、生成、保存，每一步都有提示。' },
]

/**
 * 平台特性条：白底表面 + 上下 1px hairline 分隔 + 4 列图标特性。
 */
export function FeaturesStrip() {
  return (
    <section aria-label="平台特性" className="border-y border-border bg-surface">
      <Reveal>
        <LandingFrame>
          <ul className="m-0 grid list-none grid-cols-1 divide-y divide-border p-0 sm:grid-cols-2 lg:grid-cols-4 lg:divide-x lg:divide-y-0">
            {FEATURES.map(({ index, icon: FeatureIcon, title, description }) => (
              <li key={title} className="flex flex-col gap-3.5 py-8 sm:py-10 lg:px-7 lg:first:pl-0 lg:last:pr-0">
                <div className="flex items-center justify-between gap-3">
                  <span
                    className={cn(
                      'inline-flex items-center justify-center rounded-control bg-accent-soft text-accent',
                      controlSquare.md,
                    )}
                  >
                    <FeatureIcon weight="duotone" aria-hidden="true" className={iconSize.md} />
                  </span>
                  <span aria-hidden="true" className="font-mono text-caption text-decorative-muted">
                    {index}
                  </span>
                </div>
                <h3 className="m-0 text-subtitle font-medium text-foreground">{title}</h3>
                <p className="m-0 text-sm leading-relaxed text-muted-foreground">{description}</p>
              </li>
            ))}
          </ul>
        </LandingFrame>
      </Reveal>
    </section>
  )
}
