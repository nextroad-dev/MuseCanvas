<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'

interface MosaicBlock {
  x: number
  y: number
  width: number
  height: number
  rotation: number
  rotationSpeed: number
  vx: number
  vy: number
  opacity: number
  targetOpacity: number
  radius: number
  hue: number
  saturation: number
  lightness: number
  phase: number
}

interface Props {
  /** Base color. 'primary' reads the CSS --color-primary token. */
  color?: string
  /** Block density multiplier. */
  density?: number
  /** Global speed multiplier. 0 renders one static frame. */
  speed?: number
  /** Max opacity for blocks. */
  maxOpacity?: number
  /** Whether blocks converge toward center. */
  converge?: boolean
  /** Convergence intensity (0–1). Higher = faster convergence. */
  intensity?: number
  /** Trigger a burst (blocks explode outward then fade). */
  burst?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  color: 'primary',
  density: 1,
  speed: 1,
  maxOpacity: 0.08,
  converge: false,
  intensity: 0.5,
  burst: false,
})

const canvasRef = ref<HTMLCanvasElement | null>(null)
let animationFrameId = 0
let resizeObserver: ResizeObserver | null = null
let reducedMotionQuery: MediaQueryList | null = null
let reducedMotionHandler: (() => void) | null = null
let blocks: MosaicBlock[] = []
let width = 0
let height = 0
let burstActive = false
let burstTime = 0

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * Resolve a brand-friendly HSL palette from the primary color.
 * Returns { h, s, l } for the base, and we derive teal/mint variations from it.
 */
function resolveBaseHSL(): { h: number; s: number; l: number } {
  let raw = props.color
  if (raw === 'primary') {
    raw = getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim()
  }

  // Try to parse hex
  const hex = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(raw || '#168A49')
  if (hex) {
    const r = parseInt(hex[1], 16) / 255
    const g = parseInt(hex[2], 16) / 255
    const b = parseInt(hex[3], 16) / 255
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const l = (max + min) / 2
    let h = 0
    let s = 0
    if (max !== min) {
      const d = max - min
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
      else if (max === g) h = ((b - r) / d + 2) / 6
      else h = ((r - g) / d + 4) / 6
    }
    return { h: h * 360, s: s * 100, l: l * 100 }
  }

  // Default: MuseCanvas green
  return { h: 148, s: 74, l: 31 }
}

function createBlocks(w: number, h: number): MosaicBlock[] {
  const area = w * h
  const baseCount = Math.floor((area / 25000) * props.density)
  const count = clamp(baseCount, 15, 100)
  const result: MosaicBlock[] = []
  const base = resolveBaseHSL()

  for (let i = 0; i < count; i++) {
    // Vary the hue within the green→teal→mint range (±30 degrees)
    const hueOffset = (Math.random() - 0.5) * 60
    const size = 20 + Math.random() * 60

    result.push({
      x: Math.random() * w,
      y: Math.random() * h,
      width: size + Math.random() * 40,
      height: size + Math.random() * 30,
      rotation: Math.random() * Math.PI * 2,
      rotationSpeed: (Math.random() - 0.5) * 0.003,
      vx: (Math.random() - 0.5) * 0.4,
      vy: (Math.random() - 0.5) * 0.3,
      opacity: 0,
      targetOpacity: (Math.random() * 0.6 + 0.4) * props.maxOpacity,
      radius: 4 + Math.random() * 12,
      hue: base.h + hueOffset,
      saturation: clamp(base.s + (Math.random() - 0.5) * 20, 30, 100),
      lightness: clamp(base.l + Math.random() * 25, 25, 65),
      phase: Math.random() * Math.PI * 2,
    })
  }

  return result
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + w - radius, y)
  ctx.arcTo(x + w, y, x + w, y + radius, radius)
  ctx.lineTo(x + w, y + h - radius)
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius)
  ctx.lineTo(x + radius, y + h)
  ctx.arcTo(x, y + h, x, y + h - radius, radius)
  ctx.lineTo(x, y + radius)
  ctx.arcTo(x, y, x + radius, y, radius)
  ctx.closePath()
}

