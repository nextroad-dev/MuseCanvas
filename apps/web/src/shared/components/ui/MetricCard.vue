<script setup lang="ts">
defineProps<{
  label: string
  value: string | number
  suffix?: string
}>()
</script>

<template>
  <div class="flex flex-col gap-1">
    <span class="text-xs font-medium text-muted-foreground">{{ label }}</span>
    <span class="text-2xl font-semibold text-foreground">
      {{ value }}<span v-if="suffix" class="ml-0.5 text-sm font-normal text-muted-foreground">{{ suffix }}</span>
    </span>
  </div>
</template>
