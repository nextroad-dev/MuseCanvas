/**
 * Shared form-control styling.
 *
 * Every text input, textarea and native <input>/<select> in the app composes
 * these classes so controls stay identical and focus styling lives in exactly
 * one place (`src/assets/index.css`, `:focus-visible`).
 *
 * 40px minimum height (grows with font size), control-outline border (>= 3:1),
 * no local focus-ring override.
 */
export const inputClass = [
  'min-h-10 w-full rounded-[var(--radius-control)] border border-border-control bg-surface px-3 text-sm text-foreground',
  'placeholder:text-muted-foreground transition-colors',
  'disabled:cursor-not-allowed disabled:opacity-50',
].join(' ')

/** Additional classes for the invalid state; the error ring stays on the field. */
export const inputInvalidClass = 'border-danger'

/** `inputClass` plus the invalid border, used by `invalid` props. */
export function fieldClass(invalid?: boolean): string {
  return invalid ? `${inputClass} ${inputInvalidClass}` : inputClass
}