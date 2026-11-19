import type { ReactNode } from 'react'
import Link from 'next/link'
import { ArrowLeftIcon, SparkleIcon } from '@phosphor-icons/react/ssr'

import { FocusedShell } from '@/shared/components/shells'
import { StaticImage } from '@/shared/components/static-image'
import { Badge, Button, Card, iconSize } from '@/shared/components/ui'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'
import { SHOWCASE_ITEMS } from '@/shared/lib/showcase'

/**
 * `(auth)` 路由外壳：基于 `FocusedShell`（56px 极简顶栏 + `BrandMark` + `ThemeToggle`），
 * 桌面端呈现左表单卡片 + 右作品示例双栏，移动端收束为居中单栏。
 * 保持 Server Component：不读 Cookie，会话预检由 `login/page.tsx` 负责。
 */

/** 按画幅比例安排 3 列拼图占位：3:4 与 9:16 占两行，16:9 与 4:3 占两列，1:1 占一格。 */
const COLLAGE_CELLS = [
  { index: 0, className: 'row-span-2' },
  { index: 1, className: 'col-span-2' },
  { index: 2, className: '' },
  { index: 3, className: 'row-span-2' },
  { index: 4, className: 'col-span-2' },
] as const

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <FocusedShell
      maxWidth="split"
      headerRight={
        <Button variant="ghost" size="sm" asChild>
          <Link href={APP_ROUTES.home}>
            <ArrowLeftIcon weight="bold" aria-hidden="true" className={iconSize.sm} />
            <span>返回首页</span>
          </Link>
        </Button>
      }
    >
      <div className="motion-page-enter grid w-full grid-cols-1 items-stretch gap-6 md:grid-cols-[minmax(0,420px)_minmax(0,1fr)] md:gap-8">
        <div className="mx-auto flex w-full max-w-[420px] flex-col justify-center">{children}</div>

        <aside aria-label="作品示例" className="hidden min-w-0 md:flex">
          <Card variant="tonal" density="none" className="min-h-[540px] w-full justify-between gap-4 p-5">
            <div className="flex items-center justify-between gap-3">
              <Badge tone="accent" icon={<SparkleIcon weight="fill" aria-hidden="true" />}>
                MuseCanvas Studio
              </Badge>
              <span className="text-caption font-medium text-muted-foreground">精选画幅与提示词示例</span>
            </div>

            <div className="grid min-h-0 flex-1 auto-rows-[minmax(0,1fr)] grid-cols-3 gap-3">
              {COLLAGE_CELLS.map(({ index, className }) => {
                const item = SHOWCASE_ITEMS[index]
                return (
                  <div
                    key={index}
                    className={cn(
                      'group relative min-h-0 overflow-hidden rounded-card border border-border bg-surface shadow-soft',
                      className,
                    )}
                  >
                    {item?.src ? (
                      <>
                        <StaticImage
                          src={item.src}
                          alt={item.prompt}
                          width={item.width}
                          height={item.height}
                          loading={index === 0 ? 'eager' : 'lazy'}
                          className="h-full w-full object-cover transition-transform duration-[var(--motion-slow)] group-hover:scale-[1.03]"
                        />
                        <div className="pointer-events-none absolute inset-x-2.5 bottom-2.5 flex items-center justify-between gap-2 rounded-control border border-border/70 bg-surface/90 px-2.5 py-1.5 backdrop-blur-md">
                          <span className="truncate text-caption font-medium text-foreground">
                            {item.prompt}
                          </span>
                          <span className="shrink-0 rounded-pill bg-tonal px-1.5 py-0.5 font-mono text-caption tabular-nums text-muted-foreground">
                            {item.label}
                          </span>
                        </div>
                      </>
                    ) : null}
                  </div>
                )
              })}
            </div>

            <p className="text-ui text-muted-foreground">
              多模型协同生图、结构化提示词模板与云端资产库，专为创作者打造。
            </p>
          </Card>
        </aside>
      </div>
    </FocusedShell>
  )
}
