import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MIN_EDIT_SELECTION_PX,
  MASK_EDIT_ALPHA,
  MASK_KEEP_ALPHA,
  MASK_INPUT_ROLE,
  buildInpaintPrompt,
  clampEditSelection,
  displaySelectionToImageSelection,
  editSelectionIsUsable,
  imageContentBox,
  imageSelectionToDisplaySelection,
  isPointInsideRenderBox,
  parseRectangleRegion,
  visibleImageBox,
} from './image-edit'

const IMAGE = 2048
/** The user's reference case: a 2048x2048 image rendered at 768x768. */
const BOX = { left: 0, top: 0, width: 768, height: 768 }

test('clampEditSelection folds a reversed drag and clips to the image', () => {
  // Bottom-right -> top-left: negative extents describe the same rectangle.
  assert.deepEqual(clampEditSelection({ x: 340, y: 480, width: -20, height: -30 }, 1024, 1024), {
    x: 320,
    y: 450,
    width: 20,
    height: 30,
  })
  // A drag that hangs off every edge clamps to the edge instead of growing.
  assert.deepEqual(clampEditSelection({ x: -500, y: -500, width: 4000, height: 4000 }, 1024, 768), {
    x: 0,
    y: 0,
    width: 1024,
    height: 768,
  })
})

test('clampEditSelection can never emit a region wider than the image', () => {
  for (const width of [1, 33, 1023, 1024]) {
    for (const x of [0, 1, 511, 1000, 1023, 1024]) {
      const clamped = clampEditSelection({ x, y: 0, width, height: width }, width, width)
      if (!clamped) continue
      assert.ok(clamped.x + clamped.width <= width, `overflow on ${width}: ${JSON.stringify(clamped)}`)
      assert.ok(clamped.y + clamped.height <= width, `overflow on ${width}: ${JSON.stringify(clamped)}`)
    }
  }
})

test('clampEditSelection rejects degenerate and non-finite selections', () => {
  assert.equal(clampEditSelection({ x: 10, y: 10, width: 0, height: 100 }, 1024, 1024), null)
  assert.equal(clampEditSelection({ x: 10, y: 10, width: -100, height: 0 }, 1024, 1024), null)
  assert.equal(
    clampEditSelection({ x: 10, y: 10, width: MIN_EDIT_SELECTION_PX - 1, height: 400 }, 1024, 1024),
    null,
  )
  assert.equal(clampEditSelection({ x: NaN, y: 10, width: 100, height: 100 }, 1024, 1024), null)
  assert.equal(clampEditSelection({ x: 10, y: 10, width: 100, height: Infinity }, 1024, 1024), null)
  // An unloaded image reports 0x0: nothing may be selected on it.
  assert.equal(clampEditSelection({ x: 10, y: 10, width: 100, height: 100 }, 0, 0), null)
})

test('imageContentBox accounts for letterboxing and cover overflow', () => {
  // 800x600 element holding a square image: contain pillarboxes it to 600x600.
  const element = { left: 0, top: 0, width: 800, height: 600 }
  assert.deepEqual(imageContentBox(element, 'contain', 1024, 1024), {
    left: 100,
    top: 0,
    width: 600,
    height: 600,
  })
  // cover fills the box and overflows vertically by 100px on each side.
  const cover = imageContentBox(element, 'cover', 1024, 1024)
  assert.deepEqual(cover, { left: 0, top: -100, width: 800, height: 800 })
  // The visible window is what the user may select inside.
  assert.deepEqual(visibleImageBox(cover, element), { left: 0, top: 0, width: 800, height: 600 })
  // fill stretches, so element and content coincide.
  assert.deepEqual(imageContentBox(element, 'fill', 1024, 1024), element)
  // Zero-size (hidden / not yet laid out) yields an empty box.
  assert.deepEqual(imageContentBox({ left: 0, top: 0, width: 0, height: 0 }, 'contain', 1024, 1024), {
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  })
})

test('displaySelectionToImageSelection maps CSS pixels onto source pixels', () => {
  // 2048/768 = 2.667 scale, so a 200x300 drag becomes ~533x800 source pixels.
  assert.deepEqual(
    displaySelectionToImageSelection({ x: 100, y: 100, width: 200, height: 300 }, BOX, IMAGE, IMAGE),
    { x: 267, y: 267, width: 533, height: 800 },
  )
  // Coordinates are independent of the element's position in the page.
  assert.deepEqual(
    displaySelectionToImageSelection({ x: 300, y: 300, width: 200, height: 300 }, { ...BOX, left: 200, top: 200 }, IMAGE, IMAGE),
    { x: 267, y: 267, width: 533, height: 800 },
  )
})

