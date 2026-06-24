<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

interface FlowLine {
  x: number
  y: number
  length: number
  speed: number
  opacity: number
  width: number
  angle: number
  curveOffset: number
  curveSpeed: number
}

const canvasRef = ref<HTMLCanvasElement | null>(null)
let animationFrameId = 0
let resizeObserver: ResizeObserver | null = null

function createLines(width: number, height: number): FlowLine[] {
  const count = Math.min(Math.floor((width * height) / 40000), 60)
  const lines: FlowLine[] = []
  for (let i = 0; i < count; i++) {
    lines.push({
      x: Math.random() * width,
      y: Math.random() * height,
      length: Math.random() * 150 + 50,
      speed: Math.random() * 0.3 + 0.1,
      opacity: Math.random() * 0.3 + 0.05,
      width: Math.random() * 1.5 + 0.3,
      angle: Math.random() * Math.PI * 2,
      curveOffset: Math.random() * Math.PI * 2,
      curveSpeed: Math.random() * 0.01 + 0.005,
    })
  }
  return lines
}

onMounted(() => {
  const canvas = canvasRef.value
  if (!canvas) return

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  let width = canvas.offsetWidth
  let height = canvas.offsetHeight
  const dpr = window.devicePixelRatio || 1

  function setSize() {
    width = canvas!.offsetWidth
    height = canvas!.offsetHeight
    canvas!.width = width * dpr
    canvas!.height = height * dpr
    ctx!.scale(dpr, dpr)
  }

  setSize()

  const lines = createLines(width, height)
  let time = 0

  function draw() {
    time++
    ctx!.clearRect(0, 0, width, height)

    for (const line of lines) {
      // Update line position
      line.x += Math.cos(line.angle) * line.speed
      line.y += Math.sin(line.angle) * line.speed
      line.curveOffset += line.curveSpeed

      // Wrap around
      if (line.x < -line.length) line.x = width + line.length
      if (line.x > width + line.length) line.x = -line.length
      if (line.y < -line.length) line.y = height + line.length
      if (line.y > height + line.length) line.y = -line.length

      // Calculate end point with curve
      const curveX = Math.sin(time * line.curveSpeed + line.curveOffset) * 30
      const curveY = Math.cos(time * line.curveSpeed + line.curveOffset) * 30
      const endX = line.x + Math.cos(line.angle) * line.length + curveX
      const endY = line.y + Math.sin(line.angle) * line.length + curveY

      // Draw line with gradient
      const gradient = ctx!.createLinearGradient(line.x, line.y, endX, endY)
      gradient.addColorStop(0, `rgba(22, 138, 73, 0)`)
      gradient.addColorStop(0.3, `rgba(22, 138, 73, ${line.opacity})`)
      gradient.addColorStop(0.7, `rgba(22, 138, 73, ${line.opacity})`)
      gradient.addColorStop(1, `rgba(22, 138, 73, 0)`)

      ctx!.beginPath()
      ctx!.moveTo(line.x, line.y)
      ctx!.quadraticCurveTo(
        line.x + (endX - line.x) / 2 + curveX * 0.5,
        line.y + (endY - line.y) / 2 + curveY * 0.5,
        endX,
        endY
      )
      ctx!.strokeStyle = gradient
      ctx!.lineWidth = line.width
      ctx!.lineCap = 'round'
      ctx!.stroke()
    }

    animationFrameId = requestAnimationFrame(draw)
  }

  draw()

  resizeObserver = new ResizeObserver(() => {
    setSize()
  })
  resizeObserver.observe(canvas)

  onUnmounted(() => {
    cancelAnimationFrame(animationFrameId)
    resizeObserver?.disconnect()
  })
})
</script>

<template>
  <canvas
    ref="canvasRef"
    class="pointer-events-none absolute inset-0 h-full w-full"
  />
</template>
