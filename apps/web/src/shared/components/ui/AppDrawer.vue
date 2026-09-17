<script setup lang="ts">
import { computed, ref, toRef, useId } from 'vue'
import { X } from 'lucide-vue-next'
import { useOverlay } from '@/shared/composables/useOverlay'
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
const uid = useId()
const titleId = `drawer-title-${uid}`
const hasTitle = computed(() => !!props.title)

function close() {
  emit('update:open', false)
}

useOverlay(drawerRef, toRef(props, 'open'), {})

const sizeMap = {
  sm: 'w-[min(320px,calc(100vw-48px))]',
  md: 'w-[min(400px,calc(100vw-48px))]',
  lg: 'w-[min(560px,calc(100vw-48px))]',
  xl: 'w-[min(720px,calc(100vw-48px))]',
}
</script>

<template>
  <Teleport to="body">
    <Transition name="drawer">
      <div v-if="open" class="fixed inset-0 z-overlay">
        <!-- Scrim -->
        <div class="absolute inset-0 bg-overlay/40" @click="close"/>
        <!-- Drawer -->
        <div
          ref="drawerRef"
          :data-position="position || 'right'"
          :class="cn(
            'absolute top-0 h-full border border-border bg-surface shadow-lg',
            position === 'right'
              ? 'right-0 rounded-l-[var(--radius-panel)]'
              : 'left-0 rounded-r-[var(--radius-panel)]',
            sizeMap[size || 'sm'],
          )"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="hasTitle ? titleId : undefined"
          :aria-label="hasTitle ? undefined : '抽屉面板'"
        >
          <div class="flex h-full flex-col">
            <div v-if="title || $slots.header" class="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 v-if="title" :id="titleId" class="text-subtitle font-normal leading-[1.4] text-foreground">{{ title }}</h2>
              <slot name="header" />
              <button
                type="button"
                class="ml-auto inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition-colors hover:bg-surface-subtle hover:text-foreground"
                aria-label="关闭"
                @click="close"
              >
                <X class="h-4 w-4" aria-hidden="true"/>
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
  transition: opacity var(--motion-base) var(--ease-standard);
}
.drawer-enter-from,
.drawer-leave-to {
  opacity: 0;
}
.drawer-enter-active > :last-child,
.drawer-leave-active > :last-child {
  transition: transform var(--motion-base) var(--ease-standard);
}
.drawer-enter-from > :last-child,
.drawer-leave-to > :last-child {
  transform: translateX(4px);
}
.drawer-enter-from > :last-child[data-position="left"],
.drawer-leave-to > :last-child[data-position="left"] {
  transform: translateX(-4px);
}
</style>