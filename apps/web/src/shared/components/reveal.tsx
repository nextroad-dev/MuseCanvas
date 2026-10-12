import type { CSSProperties, ReactNode } from 'react'

interface RevealProps {
  children: ReactNode
  className?: string
  /**
   * `load` plays the page entrance once on first paint (the hero). `scroll`
   * (default) fades the block in as it scrolls into view.
   */
  trigger?: 'load' | 'scroll'
  /** 0-based step for `load` blocks that enter together. The spacing comes from
   *  `--stagger-step-page` (100ms). Ignored for `scroll`: each scroll block enters
   *  on its own, so a stagger would only make it wait. */
  staggerIndex?: number
}

/**
 * Page-level entrance for marketing sections (fade-in-up, `--motion-page`).
 *
 * Pure CSS on purpose, so it stays fail-visible: the base state of every block is
 * its final visible state and nothing is ever toggled to `opacity-0` from script.
 * `scroll` uses a scroll-driven animation (`.motion-scroll-reveal`) that only
 * exists where the browser supports `animation-timeline: view()` and the user has
 * not asked for reduced motion; everywhere else the section is simply there.
 */
export function Reveal({ children, className = '', trigger = 'scroll', staggerIndex }: RevealProps) {
  if (trigger === 'scroll') {
    return <div className={`${className} motion-scroll-reveal`}>{children}</div>
  }
  return (
    <div
      style={
        {
          '--stagger-index': staggerIndex ?? 0,
          // The marketing rhythm is 100ms per section, not the 50ms list step.
          '--stagger-step': 'var(--stagger-step-page)',
        } as CSSProperties
      }
      className={`${className} motion-page motion-stagger`}
    >
      {children}
    </div>
  )
}