onMounted(() => {
  const canvas = canvasRef.value
  if (!canvas) return

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const dpr = window.devicePixelRatio || 1
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
    blocks = createBlocks(width, height)
  }

  function updateBlocks() {
    if (isStatic()) return

    const speedMult = props.speed
    const centerX = width / 2
    const centerY = height / 2

    for (const block of blocks) {
      // Fade in
      block.opacity += (block.targetOpacity - block.opacity) * 0.02 * speedMult

      if (burstActive) {
        // Burst: blocks explode outward and fade
        const dx = block.x - centerX
        const dy = block.y - centerY
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        const burstForce = 8 * speedMult
        block.x += (dx / dist) * burstForce
        block.y += (dy / dist) * burstForce
        block.opacity *= 0.96
        burstTime++
        if (burstTime > 60) {
          burstActive = false
          burstTime = 0
        }
      } else if (props.converge) {
        // Converge: blocks drift toward center
        const dx = centerX - block.x
        const dy = centerY - block.y
        const convergePower = 0.002 * props.intensity * speedMult
        block.vx += dx * convergePower
        block.vy += dy * convergePower
        // Damping
        block.vx *= 0.98
        block.vy *= 0.98
        block.x += block.vx
        block.y += block.vy
      } else {
        // Normal drift
        block.x += block.vx * speedMult
        block.y += block.vy * speedMult
      }

      block.rotation += block.rotationSpeed * speedMult

      // Opacity pulse
      const pulse = Math.sin(time * 0.01 + block.phase) * 0.3 + 0.7
      block.opacity = clamp(block.opacity * pulse, 0, props.maxOpacity)

      // Wrap around (with margin)
      const margin = Math.max(block.width, block.height) * 1.5
      if (block.x < -margin) block.x = width + margin * 0.5
      if (block.x > width + margin) block.x = -margin * 0.5
      if (block.y < -margin) block.y = height + margin * 0.5
      if (block.y > height + margin) block.y = -margin * 0.5
    }
  }

  function drawBlocks() {
    // Use screen blending for overlap glow
    ctx!.globalCompositeOperation = 'screen'

    for (const block of blocks) {
      if (block.opacity < 0.002) continue

      ctx!.save()
      ctx!.translate(block.x, block.y)
      ctx!.rotate(block.rotation)

      const color = `hsla(${block.hue}, ${block.saturation}%, ${block.lightness}%, ${block.opacity})`
      ctx!.fillStyle = color
      roundRect(ctx!, -block.width / 2, -block.height / 2, block.width, block.height, block.radius)
      ctx!.fill()

      ctx!.restore()
    }

    ctx!.globalCompositeOperation = 'source-over'
  }

  function drawEdgeFade() {
    // Top fade
    const topGrad = ctx!.createLinearGradient(0, 0, 0, height * 0.15)
    topGrad.addColorStop(0, 'rgba(247, 248, 246, 1)')
    topGrad.addColorStop(1, 'rgba(247, 248, 246, 0)')
    ctx!.fillStyle = topGrad
    ctx!.fillRect(0, 0, width, height * 0.15)

    // Bottom fade
    const bottomGrad = ctx!.createLinearGradient(0, height * 0.85, 0, height)
    bottomGrad.addColorStop(0, 'rgba(247, 248, 246, 0)')
    bottomGrad.addColorStop(1, 'rgba(247, 248, 246, 1)')
    ctx!.fillStyle = bottomGrad
    ctx!.fillRect(0, height * 0.85, width, height * 0.15)
  }

  function render() {
    ctx!.clearRect(0, 0, width, height)
    time++
    updateBlocks()
    drawBlocks()
    drawEdgeFade()
  }

  function stopLoop() {
    cancelAnimationFrame(animationFrameId)
    animationFrameId = 0
  }

  function startLoop() {
    stopLoop()
    if (isStatic()) {
      // Draw one static frame
      for (const block of blocks) {
        block.opacity = block.targetOpacity * 0.7
      }
      ctx!.clearRect(0, 0, width, height)
      drawBlocks()
      drawEdgeFade()
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

// Watch for burst trigger
watch(
  () => props.burst,
  (newVal) => {
    if (newVal) {
      burstActive = true
      burstTime = 0
    }
  },
)

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
