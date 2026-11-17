'use client'

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { ListIcon, XIcon } from '@phosphor-icons/react'
import { useDialog } from '@/shared/hooks/useDialog'
import { buttonVariants } from '@/shared/components/ui/button-variants'
import { iconSize } from '@/shared/components/ui/size'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'

const PANEL_ID = 'public-mobile-nav-panel'

/** 锚点带 `/#`，从 `/terms`、`/privacy` 点进来也能回到首页对应区块。 */
const NAV_ITEMS: { href: string; label: string }[] = [
  { href: '/#works', label: '作品' },
  { href: '/#capabilities', label: '能力' },
  { href: '/#workflow', label: '流程' },
  { href: APP_ROUTES.terms, label: '用户协议' },
  { href: APP_ROUTES.privacy, label: '隐私政策' },
]

const iconBox = 'inline-flex size-11 shrink-0 items-center justify-center rounded-pill'

/**
 * <640px 公共页导航面板（画板 04）。
 *
 * 唯一职责是移动菜单：44px 触发器 + 顶部下拉面板（菜单 / 五个导航项 /
 * 登录与开始创作）。焦点陷阱、Esc、背景滚动锁定与焦点恢复全部交给
 * `useDialog`，面板入场/退场复用 globals.css 的下滑关键帧，不新增动画。
 */
export function PublicMobileNav() {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const { mounted, phase, labelId, closeButtonRef, portalTarget, overlayProps, dialogProps } = useDialog({
    open,
    onClose: close,
  })

  // 视口放大到桌面断点时丢弃打开状态，避免下次回到窄屏时旧面板复活。
  useEffect(() => {
    if (!open) return
    const query = window.matchMedia('(min-width: 40rem)')
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) setOpen(false)
    }
    if (query.matches) setOpen(false)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [open])

  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={PANEL_ID}
        aria-label={open ? '关闭导航菜单' : '打开导航菜单'}
        onClick={() => setOpen((value) => !value)}
        className={cn(iconBox, 'text-foreground hover:bg-tonal-hover active:bg-tonal-active motion-press sm:hidden')}
      >
        {open ? (
          <XIcon weight="bold" aria-hidden="true" className={iconSize.md} />
        ) : (
          <ListIcon weight="bold" aria-hidden="true" className={iconSize.md} />
        )}
      </button>

      {mounted && portalTarget
        ? createPortal(
            <div
              {...overlayProps}
              className={cn('fixed inset-0 z-modal sm:hidden', phase === 'exit' ? 'motion-fade-out' : 'motion-fade-in')}
            >
              <div aria-hidden="true" onClick={close} className="absolute inset-0 bg-overlay/40 backdrop-blur-xs dark:bg-overlay/55" />
              <div
                {...dialogProps}
                id={PANEL_ID}
                className={cn(
                  'absolute inset-x-0 top-0 rounded-b-panel border-b border-border bg-surface px-4 pb-6 shadow-modal',
                  phase === 'exit' ? 'motion-toast-out' : 'motion-toast-in',
                )}
              >
                <div className="flex h-[var(--layout-public-header)] items-center justify-between">
                  <h2 id={labelId} className="text-compact font-medium text-muted-foreground">
                    菜单
                  </h2>
                  <button
                    ref={closeButtonRef}
                    type="button"
                    aria-label="关闭导航菜单"
                    onClick={close}
                    className={cn(iconBox, 'text-foreground hover:bg-tonal-hover active:bg-tonal-active motion-press')}
                  >
                    <XIcon weight="bold" aria-hidden="true" className={iconSize.md} />
                  </button>
                </div>

                <nav aria-label="移动导航">
                  <ul className="m-0 flex list-none flex-col p-0">
                    {NAV_ITEMS.map((item) => (
                      <li key={item.href} className="border-b border-border last:border-b-0">
                        <Link
                          href={item.href}
                          onClick={close}
                          className="flex min-h-[var(--control-lg)] items-center text-copy font-medium text-foreground transition-colors hover:text-accent"
                        >
                          {item.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </nav>

                <div className="mt-5 flex gap-3">
                  <Link
                    href={APP_ROUTES.login}
                    onClick={close}
                    className={cn(
                      buttonVariants({ variant: 'secondary', size: 'lg' }),
                      'flex-1 rounded-pill max-sm:min-h-[var(--control-lg)]',
                    )}
                  >
                    登录
                  </Link>
                  <Link
                    href={APP_ROUTES.generate}
                    onClick={close}
                    className={cn(
                      buttonVariants({ variant: 'primary', size: 'lg' }),
                      'flex-1 rounded-pill max-sm:min-h-[var(--control-lg)]',
                    )}
                  >
                    开始创作
                  </Link>
                </div>
              </div>
            </div>,
            portalTarget,
          )
        : null}
    </>
  )
}
