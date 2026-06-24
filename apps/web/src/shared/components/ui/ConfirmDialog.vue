<script setup lang="ts">
import { AlertTriangle } from 'lucide-vue-next'
import AppModal from './AppModal.vue'
import BaseButton from './BaseButton.vue'

defineProps<{
  open: boolean
  title: string
  description: string
  confirmText?: string
  variant?: 'danger' | 'default'
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  confirm: []
}>()

function close() {
  emit('update:open', false)
}

function confirm() {
  emit('confirm')
  close()
}
</script>

<template>
  <AppModal :open="open" :title="title" @update:open="emit('update:open', $event)">
    <div class="flex items-start gap-3">
      <div
        v-if="variant === 'danger'"
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-danger-soft"
      >
        <AlertTriangle class="h-5 w-5 text-danger" />
      </div>
      <div>
        <p class="text-sm text-muted-foreground">{{ description }}</p>
      </div>
    </div>

    <template #footer="{ close: closeModal }">
      <BaseButton variant="ghost" size="sm" @click="closeModal">取消</BaseButton>
      <BaseButton
        :variant="variant === 'danger' ? 'danger' : 'primary'"
        size="sm"
        @click="confirm"
      >
        {{ confirmText || '确认' }}
      </BaseButton>
    </template>
  </AppModal>
</template>
