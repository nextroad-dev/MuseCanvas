/**
 * Shared CSS color resolution for canvas-rendered decorative components.
 *
 * Design tokens (`src/assets/index.css`, `@theme`) are the single source of truth
 * for colors. Components must resolve tokens at runtime instead of hardcoding
 * brand/canvas values, so a token change propagates without code edits.
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

const HEX_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const RGB_PATTERN = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i

function parseHexColor(value: string): Rgb | null {
  const match = HEX_PATTERN.exec(value)
  if (!match) return null

  const digits = match[1]
  if (digits.length === 3 || digits.length === 4) {
    return {
      r: parseInt(digits[0] + digits[0], 16),
      g: parseInt(digits[1] + digits[1], 16),
      b: parseInt(digits[2] + digits[2], 16),
    }
  }

  return {
    r: parseInt(digits.slice(0, 2), 16),
    g: parseInt(digits.slice(2, 4), 16),
    b: parseInt(digits.slice(4, 6), 16),
  }
}

function parseRgbColor(value: string): Rgb | null {
  const match = RGB_PATTERN.exec(value)
  if (!match) return null

  return {
    r: Math.round(Number.parseFloat(match[1])),
    g: Math.round(Number.parseFloat(match[2])),
    b: Math.round(Number.parseFloat(match[3])),
  }
}

function parseColorString(value: string): Rgb | null {
  return parseHexColor(value) ?? parseRgbColor(value)
}

/** Normalize any CSS color to `#rrggbb` / `rgba(...)` via a 1x1 canvas. */
function normalizeViaCanvas(value: string): string {
  // var() and other non-color values are rejected here; they are resolved by
  // the probe element before reaching this helper.
  if (typeof CSS === 'undefined' || !CSS.supports('color', value)) return ''

  const context = document.createElement('canvas').getContext('2d')
  if (!context) return ''

  context.fillStyle = value
  return context.fillStyle
}

/** Resolve a browser-computed color value that is not in legacy rgb() form. */
function resolveComputedColor(value: string): Rgb | null {
  const parsed = parseColorString(value)
  if (parsed) return parsed

  return parseColorString(normalizeViaCanvas(value))
}

/**
 * Read a design token from the document root.
 * Returns `''` when the token is not defined.
 */
export function readCssVar(name: string, root: Element = document.documentElement): string {
  return getComputedStyle(root).getPropertyValue(name).trim()
}

/**
 * Resolve any CSS color string (hex, `rgb()`/`rgba()`, named color, `var(--token)`,
 * or a modern color space such as `oklch()`) to RGB channels.
 * Returns `null` when the value cannot be resolved — callers must not paint a
 * fallback color in that case, since that would duplicate the token.
 */
export function resolveCssColor(input: string): Rgb | null {
  const raw = input.trim()
  if (!raw) return null

  const direct = parseColorString(raw)
  if (direct) return direct

  // Let the browser resolve var(), named colors and modern color spaces.
  const probe = document.createElement('div')
  probe.style.color = raw
  probe.style.position = 'fixed'
  probe.style.opacity = '0'
  probe.style.pointerEvents = 'none'
  document.body.appendChild(probe)
  const computed = getComputedStyle(probe).color
  document.body.removeChild(probe)

  return resolveComputedColor(computed) ?? resolveComputedColor(raw)
}