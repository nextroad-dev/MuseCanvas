/**
 * Focus helpers for form validation.
 *
 * Call after a failed submit so the first invalid control receives focus and
 * assistive technology lands on the field that needs attention.
 */
const INVALID_FIELD_SELECTOR = '[aria-invalid="true"]'

/**
 * Focus the first element marked `aria-invalid="true"` inside `root`.
 * Returns `true` when an element was focused.
 */
export function focusFirstInvalidEl(root: ParentNode | null | undefined): boolean {
  if (!root) return false
  const target = root.querySelector<HTMLElement>(INVALID_FIELD_SELECTOR)
  if (!target) return false
  target.focus()
  return true
}