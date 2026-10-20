'use client'

import { useId, useState } from 'react'
import { cn } from '@/shared/lib/cn'

export interface CapabilityItem {
  title: string
  description: string
}

/**
 * Single-open accordion for the landing capabilities. Each trigger is a real
 * button with `aria-expanded` and `aria-controls`; a closed panel keeps `hidden`
 * so the reference always resolves. The plus glyph turns 45 degrees into a close
 * mark over `--motion-base`, which `prefers-reduced-motion` switches off.
 */
export function CapabilityAccordion({
  items,
  defaultOpen = 0,
}: {
  items: CapabilityItem[]
  defaultOpen?: number
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(defaultOpen)
  const baseId = useId()

  return (
    <ul className="border-t border-foreground">
      {items.map((item, index) => {
        const open = openIndex === index
        const triggerId = `${baseId}-trigger-${index}`
        const panelId = `${baseId}-panel-${index}`
        return (
          <li key={item.title} className="border-b border-border">
            <h3>
              <button
                id={triggerId}
                type="button"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => setOpenIndex(open ? null : index)}
                className="motion-press flex w-full cursor-pointer items-center justify-between gap-6 py-6 text-left text-foreground md:py-7"
              >
                <span className="text-2xl font-medium leading-[1.35] md:text-[1.75rem]">{item.title}</span>
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.6}
                  strokeLinecap="round"
                  className={cn(
                    'size-5 shrink-0 transition-transform duration-[var(--motion-base)] ease-[var(--ease-standard)] motion-reduce:transition-none',
                    open && 'rotate-45',
                  )}
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            </h3>
            <div id={panelId} role="region" aria-labelledby={triggerId} hidden={!open}>
              <p className="max-w-xl pb-7 pr-12 text-lg leading-[1.75] text-foreground/85 [text-wrap:pretty]">
                {item.description}
              </p>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
