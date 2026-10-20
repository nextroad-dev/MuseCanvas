import type { ReactNode } from 'react'
import { LandingFrame } from '@/features/landing/components/landing-frame'
import { cn } from '@/shared/lib/cn'

/** Icon glyphs from the mock: stroked 24px line art in the current text colour. */
const icon = (children: ReactNode) => (
  <svg
    aria-hidden="true"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="shrink-0 text-foreground"
  >
    {children}
  </svg>
)

const PLATFORM_FEATURES: { title: string; description: string; icon: ReactNode }[] = [
  {
    title: '随时换新模型',
    description: '管理员在后台添加后，马上就能用。',
    icon: icon(
      <>
        <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
        <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
      </>,
    ),
  },
  {
    title: '画面比例自动匹配',
    description: '换了模型，可选的比例和张数会跟着变。',
    icon: icon(
      <>
        <rect x="3" y="6" width="8" height="12" rx="1.5" />
        <rect x="13" y="9" width="8" height="6" rx="1.5" />
      </>,
    ),
  },
  {
    title: '可以上传参考图',
    description: '用参考图定下构图和风格。',
    icon: icon(
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="9" cy="10" r="2" />
        <path d="M21 16l-5-5-9 9" />
      </>,
    ),
  },
  {
    title: '进度随时可查',
    description: '排队、生成、保存，每一步都有提示。',
    icon: icon(<path d="M4 6h16M4 12h16M4 18h10" />),
  },
]

/** Platform strip: four features on a surface band, hairline-divided (stacked below `lg`). */
export function PlatformStrip() {
  return (
    <section aria-label="平台特性" className="border-y border-border bg-surface">
      <LandingFrame>
        <ul className="grid lg:grid-cols-4">
          {PLATFORM_FEATURES.map((feature, index) => (
            <li
              key={feature.title}
              className={cn(
                'flex flex-col gap-3.5 py-10',
                index > 0 && 'border-t border-border lg:border-l lg:border-t-0 lg:px-7',
                index === 0 && 'lg:pr-7',
              )}
            >
              {feature.icon}
              <h3 className="text-xl font-medium leading-[1.4] text-foreground">{feature.title}</h3>
              <p className="text-base leading-[1.7] text-foreground/85">{feature.description}</p>
            </li>
          ))}
        </ul>
      </LandingFrame>
    </section>
  )
}
