'use client'

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { useDialog } from '@/shared/hooks/useDialog'
import { buttonVariants } from '@/shared/components/ui/button-variants'
import { iconSize } from '@/shared/components/ui/size'
import { cn } from '@/shared/lib/cn'

/**
 * Mobile navigation for the public pages (`/`, `/terms`, `/privacy`).
 *
 * The smallest possible client island: the server-rendered `PublicHeader` owns
 * the desktop navigation, this component only adds the <640px menu button and
 * the top drop-down panel. Trigger is `sm:hidden`, so it never renders on
 * desktop widths (a `matchMedia` effect below also closes the panel if the
 * viewport grows while it is open).
 *
 * Motion reuses the existing top-drop keyframes (`mc-slide-in-down` /
 * `mc-slide-out-down`) through the `.motion-toast-in` / `.motion-toast-out`
 * utilities — no new keyframes, no `motion` dependency. Note `useDialog` only
 * matches its own enter/exit animation names for the `animationend` fast path,
 * so the exit here unmounts through its backstop timer instead; the lifecycle
 * (`enter -> close -> unmounted`) and the focus trap / Escape / scroll lock
 * from `modalStack` are unaffected.
 */

const panelId = 'public-mobile-nav-panel'

/** Anchors use `/#…` so they work from `/terms` and `/privacy` too, not just `/`. */
const mobileNavItems: { href: string; label: string }[] = [
  { href: '/#works', label: '作品' },
  { href: '/#capabilities', label: '产品能力' },
  { href: '/#workflow', label: '创作流程' },
  { href: '/terms', label: '用户协议' },
  { href: '/privacy', label: '隐私政策' },
]

/** Scrim: `--color-overlay` at `--opacity-overlay` (mirrors the workspace drawer). */
const SCRIM_BACKGROUND =
  'color-mix(in srgb, var(--color-overlay) calc(var(--opacity-overlay) * 100%), transparent)'

function MenuIcon({ open }: { open: boolean }) {
  return open ? (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={iconSize.md}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ) : (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={iconSize.md}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  )
}

export function PublicMobileNav() {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const {
    mounted,
    phase,
    labelId,
    closeButtonRef,
    portalTarget,
    rootProps,
    dialogProps,
  } = useDialog({ open, onClose: close })

  // The trigger hides at `sm` via CSS; also drop the state so reopening
  // after a resize starts closed instead of reviving a stale panel.
  useEffect(() => {
    if (!open) return
    const query = window.matchMedia('(min-width: 40rem)')
    const closeOnDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) setOpen(false)
    }
    if (query.matches) setOpen(false)
    query.addEventListener('change', closeOnDesktop)
    return () => query.removeEventListener('change', closeOnDesktop)
  }, [open ])

  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? '关闭导航菜单' : '打开导航菜单'}
        onClick={() => setOpen((value) => !value)}
        className="motion-press inline-flex size-11 items-center justify-center rounded-control text-foreground hover:bg-tonal-hover active:bg-tonal-active sm:hidden"
      >
        <MenuIcon open={open} />
      </button>

      {mounted && portalTarget
        ? createPortal(
            <div
              {...rootProps}
              className={cn(
                'fixed inset-0 z-modal sm:hidden',
                phase === 'close' ? 'motion-fade-out pointer-events-none' : 'motion-fade-in',
              )}
            >
              <div
                aria-hidden="true"
                onClick={close}
                className="fixed inset-0"
                style={{ backgroundColor: SCRIM_BACKGROUND }}
              />
              <div
                {...dialogProps}
                id={panelId}
                className={cn(
                  'fixed inset-x-0 top-0 rounded-b-panel bg-surface px-4 pb-5 shadow-modal',
                  phase === 'close' ? 'motion-toast-out' : 'motion-toast-in',
                )}
              >
                <div className="flex h-[var(--layout-header)] items-center justify-between">
                  <h2 id={labelId} className="text-base font-medium text-foreground">
                    菜单
                  </h2>
                  <button
                    ref={closeButtonRef}
                    type="button"
                    aria-label="关闭导航菜单"
                    onClick={close}
                    className="motion-press inline-flex size-11 items-center justify-center rounded-control text-foreground hover:bg-tonal-hover active:bg-tonal-active"
                  >
                    <MenuIcon open />
                  </button>
                </div>

                <nav aria-label="移动导航">
                  <ul className="flex flex-col divide-y divide-border">
                    {mobileNavItems.map((item) => (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          onClick={close}
                          className="motion-press flex min-h-[var(--control-lg)] items-center text-[17px] text-foreground"
                        >
                          {item.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </nav>

                <div className="mt-4 flex gap-2.5">
                  <Link
                    href="/login"
                    onClick={close}
                    className={cn(buttonVariants({ variant: 'secondary', size: 'lg' }), 'flex-1')}
                  >
                    登录
                  </Link>
                  <Link
                    href="/login"
                    onClick={close}
                    className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'flex-1')}
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
