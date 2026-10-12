/**
 * The interaction states every control in `ui/` shares. Components import these
 * instead of writing their own durations or focus rings, so a retune of a
 * `--motion-*` / `--ease-*` token in globals.css moves every control together.
 *
 * Rules, one line each:
 *  · Timing — colour states are a plain `transition-colors`. Tailwind's defaults
 *    point at `--motion-fast` / `--ease-standard` in globals.css, so that is already
 *    token-timed and no control names a duration.
 *  · Press — pressable controls use `.motion-press` (globals.css) and nothing else.
 *    It owns the colour fade and the 0.98 dip together; never pair it with a
 *    `transition-*` class, which would overwrite its `transition-property`.
 *  · Hover — `not-disabled:hover:` (matches `<a>` and `<button>`), never `enabled:`,
 *    which only matches form controls.
 *  · Focus — globals.css paints the single `:focus-visible` ring. A control whose
 *    real focus target is a visually hidden input (checkbox, radio) cannot show that
 *    outline, so it moves the same ring onto its visible circle with `focusRingPeer`.
 */

/** Colour states (hover, selected, error paint) on any control that does not press. */
export const colourTransition = 'transition-colors'

/** Focus ring transferred from a visually hidden `peer` input to its visible sibling. */
export const focusRingPeer =
  'peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-border-focus'

/** Outline controls (Input, Select, Switch off) deepen their border on hover. */
export const outlineHover = 'not-disabled:hover:border-border-strong'

/** Same hover for a control whose hover lives on an enclosing `group` label or a `peer` input. */
export const peerOutlineHover = 'group-hover:border-border-strong peer-hover:border-border-strong'
