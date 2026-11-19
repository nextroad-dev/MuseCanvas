'use client'

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { ListIcon, XIcon } from '@phosphor-icons/react'
import { useDialog } from '@/shared/hooks/useDialog'
import { buttonVariants } from '@/shared/components/ui/button-variants'
import { controlSquare, iconSize } from '@/shared/components/ui/size'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'

const PANEL_ID = 'public-mobile-nav-panel'

const NAV_ITEMS: { href: string; label: string }[] = [
  { href: APP_ROUTES.home ?? '/', label: '首页' },
  { href: APP_ROUTES.terms, label: '服务条款' },
  { href: APP_ROUTES.privacy, label: '隐私政策' },
]

const iconBox = cn('inline-flex shrink-0 items-center justify-center rounded-control', controlSquare.lg)

/**
 * 移动端公共导航抽屉（<640px）。
 * 焦点陷阱、Esc、滚动锁定与焦点恢复统一委托给 `useDialog`。
 */
export function PublicMobileNav() {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const { mounted, phase, labelId, closeButtonRef, portalTarget, overlayProps, dialogProps } = useDialog({
    open,
    onClose: close,
  })

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
        className={cn(iconBox, 'text-foreground hover:bg-tonal active:bg-tonal-active motion-press sm:hidden')}
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
              <div
                aria-hidden="true"
                onClick={close}
                className="absolute inset-0 bg-overlay/40 backdrop-blur-xs dark:bg-overlay/55"
              />
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
                    className={cn(iconBox, 'text-foreground hover:bg-tonal active:bg-tonal-active motion-press')}
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
                          className="flex min-h-[var(--control-lg)] items-center text-base font-medium text-foreground transition-colors hover:text-accent"
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
                    className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'flex-1')}
                  >
                    登录
                  </Link>
                  <Link
                    href={APP_ROUTES.generate}
                    onClick={close}
                    className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'flex-1')}
                  >
                    进入工作台
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
