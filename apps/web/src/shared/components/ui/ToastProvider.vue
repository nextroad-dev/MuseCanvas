<script setup lang="ts">
import { useToast, toasts } from '@/shared/composables/useToast'
import ToastItem from './ToastItem.vue'

useToast()
</script>

<template>
  <div class="pointer-events-none fixed inset-x-0 top-0 z-[100] flex flex-col items-center gap-2 p-4">
    <TransitionGroup
      enter-active-class="transition-all duration-300 ease-out"
      enter-from-class="opacity-0 -translate-y-2 scale-95"
      enter-to-class="opacity-100 translate-y-0 scale-100"
      leave-active-class="transition-all duration-200 ease-in"
      leave-from-class="opacity-100 translate-y-0 scale-100"
      leave-to-class="opacity-0 -translate-y-2 scale-95"
    >
      <ToastItem
        v-for="t in toasts"
        :key="t.id"
        :type="t.type"
        :message="t.message"
      />
    </TransitionGroup>
  </div>
</template>
