import type { ReactNode } from 'react'

export interface SetupStepShellProps {
  headingId: string
  title: string
  description?: string
  /** 右上角状态徽标（已完成 / 已验证 / 待修复…）。 */
  status?: ReactNode
  children: ReactNode
}

/**
 * 向导每一步的白卡外框：`rounded-panel` + `shadow-soft`（安装向导的卡片口径）。
 * 标题层级用 `h2`（页面 `h1` 在 PageHeader 上），说明文字统一 `text-muted-foreground`。
 */
export function SetupStepShell({ headingId, title, description, status, children }: SetupStepShellProps) {
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-6 rounded-panel bg-surface p-6 text-foreground shadow-soft md:p-8"
    >
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={headingId} className="text-module">
            {title}
          </h2>
          {description ? (
            <p className="max-w-reading text-sm text-muted-foreground [text-wrap:pretty]">{description}</p>
          ) : null}
        </div>
        {status ? <div className="flex shrink-0 items-center gap-2">{status}</div> : null}
      </header>
      <div className="flex min-w-0 flex-col gap-5">{children}</div>
    </section>
  )
}
