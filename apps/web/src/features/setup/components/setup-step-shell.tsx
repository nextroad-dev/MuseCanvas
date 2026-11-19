'use client'

import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'

import { Badge, Card } from '@/shared/components/ui'

export interface SetupStepContextValue {
  stepPosition: string
  complete: boolean
  footer: ReactNode
}

const SetupStepContext = createContext<SetupStepContextValue | null>(null)

export interface SetupStepProviderProps extends SetupStepContextValue {
  children: ReactNode
}

export function SetupStepProvider({ stepPosition, complete, footer, children }: SetupStepProviderProps) {
  return (
    <SetupStepContext.Provider value={{ stepPosition, complete, footer }}>
      {children}
    </SetupStepContext.Provider>
  )
}

export interface SetupStepShellProps {
  headingId: string
  title: string
  description?: string
  /** 可选覆盖步骤位置文案（默认从 `SetupStepProvider` 读取 `第 N / M 步`）。 */
  stepPosition?: string
  /** 右上角状态徽标（已完成 / 已验证 / 待修复…）。未传且当前步已完成时默认显示「已完成」。 */
  status?: ReactNode
  /** 可选覆盖底部导航栏（默认从 `SetupStepProvider` 读取统一底部导航栏）。 */
  footer?: ReactNode
  children: ReactNode
}

/**
 * 向导每一步的统一白卡容器：基于 `Card`（1px `border-border`、`rounded-card`、`shadow-soft`）。
 * 顶部内置轻量步骤计数与状态徽标 + 步骤标题（`h1`）与说明；底部承载统一导航栏。
 */
export function SetupStepShell({
  headingId,
  title,
  description,
  stepPosition,
  status,
  footer,
  children,
}: SetupStepShellProps) {
  const ctx = useContext(SetupStepContext)
  const resolvedPosition = stepPosition ?? ctx?.stepPosition
  const resolvedStatus =
    status !== undefined ? status : ctx?.complete ? <Badge tone="success">已完成</Badge> : null
  const resolvedFooter = footer !== undefined ? footer : ctx?.footer

  return (
    <Card variant="surface" density="none" role="region" aria-labelledby={headingId} className="min-w-0">
      <header className="flex flex-col gap-2 border-b border-border/70 px-5 pb-4 pt-5 sm:px-6 sm:pb-5 sm:pt-6">
        {resolvedPosition || resolvedStatus ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            {resolvedPosition ? (
              <span className="font-mono text-xs tabular-nums text-muted-foreground">{resolvedPosition}</span>
            ) : (
              <span />
            )}
            {resolvedStatus ? <div className="flex shrink-0 items-center gap-2">{resolvedStatus}</div> : null}
          </div>
        ) : null}

        <div className="flex min-w-0 flex-col gap-1">
          <h1 id={headingId} className="text-subtitle font-medium tracking-tight text-foreground">
            {title}
          </h1>
          {description ? (
            <p className="text-sm text-muted-foreground [text-wrap:pretty]">{description}</p>
          ) : null}
        </div>
      </header>

      <div className="flex min-w-0 flex-col gap-5 px-5 py-5 sm:px-6 sm:py-6">{children}</div>

      {resolvedFooter ? (
        <div className="border-t border-border/70 px-5 py-4 sm:px-6">{resolvedFooter}</div>
      ) : null}
    </Card>
  )
}
