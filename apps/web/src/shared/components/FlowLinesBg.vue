<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { readCssVar, resolveCssColor, type Rgb } from '@/shared/lib/css-color'

interface FlowLine {
  x: number
  y: number
  length: number
  angle: number
  speed: number
  opacity: number
  width: number
  amplitude: number
  phase: number
  phaseSpeed: number
  layer: number
}

interface Props {
  /** Base color. 'primary' reads the CSS --color-primary token. Any valid CSS color string works. */
  color?: string
  /** Density multiplier relative to the viewport area. 0.5 = sparse, 1.5 = dense. */
  density?: number
  /** Global speed multiplier for drift and undulation. 0 renders one static frame. */
  speed?: number
  /** Number of depth layers. Back layers move slower and are thinner/more transparent. */
  layers?: number
  /** Base stroke width in px. */
  lineWidth?: number
}

const props = withDefaults(defineProps<Props>(), {
  color: 'primary',
  density: 1,
  speed: 1,
  layers: 3,
  lineWidth: 1,
})

const canvasRef = ref<HTMLCanvasElement | null>(null)
let animationFrameId = 0
let resizeObserver: ResizeObserver | null = null
let reducedMotionQuery: MediaQueryList | null = null
let reducedMotionHandler: (() => void) | null = null

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function resolveColor(): Rgb | null {
  const raw = props.color === 'primary' ? readCssVar('--color-primary') : props.color
  return resolveCssColor(raw)
}

function createLines(width: number, height: number): FlowLine[] {
  const area = width * height
  const baseCount = Math.floor((area / 22000) * props.density)
  const count = clamp(baseCount, 20, 180)
  const lines: FlowLine[] = []

  for (let i = 0; i < count; i++) {
    const layer = Math.floor(Math.random() * props.layers)
    const depth = props.layers <= 1 ? 1 : layer / (props.layers - 1)

    // Depth 0 = far/background (slow, thin, transparent)
    // Depth 1 = near/foreground (faster, thicker, more opaque)
    const length = 350 + Math.random() * 650
    // Keep lines almost horizontal for a calm, left-to-right flow.
    const angle = (Math.random() - 0.5) * 0.08

    lines.push({
      x: Math.random() * width,
      y: Math.random() * height,
      length,
      angle,
      speed: (0.15 + depth * 0.45) * (0.8 + Math.random() * 0.4),
      opacity: 0.04 + depth * 0.18,
      width: (0.3 + depth * 1.4) * props.lineWidth,
      amplitude: 30 + Math.random() * 60,
      phase: Math.random() * Math.PI * 2,
      phaseSpeed: 0.005 + Math.random() * 0.01,
      layer,
    })
  }

  // Draw far layers first.
  return lines.sort((a, b) => a.layer - b.layer)
}

onMounted(() => {
  const canvas = canvasRef.value
  if (!canvas) return

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const resolved = resolveColor()
  // Design token missing or unresolvable: render nothing rather than a hardcoded color.
  if (!resolved) return
  const color: Rgb = resolved
  const dpr = window.devicePixelRatio || 1
  let width = canvas.offsetWidth
  let height = canvas.offsetHeight
  let lines = createLines(width, height)
  let time = 0

  reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')

  function isStatic(): boolean {
    return !reducedMotionQuery || reducedMotionQuery.matches || props.speed === 0
  }

  function setSize() {
    width = canvas!.offsetWidth
    height = canvas!.offsetHeight
    canvas!.width = width * dpr
    canvas!.height = height * dpr
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
    lines = createLines(width, height)
  }

  function drawLine(line: FlowLine) {
    const speedMultiplier = props.speed
    const segments = 5
    const dx = Math.cos(line.angle) * line.length
    const dy = Math.sin(line.angle) * line.length

    const points: { x: number; y: number }[] = []
    for (let i = 0; i <= segments; i++) {
      const t = i / segments
      // Apply the undulation perpendicular to the (nearly horizontal) line.
      const wave = Math.sin(time * line.phaseSpeed + line.phase + t * Math.PI * 2) * line.amplitude
      points.push({
        x: line.x + dx * t,
        y: line.y + dy * t + wave * speedMultiplier,
      })
    }

    const start = points[0]
    const end = points[points.length - 1]
    const gradient = ctx!.createLinearGradient(start.x, start.y, end.x, end.y)
    gradient.addColorStop(0, `rgba(${color.r}, ${color.g}, ${color.b}, 0)`)
    gradient.addColorStop(0.25, `rgba(${color.r}, ${color.g}, ${color.b}, ${line.opacity})`)
    gradient.addColorStop(0.75, `rgba(${color.r}, ${color.g}, ${color.b}, ${line.opacity})`)
    gradient.addColorStop(1, `rgba(${color.r}, ${color.g}, ${color.b}, 0)`)

    ctx!.beginPath()
    ctx!.moveTo(start.x, start.y)
    for (let i = 1; i < points.length - 1; i++) {
      const midX = (points[i].x + points[i + 1].x) / 2
      const midY = (points[i].y + points[i + 1].y) / 2
      ctx!.quadraticCurveTo(points[i].x, points[i].y, midX, midY)
    }
    ctx!.lineTo(end.x, end.y)
    ctx!.strokeStyle = gradient
    ctx!.lineWidth = line.width
    ctx!.lineCap = 'round'
    ctx!.lineJoin = 'round'
    ctx!.stroke()
  }

  function updateLine(line: FlowLine) {
    const speedMultiplier = props.speed
    line.x += line.speed * speedMultiplier
    line.y += Math.sin(line.angle) * line.speed * 0.15 * speedMultiplier
    line.phase += line.phaseSpeed * speedMultiplier

    const margin = line.length + line.amplitude
    if (line.x < -margin) line.x = width + margin
    if (line.x > width + margin) line.x = -margin
    if (line.y < -margin) line.y = height + margin
    if (line.y > height + margin) line.y = -margin
  }

  function render() {
    ctx!.clearRect(0, 0, width, height)

    if (!isStatic()) {
      time++
      for (const line of lines) {
        updateLine(line)
      }
    }

    for (const line of lines) {
      drawLine(line)
    }
  }

  function stopLoop() {
    cancelAnimationFrame(animationFrameId)
    animationFrameId = 0
  }

  function startLoop() {
    stopLoop()
    if (isStatic()) {
      render()
      return
    }

    function tick() {
      render()
      if (!isStatic()) {
        animationFrameId = requestAnimationFrame(tick)
      } else {
        animationFrameId = 0
      }
    }

    tick()
  }

  function handleReducedMotionChange() {
    startLoop()
  }

  reducedMotionHandler = handleReducedMotionChange
  reducedMotionQuery.addEventListener('change', reducedMotionHandler)

  setSize()
  startLoop()

  resizeObserver = new ResizeObserver(() => {
    setSize()
    startLoop()
  })
  resizeObserver.observe(canvas)
})

onUnmounted(() => {
  cancelAnimationFrame(animationFrameId)
  resizeObserver?.disconnect()
  if (reducedMotionQuery && reducedMotionHandler) {
    reducedMotionQuery.removeEventListener('change', reducedMotionHandler)
  }
})
</script>

<template>
  <canvas
    ref="canvasRef"
    class="pointer-events-none absolute inset-0 h-full w-full"
  />
</template>
