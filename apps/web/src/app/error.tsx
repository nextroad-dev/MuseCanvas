'use client'

import Link from 'next/link'
import { useEffect } from 'react'
import {
  ArrowClockwiseIcon,
  ArrowRightIcon,
  HouseIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react'

import { FocusedShell } from '@/shared/components/shells'
import { Badge, Button, Card, controlSquare, iconSize } from '@/shared/components/ui'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'

/**
 * 路由级错误边界（`app/error.tsx`）：保留根布局与设计 token，仅替换出错路由段。
 * 不暴露内部堆栈；`digest` 仅作为运维排查日志的引用编号。
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[app] route error:', error)
  }, [error])

  return (
    <FocusedShell maxWidth="narrow">
      <Card density="none" className="motion-page-enter items-center gap-6 p-7 text-center sm:p-8">
        <div
          className={cn(
            'inline-flex items-center justify-center rounded-card border border-danger-border bg-danger-soft text-danger',
            controlSquare.lg,
          )}
        >
          <WarningCircleIcon weight="duotone" aria-hidden="true" className={iconSize.lg} />
        </div>

        <div className="flex flex-col items-center gap-2.5">
          <Badge tone="danger">页面异常</Badge>
          <h1 className="text-title text-foreground">页面没能按预期加载</h1>
          <p className="text-sm text-muted-foreground">
            可以先重试一次。如果问题持续出现，请将页面路径、时间与下方错误编号告知管理员。
          </p>
          {error.digest ? (
            <p className="mt-1 rounded-pill border border-border bg-tonal px-3 py-1 font-mono text-caption tabular-nums text-muted-foreground">
              错误编号 · {error.digest}
            </p>
          ) : null}
        </div>

        <div className="flex w-full flex-col gap-2.5">
          <div className="flex flex-wrap items-center justify-center gap-2.5">
            <Button
              onClick={reset}
              leadingIcon={<ArrowClockwiseIcon weight="bold" aria-hidden="true" />}
            >
              重试
            </Button>
            <Button variant="outline" asChild>
              <Link href={APP_ROUTES.home}>
                <HouseIcon weight="duotone" aria-hidden="true" className={iconSize.sm} />
                <span>返回首页</span>
              </Link>
            </Button>
          </div>
          <Button variant="ghost" size="sm" asChild className="self-center text-muted-foreground">
            <Link href={APP_ROUTES.generate}>
              <span>前往创作台</span>
              <ArrowRightIcon weight="bold" aria-hidden="true" className={iconSize.sm} />
            </Link>
          </Button>
        </div>
      </Card>
    </FocusedShell>
  )
}
