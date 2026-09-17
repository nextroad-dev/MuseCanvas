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
  <!-- The description lives in the dialog header so it is wired to
       `aria-describedby`; the body only carries the danger affordance. -->
  <AppModal
    :open="open"
    :title="title"
    :description="description"
    :body-class="variant === 'danger' ? undefined : 'py-3'"
    @update:open="emit('update:open', $event)"
  >
    <div v-if="variant === 'danger'" class="flex justify-center">
      <div
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-danger-soft"
      >
        <AlertTriangle class="h-5 w-5 text-danger" aria-hidden="true"/>
      </div>
    </div>

    <template #footer="{ close: closeModal }">
      <BaseButton variant="ghost" @click="closeModal">取消</BaseButton>
      <BaseButton
        :variant="variant === 'danger' ? 'danger' : 'primary'"
        @click="confirm"
      >
        {{ confirmText || '确认' }}
      </BaseButton>
    </template>
  </AppModal>
</template>