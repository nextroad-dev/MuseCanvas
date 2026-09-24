'use client'

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

interface RevealProps {
  children: ReactNode
  className?: string
  /** 0-based stagger step; each step is `--stagger-step` (50ms), clamped to 8. */
  staggerIndex?: number
}

/**
 * Scroll-triggered fade-in-up entrance for marketing-style sections.
 *
 * SSR and first paint render the final visible state (no-JS and slow-hydration
 * safe); after hydration an IntersectionObserver hides below-fold blocks and
 * re-reveals them on scroll. Reduced-motion users never get the hidden state —
 * the observer is not installed and content stays statically visible.
 */
export function Reveal({ children, className = '', staggerIndex }: RevealProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    if (typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true)
            observer.disconnect()
          } else {
            setVisible(false)
          }
        }
      },
      { threshold: 0.1, rootMargin: '0px 0px -5% 0px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={ref}
      style={{ '--stagger-index': staggerIndex ?? 0 } as CSSProperties}
      className={`${className} ${
        visible ? 'motion-reveal motion-stagger' : 'opacity-0'
      }`}
    >
      {children}
    </div>
  )
}
