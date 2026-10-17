'use client'

import Link from 'next/link'
import { useEffect } from 'react'
import { ContentFrame } from '@/shared/components/content-frame'
import { Button, EmptyState } from '@/shared/components/ui'
import { buttonVariants } from '@/shared/components/ui/button-variants'

/**
 * Route-level error boundary. It catches render errors below the root layout;
 * a failure inside the root layout itself is handled by `global-error.tsx`.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <ContentFrame className="motion-page-enter flex flex-col justify-center py-6 md:py-8">
      <EmptyState
        variant="error"
        title="页面出了点问题"
        description="页面在显示时遇到了意外错误。可以先重试一次；如果仍然失败，请返回首页后再继续。"
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button onClick={() => reset()}>重试</Button>
            <Link href="/" className={buttonVariants({ variant: 'secondary' })}>
              返回首页
            </Link>
          </div>
        }
      >
        {error.digest ? <p className="text-xs text-muted-foreground">错误编号：{error.digest}</p> : null}
      </EmptyState>
    </ContentFrame>
  )
}
