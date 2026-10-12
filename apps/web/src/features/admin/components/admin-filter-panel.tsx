'use client'

import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/shared/components/ui'
import { cn } from '@/shared/lib/cn'
import { adminTouchTargets } from '../lib/admin-layout'

export function AdminFilterPanel({ children, activeCount, summary }: { children: ReactNode; activeCount: number; summary?: ReactNode }) {
  const [expanded, setExpanded] = useState(false)
  const panelId = useId()
  return <section className={cn('flex min-w-0 flex-col gap-3', adminTouchTargets)} aria-label="列表筛选">
    <Button variant="secondary" size="lg" className="@min-[640px]/admin:hidden" aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded((previous) => !previous)}>
      筛选{activeCount ? `（已选 ${activeCount} 项）` : ''}
    </Button>
    {activeCount > 0 && summary && <p className="min-w-0 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">已应用：{summary}</p>}
    <div id={panelId} className={cn('min-w-0 @min-[640px]/admin:block', !expanded && 'hidden')}>{children}</div>
  </section>
}
