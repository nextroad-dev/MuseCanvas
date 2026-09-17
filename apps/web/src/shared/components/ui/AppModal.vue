<script setup lang="ts">
import { computed, ref, toRef, useId } from 'vue'
import { X } from 'lucide-vue-next'
import { useOverlay } from '@/shared/composables/useOverlay'
import { cn } from '@/shared/lib/utils'

const props = defineProps<{
  open: boolean
  title?: string
  description?: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
  panelClass?: string
  bodyClass?: string
  scrollBody?: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
}>()

const modalRef = ref<HTMLElement | null>(null)
const uid = useId()
const titleId = `dialog-title-${uid}`
const descriptionId = `dialog-desc-${uid}`

const hasTitle = computed(() => !!props.title)

function close() {
  emit('update:open', false)
}

// aria-modal + focus trap + scroll lock + `inert` on the app root, and focus is
// returned to the trigger when the dialog closes (see useOverlay).
useOverlay(modalRef, toRef(props, 'open'), {})

const sizeMap = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-5xl',
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="open" class="fixed inset-0 z-overlay flex items-center justify-center p-4">
        <!-- Scrim -->
        <div class="absolute inset-0 bg-overlay/40" @click="close"/>

        <!-- Dialog -->
        <div
          ref="modalRef"
          :class="cn(
            'relative z-10 flex max-h-[85vh] w-full flex-col rounded-[var(--radius-panel)] border border-border bg-surface shadow-lg',
            sizeMap[size || 'md'],
            panelClass,
          )"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="hasTitle ? titleId : undefined"
          :aria-label="hasTitle ? undefined : '对话框'"
          :aria-describedby="description ? descriptionId : undefined"
        >
          <div class="flex items-start justify-between gap-4 border-b border-border p-5">
            <div class="min-w-0 flex-1">
              <h2 v-if="title" :id="titleId" class="text-subtitle font-normal leading-[1.4] text-foreground">{{ title }}</h2>
              <p v-if="description" :id="descriptionId" class="mt-1 text-sm text-muted-foreground">{{ description }}</p>
            </div>
            <button
              type="button"
              class="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition-colors hover:bg-surface-subtle hover:text-foreground"
              aria-label="关闭"
              @click="close"
            >
              <X class="h-4 w-4" aria-hidden="true"/>
            </button>
          </div>
          <div :class="cn('flex-1 p-5', scrollBody === false ? 'overflow-visible' : 'overflow-y-auto', bodyClass)">
            <slot />
          </div>
          <div v-if="$slots.footer" class="flex shrink-0 justify-end gap-2 border-t border-border p-5">
            <slot name="footer" :close="close" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* Opacity plus a 4px shift — no scale, no bounce. */
.modal-enter-active,
.modal-leave-active {
  transition: opacity var(--motion-base) var(--ease-standard);
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-active > :last-child,
.modal-leave-active > :last-child {
  transition: transform var(--motion-base) var(--ease-standard);
}
.modal-enter-from > :last-child,
.modal-leave-to > :last-child {
  transform: translateY(4px);
}
</style>