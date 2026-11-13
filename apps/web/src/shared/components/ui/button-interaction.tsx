'use client'

import { cloneElement } from 'react'
import type { MouseEvent, ReactElement } from 'react'

interface ButtonInteractionProps {
  blocked: boolean
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void
  children: ReactElement<Record<string, unknown>>
}

/** Only this client boundary creates handlers; static Button output remains handler-free. */
export function ButtonInteraction({ blocked, onClick, children }: ButtonInteractionProps) {
  const childClick = children.props.onClick as ((event: MouseEvent<HTMLElement>) => void) | undefined
  return cloneElement(children, {
    onClick: (event: MouseEvent<HTMLElement>) => {
      // Mouse and keyboard-generated clicks must both stop before either callback.
      if (blocked) {
        event.preventDefault()
        return
      }
      childClick?.(event)
      if (!event.defaultPrevented) onClick?.(event as MouseEvent<HTMLButtonElement>)
    },
  })
}
