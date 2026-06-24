<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  size: number
  opacity: number
  pulseSpeed: number
  pulseOffset: number
}

const canvasRef = ref<HTMLCanvasElement | null>(null)
let animationFrameId = 0
let resizeObserver: ResizeObserver | null = null

function createParticles(width: number, height: number): Particle[] {
  const count = Math.min(Math.floor((width * height) / 15000), 120)
  const particles: Particle[] = []
  for (let i = 0; i < count; i++) {
    particles.push({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      size: Math.random() * 1.5 + 0.5,
      opacity: Math.random() * 0.5 + 0.2,
      pulseSpeed: Math.random() * 0.02 + 0.01,
      pulseOffset: Math.random() * Math.PI * 2,
    })
  }
  return particles
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

  const particles = createParticles(width, height)

  // Mouse interaction
  const mouse = { x: -1000, y: -1000, active: false }
  const handleMouseMove = (e: MouseEvent) => {
    const rect = canvas!.getBoundingClientRect()
    mouse.x = e.clientX - rect.left
    mouse.y = e.clientY - rect.top
    mouse.active = true
  }
  const handleMouseLeave = () => {
    mouse.active = false
  }
  canvas.addEventListener('mousemove', handleMouseMove)
  canvas.addEventListener('mouseleave', handleMouseLeave)

  let time = 0

  function draw() {
    time++
    ctx!.clearRect(0, 0, width, height)

    // Draw connections
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const p1 = particles[i]
        const p2 = particles[j]
        const dx = p1.x - p2.x
        const dy = p1.y - p2.y
        const dist = Math.sqrt(dx * dx + dy * dy)

        if (dist < 120) {
          const opacity = (1 - dist / 120) * 0.15 * (p1.opacity + p2.opacity) / 2
          ctx!.beginPath()
          ctx!.moveTo(p1.x, p1.y)
          ctx!.lineTo(p2.x, p2.y)
          ctx!.strokeStyle = `rgba(22, 138, 73, ${opacity})`
          ctx!.lineWidth = 0.5
          ctx!.stroke()
        }
      }
    }

    // Draw particles
    for (const p of particles) {
      // Update position
      p.x += p.vx
      p.y += p.vy

      // Mouse attraction
      if (mouse.active) {
        const dx = mouse.x - p.x
        const dy = mouse.y - p.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < 200) {
          p.x += dx * 0.002
          p.y += dy * 0.002
        }
      }

      // Wrap around
      if (p.x < -10) p.x = width + 10
      if (p.x > width + 10) p.x = -10
      if (p.y < -10) p.y = height + 10
      if (p.y > height + 10) p.y = -10

      // Pulsing opacity
      const pulse = Math.sin(time * p.pulseSpeed + p.pulseOffset) * 0.3 + 0.7
      const currentOpacity = p.opacity * pulse

      // Draw particle
      ctx!.beginPath()
      ctx!.arc(p.x, p.y, p.size, 0, Math.PI * 2)
      ctx!.fillStyle = `rgba(22, 138, 73, ${currentOpacity})`
      ctx!.fill()

      // Glow effect
      ctx!.beginPath()
      ctx!.arc(p.x, p.y, p.size * 3, 0, Math.PI * 2)
      ctx!.fillStyle = `rgba(22, 138, 73, ${currentOpacity * 0.1})`
      ctx!.fill()
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
    canvas.removeEventListener('mousemove', handleMouseMove)
    canvas.removeEventListener('mouseleave', handleMouseLeave)
    resizeObserver?.disconnect()
  })
})
</script>

<template>
  <canvas
    ref="canvasRef"
    class="pointer-events-auto absolute inset-0 h-full w-full"
    style="touch-action: none;"
  />
</template>
