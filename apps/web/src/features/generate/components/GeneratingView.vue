<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { XCircle } from 'lucide-vue-next'
import { useGenerationStore } from '@/features/generate/stores/generation'
import { phaseLabel } from '@/shared/lib/job'

const store = useGenerationStore()
const emit = defineEmits<{
  cancel: []
}>()

const currentPhase = computed(() => {
  if (!store.selectedJob) return '准备中...'
  return phaseLabel(store.selectedJob.phase)
})

const promptText = computed(() => {
  if (!store.selectedJob) return ''
  return store.selectedJob.inputPrompt || store.selectedJob.prompt
})

// Water rise animation
const canvasRef = ref<HTMLCanvasElement | null>(null)
let animationFrameId = 0

onMounted(() => {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const canvasElement: HTMLCanvasElement = canvas
  const canvasContext: CanvasRenderingContext2D = ctx

  let width = 0
  let height = 0
  const dpr = window.devicePixelRatio || 1

  function resize() {
    const rect = canvasElement.getBoundingClientRect()
    width = rect.width
    height = rect.height
    canvasElement.width = width * dpr
    canvasElement.height = height * dpr
    canvasContext.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  resize()

  let time = 0
  let waterLevel = 0 // 0 to 1
  const targetWaterLevel = 0.95
  const riseSpeed = 0.0008

  // Wave parameters
  const waves = [
    { amplitude: 15, frequency: 0.01, speed: 0.02, offset: 0 },
    { amplitude: 10, frequency: 0.015, speed: 0.03, offset: Math.PI / 2 },
    { amplitude: 8, frequency: 0.008, speed: 0.025, offset: Math.PI },
  ]

  // Particles rising with water
  interface Particle {
    x: number
    y: number
    size: number
    speed: number
    opacity: number
  }
  const particles: Particle[] = []
  for (let i = 0; i < 30; i++) {
    particles.push({
      x: Math.random() * width,
      y: Math.random() * height,
      size: Math.random() * 2 + 1,
      speed: Math.random() * 0.5 + 0.2,
      opacity: Math.random() * 0.4 + 0.2,
    })
  }

  function draw() {
    time++
    const cx = width / 2
    const cy = height / 2

    // Update water level
    if (waterLevel < targetWaterLevel) {
      waterLevel += riseSpeed
    }

    canvasContext.clearRect(0, 0, width, height)

    const waterHeight = height * waterLevel
    const surfaceY = height - waterHeight

    // Draw water
    canvasContext.save()
    canvasContext.beginPath()
    canvasContext.moveTo(0, height)
    canvasContext.lineTo(0, surfaceY)

    // Draw wave surface
    for (let x = 0; x <= width; x += 2) {
      let y = surfaceY
      for (const wave of waves) {
        y += Math.sin(x * wave.frequency + time * wave.speed + wave.offset) * wave.amplitude
      }
      canvasContext.lineTo(x, y)
    }

    canvasContext.lineTo(width, surfaceY)
    canvasContext.lineTo(width, height)
    canvasContext.closePath()

    // Water fill gradient
    const gradient = canvasContext.createLinearGradient(0, surfaceY, 0, height)
    gradient.addColorStop(0, 'rgba(22, 138, 73, 0.15)')
    gradient.addColorStop(0.3, 'rgba(22, 138, 73, 0.25)')
    gradient.addColorStop(0.7, 'rgba(22, 138, 73, 0.35)')
    gradient.addColorStop(1, 'rgba(22, 138, 73, 0.45)')
    canvasContext.fillStyle = gradient
    canvasContext.fill()

    // Draw surface line
    canvasContext.beginPath()
    for (let x = 0; x <= width; x += 2) {
      let y = surfaceY
      for (const wave of waves) {
        y += Math.sin(x * wave.frequency + time * wave.speed + wave.offset) * wave.amplitude
      }
      if (x === 0) {
        canvasContext.moveTo(x, y)
      } else {
        canvasContext.lineTo(x, y)
      }
    }
    canvasContext.strokeStyle = 'rgba(22, 138, 73, 0.6)'
    canvasContext.lineWidth = 2
    canvasContext.stroke()

    canvasContext.restore()

    // Draw particles rising with water
    for (const p of particles) {
      p.y -= p.speed
      if (p.y < surfaceY) {
        p.y = height + Math.random() * 50
        p.x = Math.random() * width
      }

      // Only draw particles below water surface
      if (p.y > surfaceY + 20) {
        canvasContext.beginPath()
        canvasContext.arc(p.x, p.y, p.size, 0, Math.PI * 2)
        canvasContext.fillStyle = `rgba(22, 138, 73, ${p.opacity * waterLevel})`
        canvasContext.fill()
      }
    }

    // Draw center glow (always visible above water)
    const glowGradient = canvasContext.createRadialGradient(cx, cy, 0, cx, cy, 60)
    glowGradient.addColorStop(0, `rgba(22, 138, 73, ${0.2 + Math.sin(time * 0.03) * 0.1})`)
    glowGradient.addColorStop(1, 'rgba(22, 138, 73, 0)')
    canvasContext.fillStyle = glowGradient
    canvasContext.beginPath()
    canvasContext.arc(cx, cy, 60, 0, Math.PI * 2)
    canvasContext.fill()

    animationFrameId = requestAnimationFrame(draw)
  }

  draw()

  const ro = new ResizeObserver(() => {
    resize()
  })
  ro.observe(canvasElement)

  onUnmounted(() => {
    cancelAnimationFrame(animationFrameId)
    ro.disconnect()
  })
})
</script>

<template>
  <div class="relative flex h-full w-full flex-col items-center justify-center overflow-hidden text-center">
    <!-- Water canvas background -->
    <canvas
      ref="canvasRef"
      class="pointer-events-none absolute inset-0 h-full w-full"
    />

    <!-- Content overlay -->
    <div class="relative z-10 flex flex-col items-center justify-center px-6">
      <!-- Prompt -->
      <p v-if="promptText" class="max-w-2xl text-lg leading-relaxed text-white/90 line-clamp-3">
        "{{ promptText }}"
      </p>

      <!-- Phase -->
      <p class="mt-4 text-sm text-white/60">
        {{ currentPhase }}
      </p>

      <!-- Cancel -->
      <button
        class="mt-10 flex h-9 items-center gap-1.5 rounded-[var(--radius-control)] border border-white/20 bg-white/10 px-4 text-sm text-white transition-colors hover:bg-white/20"
        @click="emit('cancel')"
      >
        <XCircle class="h-4 w-4" />
        取消
      </button>
    </div>
  </div>
</template>
