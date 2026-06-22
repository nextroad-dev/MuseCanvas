<script setup lang="ts">
defineProps<{
  label: string
  value: string | number
  suffix?: string
}>()
</script>

<template>
  <div class="flex flex-col gap-1 border border-neutral-200 bg-neutral-50 px-4 py-3">
    <span class="text-xs font-medium text-neutral-500">{{ label }}</span>
    <span class="text-2xl font-semibold text-neutral-900">
      {{ value }}<span v-if="suffix" class="ml-0.5 text-sm font-normal text-neutral-500">{{ suffix }}</span>
    </span>
  </div>
</template>
