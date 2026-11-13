/**
 * Pure geometry/roving maths for the segmented control, split out from the
 * component so `node --test` can cover it without rendering a DOM.
 */

export interface ThumbGeometry {
  left: number
  width: number
}

/**
 * Position of the sliding block: the selected item's offset inside the track plus
 * its width. Non-finite measurements (detached node, zero layout in a hidden tab)
 * clamp to 0 rather than producing `translateX(NaN)`.
 */
export function thumbGeometry(offsetLeft: number, offsetWidth: number): ThumbGeometry {
  return {
    left: Number.isFinite(offsetLeft) ? Math.max(0, offsetLeft) : 0,
    width: Number.isFinite(offsetWidth) ? Math.max(0, offsetWidth) : 0,
  }
}

/**
 * Next selectable index in a radio group, with keyboard wrap-around. `enabled`
 * mirrors the items; disabled ones are skipped in both directions.
 */
export function nextEnabledIndex(enabled: boolean[], current: number, delta: number): number {
  const total = enabled.length
  if (total === 0) return -1
  let index = Number.isFinite(current) ? current : 0
  for (let step = 0; step < total; step += 1) {
    index = (index + delta + total) % total
    if (enabled[index]) return index
  }
  return current
}
