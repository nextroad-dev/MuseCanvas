// Shared contract for region-select image editing ("局部修改").
//
// Geometry lives here rather than in apps/web-next for two reasons. First,
// web-next has no test runner, and every rounding rule below is a correctness
// rule: a mask one pixel wider than its image is exactly what the vendor
// rejects, and a reversed drag that skips normalisation edits the wrong pixels.
// Second, the browser and the server must agree on the *same* interpretation of
// an `EditSelection` — the client measures a rectangle on screen, the server
// rasterises that same rectangle into an alpha mask, and only a shared clamp/
// round keeps the two ends describing one region.

/** A selection in **source-image pixel space**: integers, origin top-left,
 *  always normalised (`width`/`height` positive, fully inside the image). */
export interface EditSelection {
  x: number
  y: number
  width: number
  height: number
}

/** A rectangle in browser/CSS-pixel space as the user dragged it. May still be
 *  reversed (`width` negative when dragging right-to-left) and fractional. */
export interface DisplayRect {
  x: number
  y: number
  width: number
  height: number
}

/** A viewport-space box (`getBoundingClientRect()` shape). */
export interface RenderBox {
  left: number
  top: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/**
 * The two ways a caller can describe what to edit. The rectangle branch is what
 * 局部修改 sends today; the mask branch is the escape hatch for anything a
 * rectangle cannot express (brush strokes, lasso, polygon, auto-segmentation),
 * so adding those tools never requires redesigning the request.
 *
 * `bytes` is a PNG **with an alpha channel** sized to the source image.
 */
export type EditRegion =
  | { type: 'rectangle'; x: number; y: number; width: number; height: number }
  | { type: 'mask'; mimeType: 'image/png'; bytes: Uint8Array }

/** `generation_job_inputs.role` value marking the edit mask. Must stay in sync
 *  with the DB role CHECK and `KNOWN_INPUT_ROLES`. */
export const MASK_INPUT_ROLE = 'mask'

/**
 * Vendor alpha-mask convention, stated once for the whole repo: a fully
 * transparent pixel marks the area the model may regenerate, a fully opaque
 * pixel marks the area to preserve. The server rasteriser, the provider plugin's
 * validation and the browser canvas all import these instead of re-deciding.
 */
export const MASK_EDIT_ALPHA = 0
export const MASK_KEEP_ALPHA = 255

/** Below this many source pixels on either axis a selection is treated as a
 *  slip of the mouse rather than an intent to edit. */
export const MIN_EDIT_SELECTION_PX = 8

/** Vendor ceiling for the mask part of an edit request (decimal MB). */
export const MAX_MASK_BYTES = 4_000_000

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Image dimensions as decoded from real bytes: positive safe integers. */
function isImageSize(width: unknown, height: unknown): boolean {
  return (
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    (width as number) > 0 &&
    (height as number) > 0
  )
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/**
 * The rectangle an `<img>` actually paints, given the element's own box.
 *
 * This is the step that keeps coordinates honest: an element box is *not* the
 * image. `object-contain` letterboxes it, `object-cover` overflows and crops
 * it, and using the container (or the element box) as the denominator silently
 * maps the selection onto the wrong pixels — worst on the tall lightbox image
 * where the gap can be hundreds of pixels.
 *
 * For `cover` the returned box can extend outside `elementBox`; callers that
 * only let the user drag inside what they see must intersect the two (see
 * `visibleImageBox`).
 */
export function imageContentBox(
  elementBox: RenderBox,
  objectFit: 'contain' | 'cover' | 'fill',
  imageWidth: number,
  imageHeight: number,
): RenderBox {
  if (!isImageSize(imageWidth, imageHeight) || !finiteNumber(elementBox.width) || !finiteNumber(elementBox.height)) {
    return { left: elementBox.left, top: elementBox.top, width: 0, height: 0 }
  }
  if (elementBox.width <= 0 || elementBox.height <= 0) {
    return { left: elementBox.left, top: elementBox.top, width: 0, height: 0 }
  }
  if (objectFit === 'fill') {
    return { left: elementBox.left, top: elementBox.top, width: elementBox.width, height: elementBox.height }
  }
  const scaleX = elementBox.width / imageWidth
  const scaleY = elementBox.height / imageHeight
  const scale = objectFit === 'contain' ? Math.min(scaleX, scaleY) : Math.max(scaleX, scaleY)
  const width = imageWidth * scale
  const height = imageHeight * scale
  return {
    left: elementBox.left + (elementBox.width - width) / 2,
    top: elementBox.top + (elementBox.height - height) / 2,
    width,
    height,
  }
}

/** What the user can actually see of the image: the painted rectangle clipped
 *  by the element box. `contain` returns it untouched; `cover` trims the
 *  overflow the browser hid, so a selection can never land on invisible pixels. */
export function visibleImageBox(contentBox: RenderBox, elementBox: RenderBox): RenderBox {
  const left = Math.max(contentBox.left, elementBox.left)
  const top = Math.max(contentBox.top, elementBox.top)
  const right = Math.min(contentBox.left + contentBox.width, elementBox.left + elementBox.width)
  const bottom = Math.min(contentBox.top + contentBox.height, elementBox.top + elementBox.height)
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

export function isPointInsideRenderBox(point: Point, box: RenderBox): boolean {
  if (!finiteNumber(point.x) || !finiteNumber(point.y)) return false
  if (box.width <= 0 || box.height <= 0) return false
  return (
    point.x >= box.left &&
    point.x <= box.left + box.width &&
    point.y >= box.top &&
    point.y <= box.top + box.height
  )
}

/**
 * Normalise, clip and round a selection into the source image.
 *
 * Rounding fixes the *far* edge in image space before deriving `width`, so a
 * 1023.6 px-wide image can never yield `x + width > imageWidth` — the one
 * rounding bug that produces a mask larger than its image.
 *
 * Returns `null` for anything unusable: non-finite input, an empty rectangle
 * after clipping, or a region smaller than `MIN_EDIT_SELECTION_PX`.
 */
export function clampEditSelection(
  selection: EditSelection,
  imageWidth: number,
  imageHeight: number,
): EditSelection | null {
  if (!isImageSize(imageWidth, imageHeight)) return null
  const { x, y, width, height } = selection
  if (![x, y, width, height].every(finiteNumber)) return null

  // Reversed drags carry a negative extent: fold them before clipping.
  const left = width < 0 ? x + width : x
  const right = width < 0 ? x : x + width
  const top = height < 0 ? y + height : y
  const bottom = height < 0 ? y : y + height
  if (right <= left || bottom <= top) return null

  const x0 = Math.round(clamp(left, 0, imageWidth))
  const x1 = Math.round(clamp(right, 0, imageWidth))
  const y0 = Math.round(clamp(top, 0, imageHeight))
  const y1 = Math.round(clamp(bottom, 0, imageHeight))
  const clipped = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
  if (clipped.width < MIN_EDIT_SELECTION_PX || clipped.height < MIN_EDIT_SELECTION_PX) return null
  return clipped
}

/**
 * Screen drag → source-image selection.
 *
 * `drag` is in the same CSS-pixel space as `contentBox` (viewport coordinates
 * from `getBoundingClientRect()` / `PointerEvent.clientX`), and may be reversed
 * or hang outside the image. `imageWidth`/`imageHeight` are the image's **real**
 * pixel dimensions (`naturalWidth`/`naturalHeight`), never the rendered size.
 */
export function displaySelectionToImageSelection(
  drag: DisplayRect,
  contentBox: RenderBox,
  imageWidth: number,
  imageHeight: number,
): EditSelection | null {
  if (!isImageSize(imageWidth, imageHeight)) return null
  if (contentBox.width <= 0 || contentBox.height <= 0) return null
  if (![drag.x, drag.y, drag.width, drag.height].every(finiteNumber)) return null

  const scaleX = imageWidth / contentBox.width
  const scaleY = imageHeight / contentBox.height
  const toImageX = (value: number) => (value - contentBox.left) * scaleX
  const toImageY = (value: number) => (value - contentBox.top) * scaleY

  return clampEditSelection(
    {
      x: toImageX(drag.x),
      y: toImageY(drag.y),
      width: drag.width * scaleX,
      height: drag.height * scaleY,
    },
    imageWidth,
    imageHeight,
  )
}

/** Inverse of `displaySelectionToImageSelection`, used to repaint a selection
 *  already stored in image space (window resize, zoom, re-render). */
export function imageSelectionToDisplaySelection(
  selection: EditSelection,
  contentBox: RenderBox,
  imageWidth: number,
  imageHeight: number,
): DisplayRect {
  if (!isImageSize(imageWidth, imageHeight) || contentBox.width <= 0 || contentBox.height <= 0) {
    return { x: contentBox.left, y: contentBox.top, width: 0, height: 0 }
  }
  const scaleX = contentBox.width / imageWidth
  const scaleY = contentBox.height / imageHeight
  return {
    x: contentBox.left + selection.x * scaleX,
    y: contentBox.top + selection.y * scaleY,
    width: selection.width * scaleX,
    height: selection.height * scaleY,
  }
}

/** A selection is submittable once it has survived clamping and clears the
 *  minimum size — the same rule `clampEditSelection` applied to create it. */
export function editSelectionIsUsable(selection: EditSelection | null): selection is EditSelection {
  if (!selection) return false
  return (
    Number.isSafeInteger(selection.x) &&
    Number.isSafeInteger(selection.y) &&
    selection.x >= 0 &&
    selection.y >= 0 &&
    selection.width >= MIN_EDIT_SELECTION_PX &&
    selection.height >= MIN_EDIT_SELECTION_PX
  )
}

/**
 * Prompt wrapper for a masked edit. The user's own wording is preserved verbatim
 * and stays the last thing in the string; everything above it is the standing
 * instruction to respect the mask.
 */
export function buildInpaintPrompt(userRequest: string): string {
  const request = userRequest.trim()
  return [
    'Edit only the selected region of the image, as indicated by the mask.',
    'Preserve everything outside the selected region unchanged: the same subject, background, colours and detail.',
    'Keep the original composition, lighting, perspective and visual style unless the request below says otherwise.',
    'Blend the edited region seamlessly into its surroundings.',
    'User request:',
    request,
  ].join('\n')
}

/** Parse the `region` form field of `POST /api/images/edit`. Accepts the
 *  `EditRegion` rectangle object with or without its `type` discriminator, and
 *  nothing else — a malformed or out-of-range rectangle must fail loudly. */
export function parseRectangleRegion(value: unknown): EditRegion | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.type !== undefined && record.type !== 'rectangle') return null
  const { x, y, width, height } = record
  if (![x, y, width, height].every(finiteNumber)) return null
  return { type: 'rectangle', x: x as number, y: y as number, width: width as number, height: height as number }
}
