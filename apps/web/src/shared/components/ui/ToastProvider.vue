<script setup lang="ts">
import { isPersistentToast, removeToast, toasts, useToast } from '@/shared/composables/useToast'
import ToastItem from './ToastItem.vue'

useToast()
</script>

<template>
  <div class="pointer-events-none fixed inset-x-0 top-0 z-toast flex flex-col items-center gap-2 p-4">
    <TransitionGroup
      enter-active-class="transition duration-[var(--motion-base)] ease-standard"
      enter-from-class="opacity-0 -translate-y-1"
      enter-to-class="opacity-100 translate-y-0"
      leave-active-class="transition duration-[var(--motion-fast)] ease-standard"
      leave-from-class="opacity-100 translate-y-0"
      leave-to-class="opacity-0 -translate-y-1"
    >
      <ToastItem
        v-for="t in toasts"
        :key="t.id"
        :type="t.type"
        :message="t.message"
        :dismissible="isPersistentToast(t.type)"
        @close="removeToast(t.id)"
      />
    </TransitionGroup>
  </div>
</template>