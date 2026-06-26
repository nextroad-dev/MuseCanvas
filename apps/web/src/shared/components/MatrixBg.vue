<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

interface GridNode {
  x: number
  y: number
  basePhase: number
  activity: number
}

interface Props {
  /** Base color. 'primary' reads the CSS --color-primary token. Any valid CSS color string works. */
  color?: string
  /** Distance in px between grid nodes. */
  gridSpacing?: number
  /** Base dot radius in px. */
  dotSize?: number
  /** Stroke opacity for grid connections. */
  lineOpacity?: number
  /** Fill opacity for inactive nodes. */
  dotOpacity?: number
  /** Speed of the computation pulse wave. */
  pulseSpeed?: number
  /** Global animation speed multiplier. 0 renders one static frame. */
  speed?: number
  /** Whether to connect diagonal neighbors as well. */
  connectDiagonals?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  color: 'primary',
  gridSpacing: 40,
  dotSize: 1.5,
  lineOpacity: 0.12,
  dotOpacity: 0.45,
  pulseSpeed: 1,
  speed: 1,
  connectDiagonals: false,
})

const canvasRef = ref<HTMLCanvasElement | null>(null)
let animationFrameId = 0
let resizeObserver: ResizeObserver | null = null
let reducedMotionQuery: MediaQueryList | null = null
let reducedMotionHandler: (() => void) | null = null

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function parseHexColor(hex: string): { r: number; g: number; b: number } | null {
  const normalized = hex.trim()
  const shorthand = /^#([a-f\d])([a-f\d])([a-f\d])$/i.exec(normalized)
  if (shorthand) {
    return {
      r: parseInt(shorthand[1] + shorthand[1], 16),
      g: parseInt(shorthand[2] + shorthand[2], 16),
      b: parseInt(shorthand[3] + shorthand[3], 16),
    }
  }
  const full = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(normalized)
  if (full) {
    return {
      r: parseInt(full[1], 16),
      g: parseInt(full[2], 16),
      b: parseInt(full[3], 16),
    }
  }
  return null
}

function parseRgbColor(input: string): { r: number; g: number; b: number } | null {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(input)
  if (match) {
    return {
      r: parseInt(match[1], 10),
      g: parseInt(match[2], 10),
      b: parseInt(match[3], 10),
    }
  }
  return null
}

function parseCssColor(input: string): { r: number; g: number; b: number } | null {
  const fromHex = parseHexColor(input)
  if (fromHex) return fromHex
  const fromRgb = parseRgbColor(input)
  if (fromRgb) return fromRgb

  // Fallback: let the browser resolve the color by applying it to a temporary element.
  const probe = document.createElement('div')
  probe.style.color = input
  probe.style.position = 'fixed'
  probe.style.opacity = '0'
  probe.style.pointerEvents = 'none'
  document.body.appendChild(probe)
  const computed = window.getComputedStyle(probe).color
  document.body.removeChild(probe)
  return parseRgbColor(computed)
}

function resolveColor(): { r: number; g: number; b: number } {
  let raw = props.color
  if (raw === 'primary') {
    raw = getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim()
  }
  const parsed = parseCssColor(raw || '#168A49')
  if (parsed) return parsed
  return { r: 22, g: 138, b: 73 }
}

function createGrid(width: number, height: number): GridNode[] {
  const spacing = clamp(props.gridSpacing, 12, 200)
  const cols = Math.ceil(width / spacing) + 1
  const rows = Math.ceil(height / spacing) + 1
  const nodes: GridNode[] = []

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      nodes.push({
        x: col * spacing,
        y: row * spacing,
        basePhase: Math.random() * Math.PI * 2,
        activity: 0,
      })
    }
  }

  return nodes
}

onMounted(() => {
  const canvas = canvasRef.value
  if (!canvas) return

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const color = resolveColor()
  const dpr = window.devicePixelRatio || 1
  let width = canvas.offsetWidth
  let height = canvas.offsetHeight
  let nodes = createGrid(width, height)
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
    nodes = createGrid(width, height)
  }

  function updateActivity() {
    if (isStatic()) return

    const waveSpeed = 0.015 * props.pulseSpeed * props.speed
    const cols = Math.ceil(width / props.gridSpacing) + 1

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      const col = i % cols
      const row = Math.floor(i / cols)

      // Traveling diagonal wave across the grid.
      const wave = Math.sin((col + row) * 0.25 + time * waveSpeed + node.basePhase)
      const pulse = Math.max(0, wave)

      // Target activity is driven by the wave; current activity decays toward it.
      const target = pulse * pulse * 0.85
      node.activity += (target - node.activity) * 0.08 * props.speed
    }
  }

  function drawLine(a: GridNode, b: GridNode) {
    const avgActivity = (a.activity + b.activity) / 2
    const dynamicOpacity = props.lineOpacity + avgActivity * 0.35
    const dynamicWidth = 0.5 + avgActivity * 1.2

    ctx!.beginPath()
    ctx!.moveTo(a.x, a.y)
    ctx!.lineTo(b.x, b.y)
    ctx!.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${clamp(dynamicOpacity, 0, 0.9)})`
    ctx!.lineWidth = dynamicWidth
    ctx!.stroke()
  }

  function drawConnections() {
    const cols = Math.ceil(width / props.gridSpacing) + 1
    const rows = Math.ceil(height / props.gridSpacing) + 1

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      const col = i % cols
      const row = Math.floor(i / cols)

      // Right neighbor.
      if (col < cols - 1) {
        drawLine(node, nodes[i + 1])
      }
      // Bottom neighbor.
      if (row < rows - 1) {
        drawLine(node, nodes[i + cols])
      }
      // Diagonal neighbors.
      if (props.connectDiagonals) {
        if (col < cols - 1 && row < rows - 1) {
          drawLine(node, nodes[i + cols + 1])
        }
        if (col > 0 && row < rows - 1) {
          drawLine(node, nodes[i + cols - 1])
        }
      }
    }
  }

  function drawNodes() {
    for (const node of nodes) {
      const pulse = node.activity
      const currentOpacity = clamp(props.dotOpacity + pulse * 0.55, 0, 1)
      const currentSize = props.dotSize * (1 + pulse * 0.8)

      ctx!.beginPath()
      ctx!.arc(node.x, node.y, currentSize, 0, Math.PI * 2)
      ctx!.fillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${currentOpacity})`
      ctx!.fill()

      // Soft glow for active nodes.
      if (pulse > 0.05) {
        ctx!.beginPath()
        ctx!.arc(node.x, node.y, currentSize * 4, 0, Math.PI * 2)
        ctx!.fillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${pulse * 0.08})`
        ctx!.fill()
      }
    }
  }

  function render() {
    ctx!.clearRect(0, 0, width, height)

    if (!isStatic()) {
      time++
      updateActivity()
    }

    drawConnections()
    drawNodes()
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
