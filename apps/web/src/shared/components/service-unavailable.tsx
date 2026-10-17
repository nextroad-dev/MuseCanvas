'use client'

import { cn } from '@/shared/lib/cn'

export interface ServiceUnavailableProps {
  mode?: 'page' | 'inline'
}

/**
 * Upstream-unavailable page state, rendered from the server layouts whenever the
 * session call answers `UPSTREAM_UNAVAILABLE`.
 *
 * Supports both full-page error view (`mode="page"`) and embedding inside focused layouts (`mode="inline"`).
 */
export function ServiceUnavailable({ mode = 'page' }: ServiceUnavailableProps) {
  const retry = () => window.location.reload()

  const card = (
    <div className={cn('w-full max-w-dialog-narrow text-center', mode === 'page' && 'rounded-card bg-surface p-8 shadow-soft')}>
      <h1 className="text-module font-normal">服务暂时不可用</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        暂时无法连接 MuseCanvas 服务，可能正在启动或维护中，请稍后重试。
      </p>
      <button
        type="button"
        onClick={retry}
        className="mt-6 inline-flex min-h-[var(--control-md)] items-center justify-center rounded-control bg-primary px-4 text-sm font-medium text-on-primary hover:bg-primary-hover active:bg-primary-active motion-press"
      >
        刷新重试
      </button>
    </div>
  )

  if (mode === 'inline') {
    return card
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas p-4 text-foreground sm:p-8">
      {card}
    </main>
  )
}