test('a drag outside the painted image yields no selection', () => {
  const letterboxed = { left: 100, top: 0, width: 600, height: 600 }
  // Fully inside the pillarbox gap.
  assert.equal(displaySelectionToImageSelection({ x: 0, y: 0, width: 90, height: 500 }, letterboxed, 1024, 1024), null)
  // Touching the gap but crossing into the image: only the image part counts.
  assert.deepEqual(
    displaySelectionToImageSelection({ x: 50, y: 100, width: 200, height: 200 }, letterboxed, 1024, 1024),
    { x: 0, y: 171, width: 256, height: 341 },
  )
})

test('display <-> image mapping round-trips within a pixel', () => {
  const contentBox = imageContentBox({ left: 0, top: 0, width: 800, height: 600 }, 'contain', 1536, 1024)
  const dragged = { x: 120, y: 60, width: 240, height: 180 }
  const imageSelection = displaySelectionToImageSelection(dragged, contentBox, 1536, 1024)
  assert.ok(imageSelection)
  const repainted = imageSelectionToDisplaySelection(imageSelection, contentBox, 1536, 1024)
  assert.ok(Math.abs(repainted.x - dragged.x) <= 1, `x drifted: ${repainted.x}`)
  assert.ok(Math.abs(repainted.y - dragged.y) <= 1, `y drifted: ${repainted.y}`)
  assert.ok(Math.abs(repainted.width - dragged.width) <= 1, `w drifted: ${repainted.width}`)
  assert.ok(Math.abs(repainted.height - dragged.height) <= 1, `h drifted: ${repainted.height}`)
  // Resizing the viewport must not move the selection in image space: repaint
  // from a smaller box and re-read it back.
  const shrunk = imageContentBox({ left: 0, top: 0, width: 400, height: 300 }, 'contain', 1536, 1024)
  assert.deepEqual(
    displaySelectionToImageSelection(
      imageSelectionToDisplaySelection(imageSelection, shrunk, 1536, 1024),
      shrunk,
      1536,
      1024,
    ),
    imageSelection,
  )
})

test('isPointInsideRenderBox gates where a drag may begin', () => {
  const box = { left: 10, top: 10, width: 100, height: 50 }
  assert.equal(isPointInsideRenderBox({ x: 10, y: 10 }, box), true)
  assert.equal(isPointInsideRenderBox({ x: 110, y: 60 }, box), true)
  assert.equal(isPointInsideRenderBox({ x: 9, y: 20 }, box), false)
  assert.equal(isPointInsideRenderBox({ x: 20, y: 61 }, box), false)
  assert.equal(isPointInsideRenderBox({ x: 20, y: 20 }, { left: 0, top: 0, width: 0, height: 0 }), false)
})

test('buildInpaintPrompt keeps the user request verbatim and last', () => {
  const request = '把这里的黑色 T 恤改成深蓝色牛仔夹克，其他内容保持不变'
  const wrapped = buildInpaintPrompt(`  ${request}  `)
  assert.ok(wrapped.endsWith(request))
  assert.match(wrapped, /only the selected region/i)
  assert.match(wrapped, /outside the selected region/i)
  assert.match(wrapped, /composition, lighting, perspective/i)
})

test('parseRectangleRegion accepts only finite rectangles', () => {
  assert.deepEqual(parseRectangleRegion({ type: 'rectangle', x: 1, y: 2, width: 3, height: 4 }), {
    type: 'rectangle',
    x: 1,
    y: 2,
    width: 3,
    height: 4,
  })
  // The wire form omits the discriminator; brush/lasso regions never arrive here.
  assert.ok(parseRectangleRegion({ x: 1, y: 2, width: 3, height: 4 }))
  assert.equal(parseRectangleRegion({ type: 'mask', x: 1, y: 2, width: 3, height: 4 }), null)
  assert.equal(parseRectangleRegion({ x: 1, y: 2, width: 3 }), null)
  assert.equal(parseRectangleRegion({ x: 1, y: 2, width: '3', height: 4 }), null)
  assert.equal(parseRectangleRegion('"x":1'), null)
  assert.equal(parseRectangleRegion(null), null)
})

test('mask convention and role are unambiguous', () => {
  assert.equal(MASK_INPUT_ROLE, 'mask')
  assert.ok(MASK_EDIT_ALPHA < MASK_KEEP_ALPHA)
  assert.equal(editSelectionIsUsable({ x: 0, y: 0, width: MIN_EDIT_SELECTION_PX, height: MIN_EDIT_SELECTION_PX }), true)
  assert.equal(editSelectionIsUsable({ x: 0, y: 0, width: MIN_EDIT_SELECTION_PX - 1, height: 40 }), false)
  assert.equal(editSelectionIsUsable(null), false)
})
