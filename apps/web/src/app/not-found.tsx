import Link from 'next/link'
import { ArrowRightIcon, CompassIcon, HouseIcon } from '@phosphor-icons/react/ssr'

import { FocusedShell } from '@/shared/components/shells'
import { Badge, Button, Card, controlSquare, iconSize } from '@/shared/components/ui'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'

/** 404 页面：纯服务端渲染，无 JS 时仍可直接导航离开。 */
export default function NotFound() {
  return (
    <FocusedShell maxWidth="narrow">
      <Card density="none" className="motion-page-enter items-center gap-6 p-7 text-center sm:p-8">
        <div
          className={cn(
            'inline-flex items-center justify-center rounded-card border border-border bg-accent-soft text-accent',
            controlSquare.lg,
          )}
        >
          <CompassIcon weight="duotone" aria-hidden="true" className={iconSize.lg} />
        </div>

        <div className="flex flex-col items-center gap-2.5">
          <Badge tone="accent" className="font-mono">
            404
          </Badge>
          <h1 className="text-title text-foreground">没有找到这个页面</h1>
          <p className="text-sm text-muted-foreground">
            链接可能已经失效，或者页面已被移动。你可以返回首页，或直接进入创作台继续。
          </p>
        </div>

        <div className="flex w-full flex-wrap items-center justify-center gap-2.5">
          <Button asChild>
            <Link href={APP_ROUTES.home}>
              <HouseIcon weight="duotone" aria-hidden="true" className={iconSize.sm} />
              <span>返回首页</span>
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href={APP_ROUTES.generate}>
              <span>进入创作台</span>
              <ArrowRightIcon weight="bold" aria-hidden="true" className={iconSize.sm} />
            </Link>
          </Button>
        </div>
      </Card>
    </FocusedShell>
  )
}
