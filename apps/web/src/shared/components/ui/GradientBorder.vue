<script setup lang="ts">
import { computed } from 'vue'

interface Props {
  /** Whether the animated gradient border is visible. */
  active?: boolean
  /** Border width in pixels. */
  borderWidth?: number
  /** Outer corner radius in pixels. */
  radius?: number
  /** Seconds per full rotation. */
  speed?: number
}

const props = withDefaults(defineProps<Props>(), {
  active: false,
  borderWidth: 2,
  radius: 20,
  speed: 3,
})

const style = computed(() => ({
  '--gb-radius': `${props.radius}px`,
  '--gb-width': `${props.borderWidth}px`,
  '--gb-speed': `${props.speed}s`,
}))
</script>

<template>
  <div
    class="gradient-border relative inline-flex"
    :class="{ 'gradient-border--active': active }"
    :style="style"
  >
    <div class="gradient-border__track" aria-hidden="true" />
    <div class="gradient-border__content relative z-10 w-full">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.gradient-border {
  border-radius: var(--gb-radius);
  padding: var(--gb-width);
}

.gradient-border__track {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: conic-gradient(
    from 0deg,
    var(--color-primary),
    var(--color-info),
    var(--color-primary-soft),
    var(--color-primary)
  );
  opacity: 0;
  transition: opacity 0.3s ease;
}

.gradient-border--active .gradient-border__track {
  opacity: 1;
  animation: gradient-spin var(--gb-speed) linear infinite;
}

.gradient-border__content {
  border-radius: calc(var(--gb-radius) - var(--gb-width));
  background: var(--color-surface);
}

@keyframes gradient-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .gradient-border__track {
    animation: none !important;
  }
}
</style>
