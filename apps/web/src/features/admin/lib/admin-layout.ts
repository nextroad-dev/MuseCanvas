/**
 * Shared class strings for the admin surface. Kept as plain constants (not a
 * component) so they can be applied to primitives that already own their markup
 * (`PageHeader.actionsClassName`, `Dialog.panelClassName`) without wrapping them.
 */

/**
 * Every admin route root: one vertical rhythm (page header, then sections). The
 * entrance is `motion-page-enter`, which defines its animation only under
 * `prefers-reduced-motion: no-preference`, so reduced-motion users get the static page.
 */
export const adminPageRoot = 'flex min-w-0 flex-col gap-8 motion-page-enter'

/**
 * Touch-size for the actions of a toolbar or header below the `md` (960px)
 * breakpoint. Buttons and links reach the 48px `--control-lg` hit area; desktop
 * keeps the 40px default. Applied as a descendant rule so the primitives stay
 * unaware of the viewport.
 */
export const adminTouchTargets =
  'max-md:[&_button]:min-h-[var(--control-lg)] max-md:[&_a]:min-h-[var(--control-lg)]'

/**
 * Same as `adminTouchTargets`, plus a square minimum width on buttons. Used for
 * icon-only triggers and dialog panels, where a 40px-wide target is too narrow
 * to hit reliably with a finger.
 */
export const adminTouchTargetsSquare =
  'max-md:[&_button]:min-h-[var(--control-lg)] max-md:[&_button]:min-w-[var(--control-lg)]'

/**
 * Wrapper for a block of admin content that holds its own buttons (a record
 * list, an actions row): wraps long identifiers, and sizes the buttons to touch.
 */
export const adminTouchWrap = `min-w-0 [overflow-wrap:anywhere] ${adminTouchTargets}`

/**
 * `PageHeader.className`: the header is separated from the content by a hairline
 * rule instead of a boxed band, and long identifiers wrap rather than overflow.
 */
export const adminPageHeader = 'min-w-0 border-b border-border pb-6 [overflow-wrap:anywhere]'

/** `PageHeader.actionsClassName`: header actions take the touch size below `md`. */
export const adminPageActions = `max-w-full min-w-0 ${adminTouchTargets}`

/**
 * Admin sidebar collapse persistence.
 *
 * The collapsed flag lives in `localStorage` so a refresh keeps the operator's
 * choice. Both helpers are SSR-safe (first paint always renders expanded, the
 * stored value is applied after mount) and swallow storage failures, so private
 * mode or a blocked store simply falls back to expanded.
 */
export const adminSidebarCollapsedKey = 'musecanvas:admin:sidebar-collapsed'

/** Stored value, or `false` (expanded) when storage is unavailable. */
export function readAdminSidebarCollapsed(): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false
    return window.localStorage.getItem(adminSidebarCollapsedKey) === '1'
  } catch {
    return false
  }
}

/** Persist the operator's choice; storage failures keep the in-memory state. */
export function writeAdminSidebarCollapsed(collapsed: boolean): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(adminSidebarCollapsedKey, collapsed ? '1' : '0')
  } catch {
    // Blocked storage: the sidebar still toggles, it just resets next load.
  }
}
