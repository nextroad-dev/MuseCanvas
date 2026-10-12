import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * Merge conditional class names, letting a later Tailwind utility win over an
 * earlier one of the same kind (`px-2` + `px-4` -> `px-4`).
 *
 * Every shared primitive takes a `className` escape hatch and routes it through
 * here, so a caller can nudge one property without re-specifying the whole rule
 * and without fighting CSS order.
 *
 * ## Why the theme names are registered below
 * tailwind-merge ships the Tailwind default vocabulary, so it does not know that
 * `text-title`, `text-section` or `text-overline` are FONT SIZES — it pattern-matches
 * them as `text-<color>`. Without this config `cn('text-title', 'text-foreground')`
 * silently deletes the font size, which is exactly what a component does when it
 * styles a heading and then lets the caller pass a colour. Registering the
 * design-token utilities in their real groups makes size and colour independent.
 * Add a name here whenever a new `--text-*` / `--z-index-*` / `--shadow-*` /
 * `--radius-*` / `--container-*` token becomes a utility.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      // --text-* (globals.css type scale; line-height and tracking ride along)
      'font-size': [
        'text-display',
        'text-title',
        'text-section',
        'text-subtitle',
        'text-module',
        'text-overline',
      ],
      // --z-index-* elevation ladder
      z: ['z-sticky', 'z-dropdown', 'z-overlay', 'z-modal', 'z-toast', 'z-tooltip', 'z-command'],
      // --shadow-* elevation ladder
      shadow: [
        'shadow-soft',
        'shadow-floating',
        'shadow-dropdown',
        'shadow-toast',
        'shadow-modal',
        'shadow-drawer',
        'shadow-command',
      ],
      // --radius-* semantic radii
      rounded: [
        'rounded-checkbox',
        'rounded-control',
        'rounded-popover',
        'rounded-card',
        'rounded-panel',
        'rounded-pill',
      ],
      // --container-* layout widths, as `max-w-*` …
      'max-w': [
        'max-w-content',
        'max-w-form',
        'max-w-reading',
        'max-w-sidebar',
        'max-w-sidebar-collapsed',
        'max-w-settings-nav',
        'max-w-dialog-narrow',
        'max-w-dialog-wide',
      ],
      // … and as `w-*`: a fixed rail is a width, not a max. Without this group
      // `cn('w-sidebar', 'w-settings-nav')` would keep both and the later one wins
      // by CSS order instead of by intent.
      w: ['w-sidebar', 'w-sidebar-collapsed', 'w-settings-nav'],
      'min-h': ['min-h-header'],
      h: ['h-header'],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
