'use client'

// The 局部修改 canvas: the source image plus a draggable rectangle.
//
// Every number the user drags is screen geometry, and the only thing the request
// may carry is *image* geometry. The two are related by the rectangle the `<img>`
// actually paints, which is not its element box: `object-contain` letterboxes the
// picture inside it, so measuring the element (or worse, the container) and
// dividing by that maps the selection onto the wrong pixels. All of that mapping
// lives in `@musecanvas/contracts`, where it is unit-tested; this file only
// decides when to call it and where to paint the result.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import {
  MIN_EDIT_SELECTION_PX,
  clampEditSelection,
  displaySelectionToImageSelection,
  imageContentBox,
  imageSelectionToDisplaySelection,
  isPointInsideRenderBox,
  visibleImageBox,
} from '@musecanvas/contracts'
import type { DisplayRect, EditSelection, Point, RenderBox } from '@musecanvas/contracts'
import { Eraser, ImageOff } from 'lucide-react'
import { stageAspectRatio } from '@/shared/components/media-frame'

export interface EditRegionStageProps {
  /** Playable (signed) URL of the source image. A new URL is a new subject: the
   *  stage resets its load state on identity change. */
  src: string
  alt: string
  /** Declared pixel size from the job or library DTO. It only sizes the box until
   *  the image decodes, after which the element's own intrinsic size wins. */
  declaredWidth?: number
  declaredHeight?: number
  /** The committed selection, in source-image pixels. The one selection this
   *  component is told about — an in-flight drag never reaches the caller. */
  selection: EditSelection | null
  /** Fires once per completed drag or keyboard edit, and with `null` on clear. */
  onSelectionChange: (selection: EditSelection | null) => void
}

/** What the geometry helpers need for one paint: the element's own box, the
 *  rectangle it actually paints inside that box, and the decoded pixel size. */
interface Geometry {
  box: RenderBox
  content: RenderBox
  visible: RenderBox
  width: number
  height: number
}

/** Outside-dim, drawn as one enormous spread shadow rather than four panels: the
 *  clipping wrapper is the surface itself, so the band can never misalign. */
const DIM_STYLE = '0 0 0 9999px color-mix(in srgb, var(--color-overlay) 45%, transparent)'

const KEYBOARD_STEP_RATIO = 0.01

const ARROW_DELTAS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
}

function elementBox(el: HTMLImageElement): RenderBox {
  const rect = el.getBoundingClientRect()
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

/** `null` until the picture has decoded: with no intrinsic size there is no
 *  image-space grid to map a drag onto, and nothing may be selected. */
function geometryOf(el: HTMLImageElement | null): Geometry | null {
  if (!el) return null
  const width = el.naturalWidth
  const height = el.naturalHeight
  if (width < 1 || height < 1) return null
  const box = elementBox(el)
  const content = imageContentBox(box, 'contain', width, height)
  return { box, content, visible: visibleImageBox(content, box), width, height }
}

function sameGeometry(left: Geometry | null, right: Geometry | null): boolean {
  if (!left || !right) return left === right
  const a = [left.box.left, left.box.top, left.box.width, left.box.height, left.width, left.height]
  const b = [right.box.left, right.box.top, right.box.width, right.box.height, right.width, right.height]
  return a.every((value, index) => value === b[index])
}

/** Viewport-space rectangle → offsets inside the paint layer, which shares its
 *  origin with the image element. Reversed drags carry a negative extent. */
function toLocalStyle(rect: DisplayRect, box: RenderBox): CSSProperties {
  return {
    left: Math.min(rect.x, rect.x + rect.width) - box.left,
    top: Math.min(rect.y, rect.y + rect.height) - box.top,
    width: Math.abs(rect.width),
    height: Math.abs(rect.height),
  }
}

function clampToBox(box: RenderBox, x: number, y: number): Point {
  return {
    x: Math.min(Math.max(x, box.left), box.left + box.width),
    y: Math.min(Math.max(y, box.top), box.top + box.height),
  }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(value, min), Math.max(min, max)))
}

