<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { X } from 'lucide-vue-next'
import { useFocusTrap } from '@/shared/composables/useFocusTrap'
import { cn } from '@/shared/lib/utils'

const props = defineProps<{
  open: boolean
  position?: 'left' | 'right'
  title?: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
}>()

const drawerRef = ref<HTMLElement | null>(null)
const { activate, deactivate } = useFocusTrap(drawerRef)

const sizeMap = {
  sm: 'w-[min(320px,calc(100vw-48px))]',
  md: 'w-[min(400px,calc(100vw-48px))]',
  lg: 'w-[min(560px,calc(100vw-48px))]',
  xl: 'w-[min(720px,calc(100vw-48px))]',
}

watch(() => props.open, (val) => {
  if (val) {
    document.body.style.overflow = 'hidden'
    nextTick(() => activate())
  } else {
    document.body.style.overflow = ''
    deactivate()
  }
})

function close() {
  emit('update:open', false)
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}
</script>

<template>
  <Teleport to="body">
    <Transition name="drawer">
      <div v-if="open" class="fixed inset-0 z-50" @keydown="handleKeydown">
        <!-- Backdrop -->
        <div class="absolute inset-0 bg-black/40" @click="close" />
        <!-- Drawer -->
        <div
          ref="drawerRef"
          :data-position="position || 'right'"
          :class="cn(
            'absolute top-0 h-full bg-surface shadow-lg',
            position === 'right' ? 'right-0' : 'left-0',
            sizeMap[size || 'sm'],
          )"
          role="dialog"
          aria-modal="true"
        >
          <div class="flex h-full flex-col">
            <div v-if="title || $slots.header" class="flex items-center justify-between border-b border-border px-5 py-4">
              <h3 v-if="title" class="text-sm font-semibold text-foreground">{{ title }}</h3>
              <slot name="header" />
              <button
                class="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground hover:bg-surface-subtle"
                aria-label="关闭"
                @click="close"
              >
                <X class="h-4 w-4" />
              </button>
            </div>
            <div class="flex-1 overflow-auto p-5">
              <slot />
            </div>
            <div v-if="$slots.footer" class="border-t border-border p-5">
              <slot name="footer" />
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.drawer-enter-active,
.drawer-leave-active {
  transition: opacity var(--motion-slow) ease;
}
.drawer-enter-from,
.drawer-leave-to {
  opacity: 0;
}
.drawer-enter-active .absolute:last-child,
.drawer-leave-active .absolute:last-child {
  transition: transform var(--motion-slow) ease;
}
.drawer-enter-from .absolute:last-child,
.drawer-leave-to .absolute:last-child {
  transform: translateX(100%);
}
.drawer-enter-from .absolute:last-child[data-position="left"],
.drawer-leave-to .absolute:last-child[data-position="left"] {
  transform: translateX(-100%);
}
</style>