export function EditRegionStage({
  src,
  alt,
  declaredWidth,
  declaredHeight,
  selection,
  onSelectionChange,
}: EditRegionStageProps) {
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [geometry, setGeometry] = useState<Geometry | null>(null)
  const [load, setLoad] = useState<{ src: string; phase: 'loading' | 'ready' | 'failed' }>({
    src,
    phase: 'loading',
  })
  const dragRef = useRef<{ pointerId: number; from: Point } | null>(null)
  // Transient, screen-space, and discarded on pointer-up: the only selection that
  // survives this component is the image-space one handed to `onSelectionChange`.
  const [dragRect, setDragRect] = useState<DisplayRect | null>(null)
  const [rejectedDrag, setRejectedDrag] = useState(false)

  // A new `src` is a new load, and a stale `failed` flag would hide the picture
  // that is now arriving. Reset during render rather than in an effect so no frame
  // paints the old subject's state — the same move `media-frame.tsx` makes.
  if (load.src !== src) setLoad({ src, phase: 'loading' })
  const phase = load.src === src ? load.phase : 'loading'

  const remeasure = useCallback(() => {
    const next = geometryOf(imgRef.current)
    setGeometry((prev) => (sameGeometry(prev, next) ? prev : next))
  }, [])

  useEffect(() => {
    const el = imgRef.current
    if (!el) return
    remeasure()
    // A cached picture can be complete before React has attached `onLoad`, and
    // that event then never fires: the skeleton would sit here forever.
    if (el.complete && el.naturalWidth > 0) setLoad({ src, phase: 'ready' })
    // The element's own box, because that is the box the mapping divides by:
    // a resize of the window, the rail or the text column all move it.
    const observer = new ResizeObserver(remeasure)
    observer.observe(el)
    // Scrolling changes `getBoundingClientRect()`, hence the drag rectangle and
    // the stored viewport coordinates no longer line up. Capture phase, so the
    // console's own `overflow-y-auto` column counts too.
    window.addEventListener('scroll', remeasure, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', remeasure, true)
    }
  }, [remeasure, src])

  function handleLoad() {
    setLoad({ src, phase: 'ready' })
    remeasure()
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const current = geometryOf(imgRef.current)
    if (!current) return
    const point = { x: event.clientX, y: event.clientY }
    // A drag that begins in the letterbox band — off the picture itself — must not
    // start, or the first pixel of the selection is a lie.
    if (!isPointInsideRenderBox(point, current.visible)) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    // Cancelling `pointerdown` also cancels the compatibility `mousedown`, which is
    // what would have focused the surface: without this the keyboard path only
    // works after a Tab, and the canvas the user just clicked looks unfocused.
    event.currentTarget.focus()
    dragRef.current = { pointerId: event.pointerId, from: point }
    setRejectedDrag(false)
    setDragRect({ x: point.x, y: point.y, width: 0, height: 0 })
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const current = geometryOf(imgRef.current)
    if (!current) return
    // Follow the pointer anywhere, but never paint outside what is visible.
    const to = clampToBox(current.visible, event.clientX, event.clientY)
    setDragRect({ x: drag.from.x, y: drag.from.y, width: to.x - drag.from.x, height: to.y - drag.from.y })
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setDragRect(null)
    const current = geometryOf(imgRef.current)
    if (!current) return
    const to = clampToBox(current.visible, event.clientX, event.clientY)
    const committed = displaySelectionToImageSelection(
      { x: drag.from.x, y: drag.from.y, width: to.x - drag.from.x, height: to.y - drag.from.y },
      current.content,
      current.width,
      current.height,
    )
    if (committed) {
      setRejectedDrag(false)
      onSelectionChange(committed)
      return
    }
    // Below `MIN_EDIT_SELECTION_PX` this is a slipped mouse, not an intent to
    // edit — and it must not become an intent to erase either, so whatever was
    // selected a moment ago survives.
    setRejectedDrag(true)
  }

  function cancelDrag() {
    dragRef.current = null
    setDragRect(null)
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const delta = ARROW_DELTAS[event.key]
    if (!delta) return
    const current = geometryOf(imgRef.current)
    if (!current) return
    event.preventDefault()
    if (!selection) {
      // Nothing to nudge yet: seed a centred box so the keyboard path can reach a
      // selection without ever touching a pointer.
      const width = Math.max(MIN_EDIT_SELECTION_PX, Math.round(current.width / 2))
      const height = Math.max(MIN_EDIT_SELECTION_PX, Math.round(current.height / 2))
      const seeded = clampEditSelection(
        {
          x: Math.round((current.width - width) / 2),
          y: Math.round((current.height - height) / 2),
          width,
          height,
        },
        current.width,
        current.height,
      )
      if (seeded) onSelectionChange(seeded)
      return
    }
    const dx = delta[0] * Math.max(1, Math.round(current.width * KEYBOARD_STEP_RATIO))
    const dy = delta[1] * Math.max(1, Math.round(current.height * KEYBOARD_STEP_RATIO))
    // Shift resizes the far edge, plain arrows translate the box whole: clipping a
    // move against the border would shrink the region every time it hit an edge.
    const next = event.shiftKey
      ? {
          ...selection,
          width: clampInt(selection.width + dx, MIN_EDIT_SELECTION_PX, current.width - selection.x),
          height: clampInt(selection.height + dy, MIN_EDIT_SELECTION_PX, current.height - selection.y),
        }
      : {
          ...selection,
          x: clampInt(selection.x + dx, 0, current.width - selection.width),
          y: clampInt(selection.y + dy, 0, current.height - selection.height),
        }
    const valid = clampEditSelection(next, current.width, current.height)
    if (valid) onSelectionChange(valid)
  }

  // A selection that changed anywhere — a commit, a clear, a keyboard nudge —
  // retires the "too small" notice: it describes the drag that just failed, not
  // the state on screen now.
  useEffect(() => {
    setRejectedDrag(false)
  }, [selection])

  const committedRect =
    geometry && selection
      ? imageSelectionToDisplaySelection(selection, geometry.content, geometry.width, geometry.height)
      : null
  const paintRect = dragRect ?? committedRect
  const paintStyle = paintRect && geometry ? toLocalStyle(paintRect, geometry.box) : undefined
  const ratio = stageAspectRatio(
    undefined,
    geometry?.width ?? declaredWidth,
    geometry?.height ?? declaredHeight,
  )

  const status =
    phase === 'failed'
      ? '源图加载失败，签名链接可能已过期，请退出后重新进入局部修改'
      : rejectedDrag
        ? '框选范围过小，已忽略本次拖动'
        : selection
          ? `选区 ${selection.width}×${selection.height} 像素，起点 (${selection.x}, ${selection.y})`
          : '尚未框选'

  return (
    <div className="flex w-full flex-col items-center gap-3">
      <div
        role="group"
        aria-label="局部修改选区画布"
        aria-describedby="edit-region-stage-hint"
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={cancelDrag}
        onLostPointerCapture={cancelDrag}
        onKeyDown={handleKeyDown}
        style={{ aspectRatio: ratio }}
        className={`relative max-h-[68vh] w-full max-w-3xl touch-none select-none overflow-hidden rounded-[var(--radius-control)] bg-surface-subtle ${
          phase === 'ready' ? 'cursor-crosshair' : 'cursor-default'
        }`}
      >
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          draggable={false}
          onLoad={handleLoad}
          onError={() => setLoad({ src, phase: 'failed' })}
          className="absolute inset-0 h-full w-full object-contain"
        />

        {paintStyle ? (
          <span aria-hidden="true" className="pointer-events-none absolute inset-0 block">
            <span
              className="absolute block border-2 border-accent"
              style={{ ...paintStyle, boxShadow: DIM_STYLE }}
            />
          </span>
        ) : null}

        {phase === 'loading' ? (
          <span aria-hidden="true" className="motion-shimmer pointer-events-none absolute inset-0" />
        ) : null}

        {phase === 'failed' ? (
          // Static, no animation: reduced motion must stay legible. The sentence
          // lives in the status line below, which is also the live region — the
          // same split `media-frame.tsx` uses for a dead preview.
          <span className="absolute inset-0 flex items-center justify-center">
            <ImageOff aria-hidden="true" className="h-5 w-5 text-muted-foreground/50" />
          </span>
        ) : null}
      </div>

      <div className="flex w-full max-w-3xl flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p id="edit-region-stage-hint" className="text-xs text-muted-foreground">
            按住并拖动以框选要修改的区域 · 方向键移动选区，Shift + 方向键调整大小 · Esc 清除选区
          </p>
          {/* Mounted before it has anything to say, so the first commit is a change
              a screen reader actually announces. */}
          <p role="status" aria-live="polite" className="font-mono text-xs tabular-nums text-muted-foreground">
            {status}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onSelectionChange(null)}
          disabled={!selection}
          className="flex min-h-8 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface px-2.5 py-1 text-xs text-foreground transition-colors duration-[var(--motion-fast)] hover:bg-surface-subtle disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Eraser className="h-3.5 w-3.5" aria-hidden="true" />
          清除选区
        </button>
      </div>
    </div>
  )
}
